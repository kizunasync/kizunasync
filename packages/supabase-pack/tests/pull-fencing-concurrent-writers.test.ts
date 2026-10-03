/**
 * Fencing under N concurrent in-flight writers. Extends pull-fencing-lost-write
 * from one held transaction to many: the contention the commit-ordered numbering
 * has to survive.
 *
 * K writers each hold an UPDATE open (BEGIN + UPDATE, txn not yet committed)
 * while a concurrent autocommit lands a committed write. None of the K holds a
 * sequence number yet: each one draws its number when it commits. A pull while
 * all K are open delivers the autocommit write at once, and once the K writers
 * commit, a drain from the cursor that pull returned delivers every one of their
 * writes: no stranding.
 *
 * Bounded to K=16 held connections with deterministic barriers: all K updates
 * land before the puller snapshot; the puller drains only after all K commit.
 * No timing race. Each run cleans up its own rows and ends every pool it opens.
 * Skips loudly when no DB.
 *
 * Both this file and pull-fencing-lost-write.test.ts drive the REAL
 * kizunasync.pull RPC (the public wrapper: internals like _pull_impl are
 * execute-locked to authenticated). The sqlite corpus oracle never reaches
 * this SQL.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

/**
 * A connection reserved out of a pool (bun's SQL.reserve()). Held open across a
 * writer's in-flight transaction, then committed + released in the finally.
 */
type TReserved = Awaited<ReturnType<SQL['reserve']>>

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

/**
 * Concurrent held-transaction writers. Kept modest: correctness under contention,
 * not a throughput soak. K+2 connections stay far below Postgres max_connections.
 */
const WRITERS = 16
/**
 * Safety cap on drain pages so a regression can never spin forever (limit 500 >
 * WRITERS ⇒ convergence is one page; the cap only bounds a broken build).
 */
const MAX_DRAIN_PAGES = 8

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
    `[pull-fencing-concurrent] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or ` +
      `set SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
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

/**
 * Run the public kizunasync.pull RPC as the owner (RLS-visible) on a reserved
 * connection, for the owner's todos bucket. Ends its own single-conn pool. The
 * claims + role are set `local` inside an explicit txn: a transaction-local GUC
 * set in autocommit is reverted at the end of its own statement, so the RPC would
 * run with auth.uid() NULL and see nothing under the owner-scoped fixture RLS.
 */
async function pullImpl(owner: string, cursor: string): Promise<IPullResponse> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

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
    await pool.end()
  }
}

describe.skipIf(!reachable)('pull fencing strands no write under many concurrent in-flight writers', () => {
  test(`${WRITERS} held writes are all delivered after they commit, and none delays the concurrent commit`, async () => {
    const conn = db!
    const owner = (await conn`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`)[0]
    const ownerId = owner.id as string

    // K todos the client R has already synced (title '0'), plus one whose autocommit edit lands while every writer is in-flight.
    const todoIds: string[] = []
    const otherIds: string[] = []

    try {
      for (let i = 0; i < WRITERS; i++) {
        const [t] = await conn`
          insert into public.todos (id, user_id, title, done)
          values (gen_random_uuid(), ${ownerId}, '0', false) returning id`

        todoIds.push(t.id as string)
      }
      const [other] = await conn`
        insert into public.todos (id, user_id, title, done)
        values (gen_random_uuid(), ${ownerId}, 'x', false) returning id`
      const otherId = other.id as string

      otherIds.push(otherId)

      // Baseline cursor: the client has seen everything up to the last setup change.
      const [base] = await conn`select coalesce(max(seq), 0) as seq from kizunasync._changelog`
      const baseCursor = String(base.seq)

      // Each writer reserves its own connection and holds a txn open after editing its todo to a distinct title, so K writes sit in-flight at once, none of them numbered yet.
      const pools = todoIds.map(() => new SQL(DB_URL, { max: 1 }))
      let writers: TReserved[] = []
      let pull1: IPullResponse | null = null
      let committedSeq = 0n

      try {
        writers = await Promise.all(pools.map((p) => p.reserve()))
        await Promise.all(
          writers.map(async (w, i) => {
            await w`begin`
            await w`update public.todos set title = ${`w${i}`} where id = ${todoIds[i]}::uuid`
          }),
        )

        // A concurrent COMMITTED write while every writer is in-flight.
        await conn`update public.todos set title = 'edited' where id = ${otherId}::uuid`
        const [rRow] = await conn`
          select seq from kizunasync._changelog where pk = ${otherId} order by seq desc limit 1`

        committedSeq = BigInt(rRow.seq)

        // PULL #1 while all K are in-flight: the cursor the client persists.
        pull1 = await pullImpl(ownerId, baseCursor)
      } finally {
        // Commit each HELD writer connection (the ones reserved above: never re-reserve a max:1 pool whose sole connection is still checked out, that deadlocks), then release and end every pool no matter what asserted.
        await Promise.all(writers.map((w) => w`commit`.catch(() => {})))
        await Promise.all(writers.map((w) => w.release()))
        await Promise.all(pools.map((p) => p.end()))
      }

      // The concurrent commit is delivered at once, and no held write appears before it commits.
      expect(pull1!.rows.find((r) => r.pk === otherId)?.row.title).toBe('edited')
      expect(pull1!.rows.filter((r) => todoIds.includes(r.pk))).toEqual([])
      expect(BigInt(pull1!.cursor)).toBeGreaterThanOrEqual(committedSeq)

      // Drain from the persisted cursor to convergence; every committed write must land.
      const delivered = new Map<string, string>()
      let cursor = pull1!.cursor

      for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
        const resp = await pullImpl(ownerId, cursor)

        for (const row of resp.rows) {
          if (typeof row.row.title === 'string') {
            delivered.set(row.pk, row.row.title)
          }
        }
        cursor = resp.cursor
        const allSeen = todoIds.every((id) => delivered.has(id))

        if (allSeen && !resp.has_more) {
          break
        }
      }

      // No write stranded: each of the K todos delivered with its own committed title.
      for (let i = 0; i < todoIds.length; i++) {
        expect(delivered.get(todoIds[i])).toBe(`w${i}`)
      }
      // And the DB itself converged to those values (sanity vs. the delivered snapshot).
      const rows = (await conn`
        select id, title from public.todos where user_id = ${ownerId}::uuid`) as {
        id: string
        title: string
      }[]
      const byId = new Map(rows.map((r) => [r.id, r.title]))

      for (let i = 0; i < todoIds.length; i++) {
        expect(byId.get(todoIds[i])).toBe(`w${i}`)
      }
    } finally {
      // Cleanup: leave the DB as found whatever asserted. changelog/tombstones are keyed by pk (no user_id), so drop those per pk; the rest scope by owner.
      await conn`delete from public.todos where user_id = ${ownerId}::uuid`

      for (const pk of [...todoIds, ...otherIds]) {
        await conn`delete from kizunasync._changelog where pk = ${pk}`
        await conn`delete from kizunasync._tombstones where pk = ${pk}`
      }
      await conn`delete from kizunasync._clients where user_id = ${ownerId}::uuid`
      await conn`delete from kizunasync._bucket_grants where user_id = ${ownerId}::uuid`
      await conn`delete from auth.users where id = ${ownerId}::uuid`
    }
  }, 30_000)
})
