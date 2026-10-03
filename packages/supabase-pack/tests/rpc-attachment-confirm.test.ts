/**
 * kizunasync.attachment_confirm and kizunasync.attachment_vacuum against real
 * Postgres: who may record the integrity metadata of a Storage object, what a
 * recorded row accepts afterwards, and when its metadata may go.
 *
 * Confirm authorizes the uploader: the object must exist in `storage.objects`
 * and be owned by the caller, and the path's owner segment must be the caller.
 * It refuses a malformed hash, a negative or missing size, and a table `_config`
 * does not declare with 22023, and once a row carries a hash a different hash,
 * size, or media type raises 23514 and changes nothing. Vacuum deletes only the
 * caller's own row, and only once the object is gone from Storage. A direct
 * delete from a Storage table raises 42501 unless the transaction sets
 * `storage.allow_delete_query`, as on the Supabase platform, so a case removes
 * an object only under that setting. Every case runs in a rolled-back
 * transaction; each refusal runs in a savepoint so the case can read the row
 * back. Skips loudly with a named reason when no database is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-attachment-confirm] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

const BUCKET = 'kizunasync-confirm-test'
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const OTHER_SHA = 'a'.repeat(64)

/** A table the example fixture configures, and one no `_config` row names. */
const CONFIGURED_TABLE = 'todos'
const UNCONFIGURED_TABLE = '_not_a_synced_table'

/** The SQLSTATE of a refused call, or null when it ran. */
type TOutcome = string | null

interface IConfirm {
  path: string
  sha256?: string | null
  size?: number | null
  mediaType?: string | null
  table?: string
}

interface IAttachmentRow {
  sha256: string | null
  size: string | null
  media_type: string | null
  table_name: string | null
}

const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })

