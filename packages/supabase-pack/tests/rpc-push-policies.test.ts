/**
 * kizunasync.push server-side push policies from 0001_kizuna_init.sql against real
 * Postgres. Three FAIL-LOUD guards, declared by the integrator the way RLS is
 * (not protocol, not modeled by the oracle/corpus):
 *
 *   Pull-only sync_mode: a push targeting a kizunasync._config table whose
 *       sync_mode is 'pull-only' is rejected; a 'read-write' table is accepted.
 *   max_batch_size (kizunasync._settings): N+1 mutations rejected, N
 *       accepted, NULL = unlimited; a fresh install seeds 500.
 *   require_atomic (kizunasync._settings): a non-atomic push is
 *       rejected when set, an atomic push is accepted; the default (false)
 *       accepts both.
 *
 * Every case mutates _settings / _config INSIDE a rolled-back txn. The push in
 * the SAME txn sees the restrictive policy; rollback restores the shipped
 * defaults (the concurrent conformance harness must keep seeing
 * max_batch_size = 500, require_atomic = false, todos = read-write).
 * Skips loudly (named reason) when no DB is reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const PACK_SQL = readFileSync(join(import.meta.dir, '../supabase/migrations/0001_kizuna_init.sql'), 'utf8')

/** The pack's own `_settings` seed statement, run as written. */
const SETTINGS_SEED =
  PACK_SQL.match(/insert into kizunasync\._settings \(id, max_batch_size, require_atomic\)[\s\S]*?on conflict \(id\) do nothing;/)?.[0] ?? ''

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-push-policies] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

/**
 * Rollback sentinel: thrown to abort db.begin() so the txn never commits, the
 * per-test _settings / _config edits are reverted, restoring the shipped defaults.
 */
class Rollback extends Error {}

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}
type TPushResp = { verdicts: IVerdict[] }

/**
 * Run `fn` inside a rolled-back txn. `tx` starts as the superuser owner so the
 * body can edit policy tables (_settings / _config) and seed rows; flip to the
 * authenticated owner with `becomeOwner` right before the push so SECURITY
 * INVOKER reads the live (txn-local) policy.
 */
