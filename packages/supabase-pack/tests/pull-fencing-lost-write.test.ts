/**
 * Fencing delivers a held write against real Postgres. The corpus runs the TS
 * oracle over sqlite, never this SQL.
 *
 * A change is numbered when its transaction commits, so a transaction held open
 * has no sequence number yet. A pull taken during the hold delivers the other
 * session's committed write at once and returns a cursor below every number the
 * held transaction can still draw; once it commits, a pull from that cursor
 * delivers its write.
 *
 * Drives the REAL kizunasync.pull RPC (the public wrapper: internals like
 * _pull_impl are execute-locked to authenticated) across two concurrent
 * connections. Asserts the later committed write (title='2') is delivered and
 * wins. Each run cleans up its own rows; the DB is left as found. Skips loudly
 * when no DB.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

// Probe connectivity once up front so the skip is a loud, named reason.
let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-fencing] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

interface IRow {
  pk: string
  seq: string
  table: string
  row: { title?: string } & Record<string, unknown>
}
interface IPullResponse {
  cursor: string
  has_more: boolean
  rows: IRow[]
}

/** Bun binds a JS array as a JSON scalar; the Postgres text form `{a,b}` casts cleanly to uuid[]. */
const uuidArray = (ids: string[]): string => `{${ids.join(',')}}`

/**
 * Run the public kizunasync.pull RPC as the owner (RLS-visible) on a reserved
 * connection, for the owner's todos bucket. The claims + role are set `local`
 * inside an explicit txn: a transaction-local GUC set in autocommit is reverted
 * at the end of its own statement, so the RPC would run with auth.uid() NULL and
 * see nothing under the owner-scoped fixture RLS.
 */
async function pullImpl(owner: string, cursor: string): Promise<IPullResponse> {
  const w = await new SQL(DB_URL, { max: 1 }).reserve()

  try {
    const claims = JSON.stringify({ sub: owner, role: 'authenticated' })

    await w`begin`
    await w`select set_config('request.jwt.claims', ${claims}, true)`
    await w`set local role authenticated`
    const buckets = [{ table: 'todos', params: { user_id: owner } }]
    const [r] = await w`select kizunasync.pull(${buckets}::jsonb, ${cursor}, 1, 500) as resp`

    await w`commit`

    return r.resp as IPullResponse
  } finally {
    await w.release()
  }
}

describe.skipIf(!reachable)('pull fencing delivers a write held open across a pull', () => {
  test('a pull during the hold delivers the other commit, and the held write arrives from the cursor it returned', async () => {
    const conn = db!
    // Setup: an owner with a todo titled '0', the point client R has already synced to.
    const [owner] = await conn`
      insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
    const ownerId = owner.id as string
    const pks: string[] = []

    try {
      const [todo] = await conn`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${ownerId}, '0', false) returning id`
      const todoId = todo.id as string

      pks.push(todoId)
      const [ins] = await conn`
        select seq from kizunasync._changelog where pk = ${todoId}::uuid order by seq desc limit 1`
      const baseCursor = String(ins.seq)

      // A second todo whose committed edit lands while L is held open.
      const [other] = await conn`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${ownerId}, 'x', false) returning id`
      const otherId = other.id as string

      pks.push(otherId)

      // L (the later, winning write) edits title='2' inside a HELD transaction: it has no sequence number until it commits.
      const writer = await new SQL(DB_URL, { max: 1 }).reserve()
      let otherSeq: bigint
      let pull1: IPullResponse

      try {
        await writer`begin`
        await writer`update public.todos set title = '2' where id = ${todoId}::uuid`

        // A concurrent COMMITTED write (autocommit) while L is in-flight.
        await conn`update public.todos set title = 'edited' where id = ${otherId}::uuid`
        const [rRow] = await conn`
          select seq from kizunasync._changelog where pk = ${otherId}::uuid order by seq desc limit 1`

        otherSeq = BigInt(rRow.seq)

        // PULL #1 while L is in-flight: captures the cursor the client persists.
        pull1 = await pullImpl(ownerId, baseCursor)
      } finally {
        // L commits here: only now does it draw its number and become visible.
        await writer`commit`
        await writer.release()
      }

      // The other session's commit is delivered at once; L does not hold it back.
      expect(pull1.rows.find((r) => r.pk === otherId)?.row.title).toBe('edited')
      expect(pull1.rows.find((r) => r.pk === todoId)).toBeUndefined()
      expect(BigInt(pull1.cursor)).toBeGreaterThanOrEqual(otherSeq)

      // L's number is drawn at its commit, above the cursor pull #1 returned.
      const [lRow] = await conn`
        select seq from kizunasync._changelog where pk = ${todoId}::uuid order by seq desc limit 1`

      expect(BigInt(lRow.seq)).toBeGreaterThan(BigInt(pull1.cursor))

      // PULL #2 with the persisted cursor must deliver L's committed write.
      const pull2 = await pullImpl(ownerId, pull1.cursor)
      const delivered = pull2.rows.find((r) => r.pk === todoId)

      expect(delivered).toBeDefined()
      expect(delivered?.row.title).toBe('2')

      // The system converges to the later committed write, not the stale value.
      const [live] = await conn`select title from public.todos where id = ${todoId}::uuid`

      expect(live?.title).toBe('2')
    } finally {
      // Cleanup: leave the DB as found whatever asserted (no _verdicts: _pull_impl never calls push).
      await conn`delete from public.todos where user_id = ${ownerId}::uuid`
      await conn`delete from kizunasync._changelog where pk = any(${uuidArray(pks)}::uuid[])`
      await conn`delete from kizunasync._tombstones where pk = any(${uuidArray(pks)}::uuid[])`
      await conn`delete from kizunasync._clients where user_id = ${ownerId}::uuid`
      await conn`delete from kizunasync._bucket_grants where user_id = ${ownerId}::uuid`
      await conn`delete from auth.users where id = ${ownerId}::uuid`
    }
  })
})
