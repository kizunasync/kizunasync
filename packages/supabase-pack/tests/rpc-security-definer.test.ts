/**
 * SECURITY DEFINER ownership guards against the real Postgres. Three DEFINER
 * RPCs granted to `authenticated` bypass the attachments/_clients RLS (the
 * definer owns the tables), so each MUST self-check that the caller only
 * touches its own rows. These tests drive a second authenticated user as the
 * attacker; every case runs in a rolled-back txn so the DB is left as found.
 * Skips loudly when no DB is reachable.
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
    `[rpc-security-definer] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

class Rollback extends Error {}

const claims = (sub: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ sub, role: 'authenticated', ...extra })

/** Run body in a rolled-back txn seeded with two users A (victim) and B (attacker). */
async function withUsers(
  conn: SQL,
  body: (tx: SQL, a: string, b: string) => Promise<void>,
): Promise<void> {
  try {
    await conn.begin(async (tx) => {
      const [a] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const [b] = await tx`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`

      await body(tx as unknown as SQL, a.id as string, b.id as string)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
}

const become = async (tx: SQL, sub: string, extra: Record<string, unknown> = {}): Promise<void> => {
  await tx`reset role`
  await tx`select set_config('request.jwt.claims', ${claims(sub, extra)}, true)`
  await tx`set local role authenticated`
}

describe.skipIf(!reachable)('SECURITY DEFINER RPCs enforce caller ownership', () => {
  const BUCKET = 'attachments'
  const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  // The bucket and an object `ownerId` uploaded at `path`, written as the table owner.
  const storeObject = async (tx: SQL, path: string, ownerId: string): Promise<void> => {
    await tx`reset role`
    await tx`insert into storage.buckets (id, name) values (${BUCKET}, ${BUCKET}) on conflict (id) do nothing`
    await tx`insert into storage.objects (bucket_id, name, owner_id) values (${BUCKET}, ${path}, ${ownerId})`
  }

  // A's object is gone from Storage, so only the ownership predicate stands between B and A's row.
  test('attachment_vacuum does not delete another user\'s attachment', async () => {
    let survived = false

    await withUsers(db!, async (tx, a, b) => {
      const path = `${a}/${crypto.randomUUID()}/u1.jpg`

      await storeObject(tx, path, a)
      await become(tx, a)
      await tx`select kizunasync.attachment_confirm(${BUCKET}, ${path}, ${SHA}, 10, 'image/jpeg')`
      await tx`reset role`
      // Supabase refuses a direct delete from a Storage table unless the transaction allows it.
      await tx`set local storage.allow_delete_query to 'true'`
      await tx`delete from storage.objects where bucket_id = ${BUCKET} and name = ${path}`
      await become(tx, b)
      await tx`select kizunasync.attachment_vacuum(${BUCKET}, ${path})`
      await tx`reset role`
      const [row] = await tx`select count(*)::int as n from kizunasync.attachments where bucket_id = ${BUCKET} and object_path = ${path}`

      survived = (row.n as number) === 1
    })
    expect(survived).toBe(true)
  })

  test('attachment_confirm rejects confirming a path owned by another user', async () => {
    let sqlstate: unknown = null

    await withUsers(db!, async (tx, a, b) => {
      const path = `${a}/${crypto.randomUUID()}/u2.jpg` // owner segment = A, but B is the caller

      await storeObject(tx, path, a)
      await become(tx, b)

      try {
        await tx`select kizunasync.attachment_confirm(${BUCKET}, ${path}, ${SHA}, 20, 'image/png')`
      } catch (error) {
        sqlstate = (error as { errno?: unknown }).errno
      }
    })
    expect(sqlstate).toBe('42501')
  })

  test('_register_client rejects registering a client for another user', async () => {
    let raised = false

    await withUsers(db!, async (tx, a, b) => {
      const sessionB = crypto.randomUUID()

      await become(tx, b, { session_id: sessionB })

      try {
        // B (auth.uid = b) tries to forge a registry row for user A.
        await tx`select kizunasync._register_client(${sessionB}::uuid, ${a}::uuid, 1, '0', null)`
      } catch {
        raised = true
      }
    })
    expect(raised).toBe(true)
  })
})
