/**
 * kizunasync.attachment_metadata against real Postgres: who may read the integrity
 * metadata of an object they did not upload.
 *
 * The owner reads its own row through RLS. A peer reaches it only through the
 * table the confirm recorded: the caller's own SELECT policy must show it that
 * table's row, keyed by the path's pk segment, carrying the exact object path. A
 * peer who can see nothing gets nothing, a row confirmed without a table gives
 * peers nothing, and a row of another table carrying the same pk and path reveals
 * nothing. Every case runs in a rolled-back transaction. Skips loudly with a named
 * reason when no database is reachable.
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
    `[rpc-attachment-metadata] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

const BUCKET = 'todos'
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })

const become = async (tx: SQL, sub: string): Promise<void> => {
  await tx`reset role`
  await tx`select set_config('request.jwt.claims', ${claims(sub)}, true)`
  await tx`set local role authenticated`
}

interface IMetadata {
  sha256: string | null
  size: string | null
  media_type: string | null
}

async function inRolledBackTxn<T>(body: (tx: SQL) => Promise<T>): Promise<T> {
  let captured: T | undefined

  try {
    await db!.begin(async (tx) => {
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

/** A fresh auth.users row: anonymous by default, registered on request. */
async function newUser(tx: SQL, options: { anonymous: boolean } = { anonymous: true }): Promise<string> {
  const [user] = await tx`
    insert into auth.users (id, is_anonymous) values (gen_random_uuid(), ${options.anonymous})
    returning id`

  return (user as { id: string }).id
}

/** Stores the object as `owner`'s upload and confirms it as `owner`, recording `table` when one is named. */
async function confirmObject(tx: SQL, owner: string, path: string, table: string | null): Promise<void> {
  await tx`reset role`
  await tx`insert into storage.objects (bucket_id, name, owner_id) values (${BUCKET}, ${path}, ${owner})`
  await become(tx, owner)

  if (table === null) {
    await tx`select kizunasync.attachment_confirm(${BUCKET}, ${path}, ${SHA}, 4096, 'image/jpeg')`
  } else {
    await tx`select kizunasync.attachment_confirm(${BUCKET}, ${path}, ${SHA}, 4096, 'image/jpeg', ${table})`
  }
  await tx`reset role`
}

/** Confirm an object owned by `owner` for its todo, optionally linking the todo row to it, and return its path. */
async function seedAttachment(tx: SQL, owner: string, options: { linkRow: boolean; recordTable?: boolean }): Promise<string> {
  const [todo] = await tx`
    insert into public.todos (id, user_id, title, done)
    values (gen_random_uuid(), ${owner}::uuid, 'carries an image', false)
    returning id`
  const pk = (todo as { id: string }).id
  const path = `${owner}/${pk}/${crypto.randomUUID()}.jpg`

  await confirmObject(tx, owner, path, options.recordTable === false ? null : 'todos')

  if (options.linkRow) {
    await tx`update public.todos set image_path = ${path} where id = ${pk}::uuid`
  }
  return path
}

/**
 * A strict owner-only synced table, shaped like rpc-authz-rls's `_authz_strict`.
 * The demo's `todos` is a shared board and cannot hide a referencing row from a
 * peer; this table can. Created inside the caller's rolled-back txn (DDL is
 * transactional) so the file keeps leaving the DB untouched.
 */
const STRICT_TABLE = '_attach_strict'

async function provisionStrictTable(tx: SQL): Promise<void> {
  await tx.unsafe(`
    create table public.${STRICT_TABLE} (id uuid primary key, user_id uuid not null, title text, image_path text);
    alter table public.${STRICT_TABLE} enable row level security;
    grant select, insert, update, delete on public.${STRICT_TABLE} to authenticated;
    create policy as_all on public.${STRICT_TABLE} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    create trigger kizunasync_track_change after insert or update on public.${STRICT_TABLE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${STRICT_TABLE}
      for each row execute function kizunasync.track_delete();
  `)
  await tx`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${STRICT_TABLE}, 'read-write', 'user_id', 1, false)`
}

/**
 * Confirm an object owned by `owner` for a STRICT row and point that row at it,
 * so the only synced row carrying the path is one a peer's SELECT policy hides.
 */
async function seedHiddenAttachment(tx: SQL, owner: string): Promise<{ objectPath: string; pk: string }> {
  const pk = crypto.randomUUID()

  await tx.unsafe(
    `insert into public.${STRICT_TABLE} (id, user_id, title) values ($1, $2, $3)`,
    [pk, owner, 'carries an image'],
  )
  const objectPath = `${owner}/${pk}/${crypto.randomUUID()}.jpg`

  await confirmObject(tx, owner, objectPath, STRICT_TABLE)
  await tx.unsafe(`update public.${STRICT_TABLE} set image_path = $1 where id = $2`, [objectPath, pk])

  return { objectPath, pk }
}

/**
 * A second synced table every signed-in user reads and writes, where an
 * attacker can plant a row with a victim's pk and object path.
 */
const CRAFTED_TABLE = '_attach_crafted'

async function provisionCraftedTable(tx: SQL): Promise<void> {
  await tx.unsafe(`
    create table public.${CRAFTED_TABLE} (id uuid primary key, user_id uuid not null, image_path text);
    alter table public.${CRAFTED_TABLE} enable row level security;
    grant select, insert, update, delete on public.${CRAFTED_TABLE} to authenticated;
    create policy as_all on public.${CRAFTED_TABLE} for all to authenticated using (true) with check (true);
  `)
  await tx`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${CRAFTED_TABLE}, 'read-write', null, 1, false)`
}

