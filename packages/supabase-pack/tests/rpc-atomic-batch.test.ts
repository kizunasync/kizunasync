/**
 * kizunasync.push atomic batch against real Postgres. The
 * corpus pins the all-or-nothing revert in push/005, but only through the TS
 * oracle. The live SQL honors atomic:true. Each case rolls
 * back; the DB is untouched. Skips loudly (named reason) when no DB reachable.
 *
 * On the live RPC:
 *   - an atomic batch with ONE rejected mutation applies NOTHING (the sibling
 *     insert is reverted too), returns the single BATCH_ABORTED outcome naming
 *     the offender, and records NO _verdicts (the aborted batch is re-runnable);
 *   - an all-success atomic batch applies EVERY mutation and returns normal
 *     per-mutation verdicts.
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
    `[rpc-atomic-batch] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

// Rollback sentinel: thrown to abort db.begin() so the txn never commits.
class Rollback extends Error {}

interface IBatchAbort {
  offender_mutation_id: string
  outcome: 'aborted'
  reason: string
  server_row: unknown
}
interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}
type TPushResp = { verdicts: IVerdict[] } | { batch: IBatchAbort }

/**
 * Run `fn` as a fresh authenticated owner inside a rolled-back txn. The owner
 * owns every row it seeds, so RLS lets its own writes through: isolating the
 * atomic-revert behavior from the RLS gate.
 */
async function asOwner<T>(conn: SQL, fn: (tx: SQL, ownerId: string) => Promise<T>): Promise<T> {
  let out: T | undefined

  try {
    await conn.begin(async (tx) => {
      const [actor] = await tx`
        insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
      const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' })

      await tx`select set_config('request.jwt.claims', ${claims}, true)`
      await tx`set local role authenticated`
      out = await fn(tx as unknown as SQL, actor.id)

      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) {
      throw error
    }
  }
  if (out === undefined) {
    throw new Error('asOwner: no result captured')
  }
  return out
}

describe.skipIf(!reachable)('kizunasync.push atomic batch (D-atomic-batch-abort all-or-nothing)', () => {
  // The push/005 shape: an atomic batch inserts a NEW row (e2) then updates an existing row (e1) under a stale precondition, because another device claimed e1. The update is the offender; the WHOLE batch reverts.
  test('one rejected mutation reverts the ENTIRE batch and returns BATCH_ABORTED', async () => {
    const result = await asOwner(db!, async (tx, ownerId) => {
      const e1 = crypto.randomUUID()
      const e2 = crypto.randomUUID()
      const mInsert = crypto.randomUUID()
      const mUpdate = crypto.randomUUID()

      // e1 already has a non-matching title: the precondition mismatches (offender).
      await tx`
        insert into public.todos (id, user_id, title, done)
        values (${e1}, ${ownerId}, 'claimed by device-b', false)`

      const batch = {
        atomic: true,
        mutations: [
          { mutation_id: mInsert, table: 'todos', pk: e2, op: 'insert',
            columns: { done: false, user_id: ownerId, title: 'second task' } },
          { mutation_id: mUpdate, table: 'todos', pk: e1, op: 'update',
            columns: { title: 'claimed by device-a' }, precondition: { title: 'unclaimed' } },
        ],
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
      const resp = row.resp as TPushResp

      // Read bookkeeping as the table owner (out of the authenticated RLS role).
      await tx`reset role`
      const [e2count] = await tx`select count(*)::int n from public.todos where id = ${e2}::uuid`
      const [e1row] = await tx`select title from public.todos where id = ${e1}::uuid`
      const recorded = await tx`
        select mutation_id from kizunasync._verdicts where mutation_id in (${mInsert}::uuid, ${mUpdate}::uuid)`

      return { resp, e2count: e2count.n, e1title: e1row.title, recordedVerdicts: recorded.length, mUpdate }
    })

    // (1) Single batch outcome: NO per-member verdicts.
    expect('batch' in result.resp).toBe(true)
    expect('verdicts' in result.resp).toBe(false)
    const abort = (result.resp as { batch: IBatchAbort }).batch

    expect(abort.outcome).toBe('aborted')
    expect(abort.reason).toBe('PRECONDITION')
    expect(abort.offender_mutation_id).toBe(result.mUpdate)
    // server_row carries the current row (the compensating revert target).
    expect(abort.server_row).not.toBeNull()
    expect((abort.server_row as { title?: string }).title).toBe('claimed by device-b')

    // (2) NOTHING applied: the sibling insert was reverted, e1 untouched.
    expect(result.e2count).toBe(0)
    expect(result.e1title).toBe('claimed by device-b')

    // (3) Re-runnable: no verdicts recorded for an aborted batch.
    expect(result.recordedVerdicts).toBe(0)
  })

  test('an all-success atomic batch applies EVERY mutation with normal verdicts', async () => {
    const result = await asOwner(db!, async (tx, ownerId) => {
      const e1 = crypto.randomUUID()
      const e2 = crypto.randomUUID()
      const mInsert = crypto.randomUUID()
      const mUpdate = crypto.randomUUID()

      // e1 is 'unclaimed': the precondition holds, so the update applies.
      await tx`
        insert into public.todos (id, user_id, title, done)
        values (${e1}, ${ownerId}, 'unclaimed', false)`

      const batch = {
        atomic: true,
        mutations: [
          { mutation_id: mInsert, table: 'todos', pk: e2, op: 'insert',
            columns: { done: false, user_id: ownerId, title: 'second task' } },
          { mutation_id: mUpdate, table: 'todos', pk: e1, op: 'update',
            columns: { title: 'claimed by device-a' }, precondition: { title: 'unclaimed' } },
        ],
      }
      const [row] = await tx`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
      const resp = row.resp as TPushResp

      await tx`reset role`
      const [e2count] = await tx`select count(*)::int n from public.todos where id = ${e2}::uuid`
      const [e1row] = await tx`select title from public.todos where id = ${e1}::uuid`

      return { resp, e2count: e2count.n, e1title: e1row.title }
    })

    // An all-success atomic batch returns per-mutation verdicts and no batch outcome (the I-5 bijection holds).
    expect('verdicts' in result.resp).toBe(true)
    const verdicts = (result.resp as { verdicts: IVerdict[] }).verdicts

    expect(verdicts).toHaveLength(2)
    expect(verdicts.every((v) => v.verdict === 'applied')).toBe(true)

    // Both mutations applied.
    expect(result.e2count).toBe(1)
    expect(result.e1title).toBe('claimed by device-a')
  })
})