async function inTxn<T>(
  conn: SQL,
  fn: (tx: SQL, ownerId: string, becomeOwner: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let out: T | undefined

  try {
    await conn.begin(async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const becomeOwner = async () => {
        const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

        await tx`select set_config('request.jwt.claims', ${claims}, true)`
        await tx`set local role authenticated`
      }
      out = await fn(tx as unknown as SQL, actor.id, becomeOwner)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('inTxn: no result captured')
  }
  return out
}

/** A single owner-scoped insert mutation for public.todos. */
function insertMutation(ownerId: string, title: string) {
  return {
    mutation_id: crypto.randomUUID(),
    table: 'todos',
    pk: crypto.randomUUID(),
    op: 'insert',
    columns: { done: false, user_id: ownerId, title },
  }
}

describe.skipIf(!reachable)('kizunasync.push server-side policies', () => {
  // MARK: - Pull-only sync_mode

  test('a pull-only table rejects a write; a read-write table accepts it', async () => {
    const out = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      // Flip todos to pull-only inside this rolled-back txn only.
      await tx`update kizunasync._config set sync_mode = 'pull-only' where table_name = 'todos'`
      await becomeOwner()
      const batch = { atomic: false, mutations: [insertMutation(ownerId, 'should be blocked')] }
      let rejected = false
      let message = ''

      try {
        await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1)`
      } catch (e) {
        rejected = true
        message = e instanceof Error ? e.message : String(e)
      }
      return { rejected, message }
    })

    expect(out.rejected).toBe(true)
    expect(out.message).toContain('pull-only')

    // read-write (the shipped default) accepts the same write.
    const ok = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await becomeOwner()
      const batch = { atomic: false, mutations: [insertMutation(ownerId, 'allowed')] }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

      return row.resp as TPushResp
    })

    expect(ok.verdicts).toHaveLength(1)
    expect(ok.verdicts[0]!.verdict).toBe('applied')
  })

  // MARK: - max_batch_size

  test('max_batch_size = N rejects N+1, accepts N; NULL is unlimited', async () => {
    const N = 2

    // N+1 mutations → rejected.
    const over = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await tx`update kizunasync._settings set max_batch_size = ${N} where id`
      await becomeOwner()
      const batch = {
        atomic: false,
        mutations: [
          insertMutation(ownerId, 'a'),
          insertMutation(ownerId, 'b'),
          insertMutation(ownerId, 'c'),
        ],
      }
      let rejected = false
      let message = ''

      try {
        await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1)`
      } catch (e) {
        rejected = true
        message = e instanceof Error ? e.message : String(e)
      }
      return { rejected, message }
    })

    expect(over.rejected).toBe(true)
    expect(over.message).toContain('max_batch_size')

    // Exactly N mutations → accepted.
    const atLimit = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await tx`update kizunasync._settings set max_batch_size = ${N} where id`
      await becomeOwner()
      const batch = {
        atomic: false,
        mutations: [insertMutation(ownerId, 'a'), insertMutation(ownerId, 'b')],
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

      return row.resp as TPushResp
    })

    expect(atLimit.verdicts).toHaveLength(N)
    expect(atLimit.verdicts.every((v) => v.verdict === 'applied')).toBe(true)

    // NULL is unlimited: a big batch passes the guard.
    const unlimited = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await tx`update kizunasync._settings set max_batch_size = null where id`
      await becomeOwner()
      const batch = {
        atomic: false,
        mutations: Array.from({ length: 5 }, (_, i) => insertMutation(ownerId, `t${i}`)),
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

      return row.resp as TPushResp
    })

    expect(unlimited.verdicts).toHaveLength(5)
  })

  test('a fresh install seeds max_batch_size 500, and the seed keeps an existing row', async () => {
    expect(SETTINGS_SEED).toContain('on conflict (id) do nothing')

    const seeded = await inTxn(db!, async (tx) => {
      await tx`delete from kizunasync._settings`
      await tx.unsafe(SETTINGS_SEED)
      const [fresh] = await tx`select max_batch_size from kizunasync._settings`

      await tx`update kizunasync._settings set max_batch_size = 25 where id`
      await tx.unsafe(SETTINGS_SEED)
      const [kept] = await tx`select max_batch_size from kizunasync._settings`

      return {
        fresh: (fresh as { max_batch_size: number | null }).max_batch_size,
        kept: (kept as { max_batch_size: number | null }).max_batch_size,
      }
    })

    expect(seeded).toEqual({ fresh: 500, kept: 25 })
  })

  // MARK: - require_atomic

  test('require_atomic = true rejects atomic:false, accepts atomic:true; default accepts both', async () => {
    // require_atomic = true → a non-atomic push is rejected.
    const nonAtomic = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await tx`update kizunasync._settings set require_atomic = true where id`
      await becomeOwner()
      const batch = { atomic: false, mutations: [insertMutation(ownerId, 'x')] }
      let rejected = false
      let message = ''

      try {
        await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1)`
      } catch (e) {
        rejected = true
        message = e instanceof Error ? e.message : String(e)
      }
      return { rejected, message }
    })

    expect(nonAtomic.rejected).toBe(true)
    expect(nonAtomic.message).toContain('require_atomic')

    const atomic = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await tx`update kizunasync._settings set require_atomic = true where id`
      await becomeOwner()
      const batch = { atomic: true, mutations: [insertMutation(ownerId, 'y')] }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

      return row.resp as TPushResp
    })

    expect(atomic.verdicts).toHaveLength(1)
    expect(atomic.verdicts[0]!.verdict).toBe('applied')

    // Default (false, the shipped value) accepts a non-atomic push.
    const def = await inTxn(db!, async (tx, ownerId, becomeOwner) => {
      await becomeOwner()
      const batch = { atomic: false, mutations: [insertMutation(ownerId, 'z')] }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

      return row.resp as TPushResp
    })

    expect(def.verdicts).toHaveLength(1)
    expect(def.verdicts[0]!.verdict).toBe('applied')
  })
})