async function readMetadata(tx: SQL, path: string): Promise<IMetadata | null> {
  const rows = await tx`
    select sha256, size::text as size, media_type
    from kizunasync.attachment_metadata(${BUCKET}, ${path})`
  const [row] = rows as unknown as IMetadata[]

  return row ?? null
}

describe.skipIf(!reachable)('kizunasync.attachment_metadata', () => {
  test('the owner reads the integrity metadata of its own object', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const path = await seedAttachment(tx, owner, { linkRow: true })

      await become(tx, owner)

      return readMetadata(tx, path)
    })

    expect(row?.sha256).toBe(SHA)
    expect(Number(row?.size)).toBe(4096)
    expect(row?.media_type).toBe('image/jpeg')
  })

  test('a peer that can read the referencing row reads the metadata', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx, { anonymous: false })
      const peer = await newUser(tx)
      const path = await seedAttachment(tx, owner, { linkRow: true })

      await become(tx, peer)

      return readMetadata(tx, path)
    })

    expect(row?.sha256).toBe(SHA)
  })

  // On the shared board an anonymous visitor's todo is readable, and so is its image.
  test("a peer reads the metadata of an ANONYMOUS visitor's todo image", async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx)
      const peer = await newUser(tx)
      const path = await seedAttachment(tx, owner, { linkRow: true })

      await become(tx, peer)

      return readMetadata(tx, path)
    })

    expect(row?.sha256).toBe(SHA)
  })

  test('a peer that sees the row but no reference to the object reads nothing', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx, { anonymous: false })
      const peer = await newUser(tx)
      const path = await seedAttachment(tx, owner, { linkRow: false })

      await become(tx, peer)

      return readMetadata(tx, path)
    })

    expect(row).toBeNull()
  })

  // The owner's read is the control: the same path, the same call, one visible row. Only the SELECT policy differs, so the peer's empty result is RLS and not a malformed key or an unconfirmed object.
  test('a peer whose RLS hides the referencing row reads nothing, while its owner reads it', async () => {
    const seen = await inRolledBackTxn(async (tx) => {
      await provisionStrictTable(tx)
      const owner = await newUser(tx)
      const peer = await newUser(tx)
      const { objectPath: path } = await seedHiddenAttachment(tx, owner)

      await become(tx, peer)
      const byPeer = await readMetadata(tx, path)

      await become(tx, owner)
      const byOwner = await readMetadata(tx, path)

      return { byPeer, byOwner: byOwner?.sha256 ?? null }
    })

    expect(seen).toEqual({ byPeer: null, byOwner: SHA })
  })

  test('a row confirmed without a table gives a peer nothing, even when a readable row carries the path', async () => {
    const seen = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx, { anonymous: false })
      const peer = await newUser(tx)
      const path = await seedAttachment(tx, owner, { linkRow: true, recordTable: false })

      await become(tx, peer)
      const byPeer = await readMetadata(tx, path)

      await become(tx, owner)
      const byOwner = await readMetadata(tx, path)

      return { byPeer, byOwner: byOwner?.sha256 ?? null }
    })

    expect(seen).toEqual({ byPeer: null, byOwner: SHA })
  })

  // The attacker cannot read the victim's STRICT row, so the planted row is the only one that carries the path where the attacker can see it.
  test("a row of another table carrying the victim's pk and path reveals no metadata", async () => {
    const seen = await inRolledBackTxn(async (tx) => {
      await provisionStrictTable(tx)
      await provisionCraftedTable(tx)
      const victim = await newUser(tx)
      const attacker = await newUser(tx)
      const { objectPath: path, pk } = await seedHiddenAttachment(tx, victim)

      await become(tx, attacker)
      await tx.unsafe(`insert into public.${CRAFTED_TABLE} (id, user_id, image_path) values ($1, $2, $3)`, [pk, attacker, path])
      const byAttacker = await readMetadata(tx, path)

      await become(tx, victim)
      const byVictim = await readMetadata(tx, path)

      return { byAttacker, byVictim: byVictim?.sha256 ?? null }
    })

    expect(seen).toEqual({ byAttacker: null, byVictim: SHA })
  })

  test('a peer naming another bucket for the same path reads nothing', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const owner = await newUser(tx, { anonymous: false })
      const peer = await newUser(tx)
      const path = await seedAttachment(tx, owner, { linkRow: true })

      await become(tx, peer)
      const rows = await tx`select sha256 from kizunasync.attachment_metadata('another-bucket', ${path})`

      return { rows: rows.length }
    })

    expect(row).toEqual({ rows: 0 })
  })

  test('an object nobody confirmed has no metadata', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const caller = await newUser(tx)

      await become(tx, caller)

      return readMetadata(tx, `${caller}/${crypto.randomUUID()}/absent.jpg`)
    })

    expect(row).toBeNull()
  })

  test('a malformed object key is refused without an error', async () => {
    const row = await inRolledBackTxn(async (tx) => {
      const caller = await newUser(tx)

      await become(tx, caller)

      return readMetadata(tx, 'not-a-key')
    })

    expect(row).toBeNull()
  })
})