async function inRolledBackTxn<T>(body: (tx: SQL) => Promise<T>): Promise<T> {
  let captured: T | undefined

  try {
    await db!.begin(async (tx) => {
      await tx`insert into storage.buckets (id, name) values (${BUCKET}, ${BUCKET}) on conflict (id) do nothing`
      captured = await body(tx as unknown as SQL)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (captured === undefined) {
    throw new Error('the transaction captured no result')
  }
  return captured
}

const newUser = async (tx: SQL): Promise<string> => {
  const [user] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id::text as id`

  return (user as { id: string }).id
}

/** A Storage object at `path`, owned by `ownerId`; a null owner is an upload made with the service key. */
const storeObject = async (tx: SQL, path: string, ownerId: string | null): Promise<void> => {
  await tx`reset role`
  await tx`insert into storage.objects (bucket_id, name, owner_id) values (${BUCKET}, ${path}, ${ownerId})`
}

/** Deletes the object directly, under the setting Supabase requires for a direct delete from a Storage table. */
const removeObject = async (tx: SQL, path: string): Promise<void> => {
  await tx`reset role`
  await tx`set local storage.allow_delete_query to 'true'`
  await tx`delete from storage.objects where bucket_id = ${BUCKET} and name = ${path}`
}

const objectPath = (ownerId: string): string => `${ownerId}/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`

/** Runs `run` in a savepoint and returns the SQLSTATE it raised, or null. */
async function attempt(tx: SQL, run: (sp: SQL) => Promise<unknown>): Promise<TOutcome> {
  try {
    await tx.savepoint(async (sp) => {
      await run(sp as unknown as SQL)
    })

    return null
  } catch (error) {
    const pg = error as { errno?: unknown }

    return typeof pg.errno === 'string' ? pg.errno : String(pg.errno)
  }
}

/** Runs `run` as `userId` in a savepoint and returns the SQLSTATE it raised, or null. */
async function attemptAs(tx: SQL, userId: string, run: (sp: SQL) => Promise<unknown>): Promise<TOutcome> {
  try {
    return await attempt(tx, async (sp) => {
      await sp`select set_config('request.jwt.claims', ${claims(userId)}, true)`
      await sp`set local role authenticated`
      await run(sp)
    })
  } finally {
    await tx`reset role`
  }
}

/** Calls confirm with the five-argument form, or with `p_table` when the case names a table. */
const confirmAs = (tx: SQL, userId: string, call: IConfirm): Promise<TOutcome> =>
  attemptAs(tx, userId, (sp) => {
    const sha256 = call.sha256 === undefined ? SHA : call.sha256
    const size = call.size === undefined ? 4096 : call.size
    const mediaType = call.mediaType === undefined ? 'image/jpeg' : call.mediaType

    if (call.table === undefined) {
      return sp`select kizunasync.attachment_confirm(${BUCKET}, ${call.path}, ${sha256}, ${size}::bigint, ${mediaType})`
    }
    return sp`select kizunasync.attachment_confirm(${BUCKET}, ${call.path}, ${sha256}, ${size}::bigint, ${mediaType}, ${call.table})`
  })

const vacuumAs = (tx: SQL, userId: string, path: string): Promise<TOutcome> =>
  attemptAs(tx, userId, (sp) => sp`select kizunasync.attachment_vacuum(${BUCKET}, ${path})`)

/** The recorded row, read as the table owner, or null when there is none. */
async function recordedRow(tx: SQL, path: string): Promise<IAttachmentRow | null> {
  await tx`reset role`
  const rows = await tx`
    select to_jsonb(a) - 'id' - 'bucket_id' - 'object_path' - 'created_by' - 'created_at' - 'updated_at' as row
    from kizunasync.attachments a
    where a.bucket_id = ${BUCKET} and a.object_path = ${path}`
  const [first] = rows as unknown as { row: IAttachmentRow & { size: number | null } }[]

  if (first === undefined) {
    return null
  }
  return { ...first.row, size: first.row.size === null ? null : String(first.row.size) }
}

// MARK: - Who may confirm

describe.skipIf(!reachable)('kizunasync.attachment_confirm authorizes the uploader', () => {
  test('the owner of the Storage object confirms it, and the row records the hash in lowercase, the size, the media type, and the table', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      const outcome = await confirmAs(tx, owner, { path, sha256: SHA.toUpperCase(), table: CONFIGURED_TABLE })

      return { outcome, row: await recordedRow(tx, path) }
    })

    expect(result).toEqual({ outcome: null, row: { sha256: SHA, size: '4096', media_type: 'image/jpeg', table_name: CONFIGURED_TABLE } })
  })

  test("a user cannot confirm another user's object, even at a path whose owner segment is theirs", async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const victim = await newUser(tx)
      const attacker = await newUser(tx)
      const path = objectPath(attacker)

      await storeObject(tx, path, victim)
      const outcome = await confirmAs(tx, attacker, { path })

      return { outcome, row: await recordedRow(tx, path) }
    })

    expect(result).toEqual({ outcome: '42501', row: null })
  })

  test('an object missing from Storage cannot be confirmed', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)
      const outcome = await confirmAs(tx, owner, { path })

      return { outcome, row: await recordedRow(tx, path) }
    })

    expect(result).toEqual({ outcome: '42501', row: null })
  })

  test('an object uploaded with the service key has no owner, so no user can confirm it', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)
      const path = objectPath(user)

      await storeObject(tx, path, null)
      const outcome = await confirmAs(tx, user, { path })

      return { outcome, row: await recordedRow(tx, path) }
    })

    expect(result).toEqual({ outcome: '42501', row: null })
  })

  test("an object the caller owns under another user's owner segment is refused", async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const segmentOwner = await newUser(tx)
      const caller = await newUser(tx)
      const path = objectPath(segmentOwner)

      await storeObject(tx, path, caller)
      const outcome = await confirmAs(tx, caller, { path })

      return { outcome, row: await recordedRow(tx, path) }
    })

    expect(result).toEqual({ outcome: '42501', row: null })
  })
})

// MARK: - What confirm accepts

describe.skipIf(!reachable)('kizunasync.attachment_confirm validates its arguments', () => {
  const refusals: [string, Omit<IConfirm, 'path'>][] = [
    ['a hash that is not 64 hex characters', { sha256: 'sha-a' }],
    ['a hash one character short', { sha256: SHA.slice(1) }],
    ['a missing hash', { sha256: null }],
    ['a negative size', { size: -1 }],
    ['a missing size', { size: null }],
    ['a table no _config row declares', { table: UNCONFIGURED_TABLE }],
  ]

  for (const [label, call] of refusals) {
    test(`${label} is refused with 22023 and records nothing`, async () => {
      const result = await inRolledBackTxn(async (tx) => {
        const owner = await newUser(tx)
        const path = objectPath(owner)

        await storeObject(tx, path, owner)
        const outcome = await confirmAs(tx, owner, { path, ...call })

        return { outcome, row: await recordedRow(tx, path) }
      })

      expect(result).toEqual({ outcome: '22023', row: null })
    })
  }

  test('a size of zero is accepted', async () => {
    const outcome = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)

      return { outcome: await confirmAs(tx, owner, { path, size: 0 }) }
    })

    expect(outcome).toEqual({ outcome: null })
  })
})

// MARK: - A confirmed row

describe.skipIf(!reachable)('kizunasync.attachment_confirm keeps a confirmed row as recorded', () => {
  const changes: [string, Omit<IConfirm, 'path'>][] = [
    ['a different hash', { sha256: OTHER_SHA }],
    ['a different size', { size: 1 }],
    ['a different media type', { mediaType: 'image/png' }],
  ]

  for (const [label, call] of changes) {
    test(`re-confirming with ${label} raises 23514 and changes nothing`, async () => {
      const result = await inRolledBackTxn(async (tx) => {
        const owner = await newUser(tx)
        const path = objectPath(owner)

        await storeObject(tx, path, owner)
        const first = await confirmAs(tx, owner, { path })
        const second = await confirmAs(tx, owner, { path, ...call })

        return { first, second, row: await recordedRow(tx, path) }
      })

      expect(result).toEqual({
        first: null,
        second: '23514',
        row: { sha256: SHA, size: '4096', media_type: 'image/jpeg', table_name: null },
      })
    })
  }

  test('re-confirming with the same values succeeds and keeps one row', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      const first = await confirmAs(tx, owner, { path, table: CONFIGURED_TABLE })
      const second = await confirmAs(tx, owner, { path, sha256: SHA.toUpperCase(), table: CONFIGURED_TABLE })
      const [count] = await tx`select count(*)::int as n from kizunasync.attachments where bucket_id = ${BUCKET} and object_path = ${path}`

      return { first, second, rows: count.n as number, row: await recordedRow(tx, path) }
    })

    expect(result).toEqual({
      first: null,
      second: null,
      rows: 1,
      row: { sha256: SHA, size: '4096', media_type: 'image/jpeg', table_name: CONFIGURED_TABLE },
    })
  })

  test('a row recorded without a table takes the table a later confirm names', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      const first = await confirmAs(tx, owner, { path })
      const second = await confirmAs(tx, owner, { path, table: CONFIGURED_TABLE })

      return { first, second, table: (await recordedRow(tx, path))?.table_name ?? null }
    })

    expect(result).toEqual({ first: null, second: null, table: CONFIGURED_TABLE })
  })
})

// MARK: - Storage delete guard

describe.skipIf(!reachable)('Storage tables refuse a direct delete', () => {
  test('a delete from storage.objects or storage.buckets raises 42501 unless the transaction sets storage.allow_delete_query', async () => {
    const result = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      const bucketDelete = await attempt(tx, (sp) => sp`delete from storage.buckets where id = ${BUCKET}`)
      const objectDelete = await attempt(tx, (sp) => sp`delete from storage.objects where bucket_id = ${BUCKET} and name = ${path}`)
      const allowedDelete = await attempt(tx, async (sp) => {
        await sp`set local storage.allow_delete_query to 'true'`
        await sp`delete from storage.objects where bucket_id = ${BUCKET} and name = ${path}`
      })
      const [left] = await tx`select count(*)::int as n from storage.objects where bucket_id = ${BUCKET} and name = ${path}`

      return { bucketDelete, objectDelete, allowedDelete, objectsLeft: left.n as number }
    })

    expect(result).toEqual({ bucketDelete: '42501', objectDelete: '42501', allowedDelete: null, objectsLeft: 0 })
  })
})

// MARK: - Vacuum

describe.skipIf(!reachable)('kizunasync.attachment_vacuum', () => {
  test('keeps the row while the Storage object exists', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      await confirmAs(tx, owner, { path })
      const outcome = await vacuumAs(tx, owner, path)

      return { outcome, sha256: (await recordedRow(tx, path))?.sha256 ?? null }
    })

    expect(row).toEqual({ outcome: null, sha256: SHA })
  })

  test("deletes the caller's row once the Storage object is gone", async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      await confirmAs(tx, owner, { path })
      await removeObject(tx, path)
      const outcome = await vacuumAs(tx, owner, path)

      return { outcome, row: await recordedRow(tx, path) }
    })

    expect(row).toEqual({ outcome: null, row: null })
  })

  test("keeps another user's row, even once its object is gone", async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const other = await newUser(tx)
      const path = objectPath(owner)

      await storeObject(tx, path, owner)
      await confirmAs(tx, owner, { path })
      await removeObject(tx, path)
      const outcome = await vacuumAs(tx, other, path)

      return { outcome, sha256: (await recordedRow(tx, path))?.sha256 ?? null }
    })

    expect(row).toEqual({ outcome: null, sha256: SHA })
  })

  test('a path whose first segment is not a uuid is a no-op, not an error', async () => {
    const outcome = await inRolledBackTxn(async (tx) => {
      const user = await newUser(tx)

      return { outcome: await vacuumAs(tx, user, 'not-a-uuid/segment/file.jpg') }
    })

    expect(outcome).toEqual({ outcome: null })
  })
})
