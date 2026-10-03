/**
 * Commit-ordered sequence numbers against real Postgres: the SQL the corpus never
 * reaches (it runs the TS oracle over sqlite). A change is numbered when its
 * transaction commits, so no interleaving of open and committing transactions can
 * make a pull skip a change that commits later, and an open transaction never
 * delays the delivery of another one's commit.
 *
 * P1, P2, and S1 are the shapes where a transaction takes its xid before another
 * one opens and then commits while that one is still open. Every write and pull
 * goes through the public surface the way a client reaches it: `kizunasync.push`,
 * `kizunasync.pull`, or a plain authenticated insert, inside an explicit
 * transaction that carries the jwt claims and `set local role authenticated`.
 *
 * Each case closes its sessions and removes every row it created in `afterEach`,
 * so a failing case leaves nothing behind. Skips loudly when no DB is reachable.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

/** Bounds every drain, so a regression fails instead of spinning. */
const MAX_DRAIN_PAGES = 8

/** A blocked backend shows up in pg_stat_activity within a few polls; this bounds the wait at four seconds. */
const BLOCK_POLLS = 400
const BLOCK_POLL_MS = 10

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-fencing-seq-inversion] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TConn = Awaited<ReturnType<SQL['reserve']>>

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}

interface IPulledRow {
  pk: string
  seq: string
  table: string
  row: Record<string, unknown>
}

interface IPulledTombstone {
  pk: string
  seq: string
  table: string
}

interface IPulledConflict {
  pk: string
  column_name: string
  winner_seq: string
}

interface IPullPage {
  cursor: string
  has_more: boolean
  rows: IPulledRow[]
  tombstones: IPulledTombstone[]
  conflicts?: IPulledConflict[]
}

/** Everything a drain delivered, keyed by pk, plus the cursor it stopped at. */
interface IDrained {
  rows: Map<string, IPulledRow>
  tombstones: Map<string, string>
  conflicts: IPulledConflict[]
  cursor: string
}

// MARK: - Sessions and cleanup

const sessions: Array<{ pool: SQL; conn: TConn }> = []
const created = { pks: new Set<string>(), users: new Set<string>(), mutationIds: new Set<string>() }

/** Bun binds a JS array as a JSON scalar; the Postgres text form `{a,b}` casts cleanly to uuid[]. */
const uuidArray = (ids: Iterable<string>): string => `{${[...ids].join(',')}}`

/** One reserved connection on its own pool, closed by `afterEach` whatever the case left open. */
async function connect(): Promise<TConn> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  sessions.push({ pool, conn })

  return conn
}

/** Rolls back and closes every session first: an open writer would otherwise block the cleanup's own writes. */
async function closeSessions(): Promise<void> {
  for (const { pool, conn } of sessions.splice(0)) {
    await conn`rollback`.catch(() => undefined)
    conn.release()
    await pool.end()
  }
}

async function removeCreated(): Promise<void> {
  const conn = db!
  const pks = uuidArray(created.pks)
  const users = uuidArray(created.users)

  await conn`delete from public.todos where id = any(${pks}::uuid[]) or user_id = any(${users}::uuid[])`
  await conn`delete from kizunasync._changelog where pk = any(${pks}::text[])`
  await conn`delete from kizunasync._tombstones where pk = any(${pks}::text[])`
  await conn`delete from kizunasync._conflict_journal where pk = any(${pks}::text[])`
  await conn`delete from kizunasync._verdicts where mutation_id = any(${uuidArray(created.mutationIds)}::uuid[])`
  await conn`delete from kizunasync._clients where user_id = any(${users}::uuid[])`
  await conn`delete from kizunasync._bucket_grants where user_id = any(${users}::uuid[])`
  await conn`delete from public.demo_write_counters where user_id = any(${users}::uuid[])`
  await conn`delete from auth.users where id = any(${users}::uuid[])`
  created.pks.clear()
  created.users.clear()
  created.mutationIds.clear()
}

afterEach(async () => {
  await closeSessions()

  if (db !== null) {
    await removeCreated()
  }
})

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

// MARK: - Helpers

async function newUser(): Promise<string> {
  const [row] = await db!`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
  const id = row.id as string

  created.users.add(id)

  return id
}

const newPk = (): string => {
  const pk = crypto.randomUUID()

  created.pks.add(pk)

  return pk
}

async function beginAs(conn: TConn, user: string): Promise<void> {
  await conn`begin`
  await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true)`
  await conn`set local role authenticated`
}

/** Bookkeeping is unreadable to `authenticated`: read it as the owner on the same connection, where that transaction's own rows are visible. */
async function asOwner<T>(conn: TConn, read: () => Promise<T>): Promise<T> {
  await conn`reset role`

  try {
    return await read()
  } finally {
    await conn`set local role authenticated`
  }
}

async function xidOf(conn: TConn): Promise<string | null> {
  const [row] = await conn`select pg_current_xact_id_if_assigned()::text as xid`

  return (row.xid as string | null) ?? null
}

async function committedTop(): Promise<string> {
  const [row] = await db!`
    select coalesce(max(seq), 0)::text as seq
    from (select seq from kizunasync._changelog union all select seq from kizunasync._tombstones) s`

  return row.seq as string
}

async function changelogSeqOf(pk: string): Promise<string | null> {
  const [row] = await db!`select max(seq)::text as seq from kizunasync._changelog where pk = ${pk}`

  return (row.seq as string | null) ?? null
}

async function tombstoneSeqOf(pk: string): Promise<string | null> {
  const [row] = await db!`select seq::text as seq from kizunasync._tombstones where pk = ${pk}`

  return (row?.seq as string | undefined) ?? null
}

/** `_change_pending` as a new session sees it: a queued row never outlives its transaction. */
async function pendingRowsFromFreshSession(): Promise<number> {
  const fresh = new SQL(DB_URL, { max: 1 })

  try {
    const [row] = await fresh`select count(*)::int as n from kizunasync._change_pending`

    return row.n as number
  } finally {
    await fresh.end()
  }
}

/** A committed todo written by the table owner, the way a peer's earlier change reaches the server. */
async function seedTodo(pk: string, owner: string, title: string): Promise<void> {
  await db!`insert into public.todos (id, user_id, title, done) values (${pk}::uuid, ${owner}::uuid, ${title}, false)`
}

const insertTodo = (pk: string, user: string, title: string): Record<string, unknown> => ({
  mutation_id: crypto.randomUUID(),
  table: 'todos',
  pk,
  op: 'insert',
  columns: { done: false, title, user_id: user },
})

const updateTodo = (pk: string, columns: Record<string, unknown>): Record<string, unknown> => ({
  mutation_id: crypto.randomUUID(),
  table: 'todos',
  pk,
  op: 'update',
  columns,
})

const deleteTodo = (pk: string): Record<string, unknown> => ({
  mutation_id: crypto.randomUUID(),
  table: 'todos',
  pk,
  op: 'delete',
})

async function push(conn: TConn, mutations: Array<Record<string, unknown>>, clientId: string | null = null): Promise<IVerdict[]> {
  for (const mutation of mutations) {
    created.mutationIds.add(mutation.mutation_id as string)
  }
  const batch = { atomic: false, mutations }
  const [row] = await conn`select kizunasync.push(${batch}::jsonb, null::uuid, 1, ${clientId}::uuid) as resp`

  return (row.resp as { verdicts: IVerdict[] }).verdicts
}

/** One pull on a fresh session, in its own transaction, the way a client's request arrives. */
async function pull(user: string, cursor: string): Promise<IPullPage> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  try {
    await beginAs(conn, user)
    const [row] = await conn`select kizunasync.pull(${[{ table: 'todos' }]}::jsonb, ${cursor}, 1, 500) as resp`

    await conn`commit`

    return row.resp as IPullPage
  } finally {
    conn.release()
    await pool.end()
  }
}

async function drain(user: string, cursor: string): Promise<IDrained> {
  const drained: IDrained = { rows: new Map(), tombstones: new Map(), conflicts: [], cursor }

  for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
    const response = await pull(user, drained.cursor)

    for (const row of response.rows) {
      drained.rows.set(row.pk, row)
    }
    for (const tombstone of response.tombstones) {
      drained.tombstones.set(tombstone.pk, tombstone.seq)
    }
    drained.conflicts.push(...(response.conflicts ?? []))
    drained.cursor = response.cursor

    if (!response.has_more) {
      break
    }
  }

  return drained
}

/** The backend's own xid once it waits on a lock; fails loud when it never blocks. */
async function waitUntilBlocked(pid: number): Promise<string | null> {
  for (let attempt = 0; attempt < BLOCK_POLLS; attempt++) {
    const [row] = await db!`select wait_event_type, backend_xid::text as xid from pg_stat_activity where pid = ${pid}`

    if (row?.wait_event_type === 'Lock') {
      return (row.xid as string | null) ?? null
    }
    await Bun.sleep(BLOCK_POLL_MS)
  }

  throw new Error(`backend ${pid} never blocked on a lock`)
}

/**
 * The tail the three inversion shapes share: pull while the open transaction still
 * holds its writes, commit it, then drain from the cursor that pull returned. Rows
 * in `committedFirst` committed before that pull, so the pull itself delivers them.
 * A drain from the base cursor is the control: it proves the rows are committed and
 * visible.
 */
async function expectDeliveredAcrossCommit(input: { puller: string; base: string; pks: string[]; committedFirst?: string[]; commit: () => Promise<void> }): Promise<void> {
  const saved = await pull(input.puller, input.base)
  const deliveredBySaved = saved.rows.map((row) => row.pk)

  await input.commit()
  const after = await drain(input.puller, saved.cursor)
  const control = await drain(input.puller, input.base)

  expect(input.pks.filter((pk) => !control.rows.has(pk)), 'control: a drain from the base cursor sees the committed rows').toEqual([])
  expect((input.committedFirst ?? []).filter((pk) => !deliveredBySaved.includes(pk)), 'the pull that saved the cursor delivers what committed before it').toEqual([])
  expect(input.pks.filter((pk) => !after.rows.has(pk)), `stranded below cursor ${saved.cursor}`).toEqual([])
}

// MARK: - Cases

describe.skipIf(!reachable)('pull delivers every committed change when numbers are drawn at commit', () => {
  test('P1: a transaction that took its xid first and commits first strands none of an open transaction\'s rows', async () => {
    const [userA, userB, puller] = await Promise.all([newUser(), newUser(), newUser()])
    const [a1, a2, b1, b2] = [newPk(), newPk(), newPk(), newPk()]
    const a = await connect()
    const b = await connect()
    const base = await committedTop()

    await beginAs(a, userA)
    await push(a, [insertTodo(a1, userA, 'A first push')])
    const aXid = await xidOf(a)

    await beginAs(b, userB)
    await push(b, [insertTodo(b1, userB, 'B one'), insertTodo(b2, userB, 'B two')])
    const bXid = await xidOf(b)

    await push(a, [insertTodo(a2, userA, 'A second push')])
    await a`commit`

    expect(BigInt(aXid ?? '0') < BigInt(bXid ?? '0'), `setup: A's xid ${aXid} precedes B's ${bXid}`).toBe(true)
    await expectDeliveredAcrossCommit({ puller, base, pks: [b1, b2], commit: async () => { await b`commit` } })
  }, 30_000)

  test('P2: a transaction whose first push only records a rejected verdict strands none of an open transaction\'s rows', async () => {
    const [userA, userB, puller] = await Promise.all([newUser(), newUser(), newUser()])
    const [missing, a2, b1, b2] = [newPk(), newPk(), newPk(), newPk()]
    const clientA = crypto.randomUUID()
    const a = await connect()
    const b = await connect()
    const [config] = await db!`select register_clients from kizunasync._config where table_name = 'todos'`

    expect(config?.register_clients, 'setup: todos registers clients, so the rejected push also writes _clients').toBe(true)
    const base = await committedTop()

    await beginAs(a, userA)
    const [rejected] = await push(a, [updateTodo(missing, { title: 'no such row' })], clientA)
    const aXid = await xidOf(a)

    expect(rejected?.reason, 'setup: the first push is rejected').toBe('RLS_DENIED')
    expect(aXid, 'setup: the rejected push already holds an xid').not.toBeNull()
    await beginAs(b, userB)
    await push(b, [insertTodo(b1, userB, 'B one'), insertTodo(b2, userB, 'B two')])
    const bXid = await xidOf(b)

    await push(a, [insertTodo(a2, userA, 'A second push')], clientA)
    await a`commit`

    expect(BigInt(aXid ?? '0') < BigInt(bXid ?? '0'), `setup: A's xid ${aXid} precedes B's ${bXid}`).toBe(true)
    await expectDeliveredAcrossCommit({ puller, base, pks: [b1, b2], commit: async () => { await b`commit` } })
  }, 30_000)

  test('S1: an insert that waits on a foreign-key lock with its xid assigned strands none of an open writer\'s rows', async () => {
    const [user0, user1, puller] = await Promise.all([newUser(), newUser(), newUser()])
    const [t0, t1] = [newPk(), newPk()]
    const lock = await connect()
    const w0 = await connect()
    const w1 = await connect()
    const base = await committedTop()

    await lock`begin`
    await lock`select id from auth.users where id = ${user0}::uuid for update`
    await beginAs(w0, user0)
    const [backend] = await w0`select pg_backend_pid() as pid`
    const waiting = w0`insert into public.todos (id, user_id, title, done) values (${t0}::uuid, ${user0}::uuid, 'waits on its owner row', false)`.then(
      () => null,
      (error: unknown) => String(error),
    )
    const waiterXid = await waitUntilBlocked(Number(backend.pid))

    expect(waiterXid, 'setup: the waiter holds its xid while it waits').not.toBeNull()
    await beginAs(w1, user1)
    await w1`insert into public.todos (id, user_id, title, done) values (${t1}::uuid, ${user1}::uuid, 'held open', false)`
    const heldXid = await xidOf(w1)

    await lock`rollback`
    expect(await waiting, 'setup: the waiter\'s insert completes').toBeNull()
    await w0`commit`

    expect(BigInt(waiterXid ?? '0') < BigInt(heldXid ?? '0'), `setup: the waiter's xid ${waiterXid} precedes the held writer's ${heldXid}`).toBe(true)
    await expectDeliveredAcrossCommit({ puller, base, pks: [t1], committedFirst: [t0], commit: async () => { await w1`commit` } })
  }, 30_000)

  test('rollback gap: a writer that rolls back before commit hides nothing from the commit after it', async () => {
    const [userR, userC, puller] = await Promise.all([newUser(), newUser(), newUser()])
    const [rolledBack, committed] = [newPk(), newPk()]
    const r = await connect()
    const c = await connect()
    const base = await committedTop()

    await beginAs(r, userR)
    await push(r, [insertTodo(rolledBack, userR, 'rolled back')])
    await r`rollback`
    await beginAs(c, userC)
    await push(c, [insertTodo(committed, userC, 'committed')])
    await c`commit`
    const page = await pull(puller, base)
    const committedSeq = await changelogSeqOf(committed)
    const drained = await drain(puller, base)

    expect(page.rows.map((row) => row.pk)).toContain(committed)
    expect(BigInt(page.cursor) >= BigInt(committedSeq ?? '0'), `cursor ${page.cursor} reaches the committed seq ${committedSeq}`).toBe(true)
    expect(drained.rows.has(rolledBack), 'the rolled-back pk is never delivered').toBe(false)
    expect(await pendingRowsFromFreshSession()).toBe(0)
  }, 30_000)

  test('rollback gap: a change numbered early and rolled back leaves a gap the cursor passes', async () => {
    const [userR, userC, puller] = await Promise.all([newUser(), newUser(), newUser()])
    const [rolledBack, committed] = [newPk(), newPk()]
    const r = await connect()
    const c = await connect()
    const base = await committedTop()

    await beginAs(r, userR)
    await r`set constraints all immediate`
    await push(r, [insertTodo(rolledBack, userR, 'numbered, then rolled back')])
    const [sequence] = await db!`select last_value::text as value from kizunasync._change_seq`
    const gap = sequence.value as string

    expect(BigInt(gap) > BigInt(base), `setup: the early stamp consumed ${gap}, above the base ${base}`).toBe(true)
    await r`rollback`
    await beginAs(c, userC)
    await push(c, [insertTodo(committed, userC, 'committed after the gap')])
    await c`commit`
    const committedSeq = await changelogSeqOf(committed)

    expect(BigInt(committedSeq ?? '0') > BigInt(gap), `the committed seq ${committedSeq} is above the consumed ${gap}`).toBe(true)
    const page = await pull(puller, base)
    const next = await pull(puller, page.cursor)

    expect(page.rows.map((row) => row.pk)).toContain(committed)
    expect(page.rows.map((row) => row.pk)).not.toContain(rolledBack)
    expect(BigInt(page.cursor) > BigInt(gap), `cursor ${page.cursor} passes the gap ${gap}`).toBe(true)
    expect({ cursor: next.cursor, has_more: next.has_more, rows: next.rows.length }, 'a drain from that cursor is stable').toEqual({
      cursor: page.cursor,
      has_more: false,
      rows: 0,
    })
  }, 30_000)

  test('freshness: an open writer does not delay another session\'s committed change', async () => {
    const [userH, userX, puller] = await Promise.all([newUser(), newUser(), newUser()])
    const [heldPk, otherPk] = [newPk(), newPk()]
    const held = await connect()
    const base = await committedTop()

    await beginAs(held, userH)
    await push(held, [insertTodo(heldPk, userH, 'held open')])
    await seedTodo(otherPk, userX, 'autocommit')
    const otherSeq = await changelogSeqOf(otherPk)
    const during = await pull(puller, base)
    const deliveredDuring = during.rows.map((row) => row.pk)

    expect(deliveredDuring, 'the autocommit change is delivered while the writer is open').toContain(otherPk)
    expect(deliveredDuring).not.toContain(heldPk)
    expect(BigInt(during.cursor) >= BigInt(otherSeq ?? '0'), `cursor ${during.cursor} reaches the autocommit seq ${otherSeq}`).toBe(true)
    await held`commit`
    const after = await drain(puller, during.cursor)

    expect(after.rows.has(heldPk), 'the held change is delivered after it commits').toBe(true)
  }, 30_000)

  test('immediate constraints: a writer that numbers its change early keeps every pull below that number until it commits', async () => {
    const [userW, puller] = await Promise.all([newUser(), newUser()])
    const heldPk = newPk()
    const w = await connect()
    const base = await committedTop()

    await beginAs(w, userW)
    await w`set constraints all immediate`
    await push(w, [insertTodo(heldPk, userW, 'numbered early')])
    const heldSeq = await asOwner(w, async () => {
      const [row] = await w`select max(seq)::text as seq from kizunasync._changelog where pk = ${heldPk}`

      return (row.seq as string | null) ?? null
    })

    expect(heldSeq, 'setup: the change is numbered inside the open transaction').not.toBeNull()
    const during = await pull(puller, base)

    expect(during.rows.map((row) => row.pk)).not.toContain(heldPk)
    expect(BigInt(during.cursor) < BigInt(heldSeq ?? '0'), `cursor ${during.cursor} stays below the held seq ${heldSeq}`).toBe(true)
    await w`commit`
    const after = await drain(puller, during.cursor)

    expect(after.rows.get(heldPk)?.seq).toBe(heldSeq ?? undefined)
  }, 30_000)

  test('journal: the conflict a pull attaches carries the seq of the row it delivers', async () => {
    const owner = await newUser()
    const [target, before, after] = [newPk(), newPk(), newPk()]
    const [config] = await db!`select conflict_journal from kizunasync._config where table_name = 'todos'`
    const journalWas = config?.conflict_journal === true

    await seedTodo(target, owner, 'original')
    const w = await connect()

    try {
      await db!`update kizunasync._config set conflict_journal = true where table_name = 'todos'`
      const base = await committedTop()

      await beginAs(w, owner)
      await push(w, [insertTodo(before, owner, 'first statement')])
      const [overwrite] = await push(w, [updateTodo(target, { title: 'overwritten' })])

      await push(w, [insertTodo(after, owner, 'after the overwrite')])
      await w`commit`

      expect(overwrite?.verdict).toBe('applied')
      const drained = await drain(owner, base)
      const delivered = drained.rows.get(target)
      const conflict = drained.conflicts.find((entry) => entry.pk === target && entry.column_name === 'title')

      expect(delivered?.row.title).toBe('overwritten')
      expect(conflict?.winner_seq).toBe(delivered?.seq)
      const [journal] = await db!`
        select
          count(*) filter (where winner_seq is null)::int as unnumbered,
          count(*) filter (where pending_id is not null)::int as pending
        from kizunasync._conflict_journal`

      expect(journal).toEqual({ unnumbered: 0, pending: 0 })
    } finally {
      await w`rollback`.catch(() => undefined)
      await db!`update kizunasync._config set conflict_journal = ${journalWas} where table_name = 'todos'`
    }
  }, 30_000)

  test('tombstone re-delete: deleting a re-created row stamps a new, higher seq that the next pull delivers', async () => {
    const [owner, puller] = await Promise.all([newUser(), newUser()])
    const pk = newPk()
    const beforeSeed = await committedTop()

    await seedTodo(pk, owner, 'first life')
    const base = await committedTop()

    // The puller receives the row first: a pull carries only the tombstones of a table it received a live row of.
    expect((await drain(puller, beforeSeed)).rows.has(pk)).toBe(true)
    await db!`delete from public.todos where id = ${pk}::uuid`
    const first = await tombstoneSeqOf(pk)
    const afterFirst = await drain(puller, base)

    expect(afterFirst.tombstones.get(pk)).toBe(first ?? undefined)
    await seedTodo(pk, owner, 'second life')
    await db!`delete from public.todos where id = ${pk}::uuid`
    const second = await tombstoneSeqOf(pk)

    expect(BigInt(second ?? '0') > BigInt(first ?? '0'), `the second tombstone seq ${second} is above the first ${first}`).toBe(true)
    const afterSecond = await drain(puller, afterFirst.cursor)

    expect(afterSecond.tombstones.get(pk)).toBe(second ?? undefined)
  }, 30_000)

  test('delete wins inside one push: a later write to the row the same push deleted is DELETE_WINS', async () => {
    const owner = await newUser()
    const [x, y] = [newPk(), newPk()]
    const w = await connect()

    await seedTodo(x, owner, 'x')
    await seedTodo(y, owner, 'y')
    await beginAs(w, owner)
    const updateAfterDelete = await push(w, [deleteTodo(x), updateTodo(x, { title: 'after the delete' })])

    await w`commit`
    await beginAs(w, owner)
    const insertAfterDelete = await push(w, [deleteTodo(y), insertTodo(y, owner, 'inserted again')])

    await w`commit`
    const outcomes = (verdicts: IVerdict[]): Array<[string, string | undefined]> => verdicts.map((verdict) => [verdict.verdict, verdict.reason])

    expect(outcomes(updateAfterDelete)).toEqual([['applied', undefined], ['rejected', 'DELETE_WINS']])
    expect(outcomes(insertAfterDelete)).toEqual([['applied', undefined], ['rejected', 'DELETE_WINS']])
    const [left] = await db!`select count(*)::int as n from public.todos where id = any(${uuidArray([x, y])}::uuid[])`
    const tombstones = await db!`select pk::text as pk from kizunasync._tombstones where pk = any(${uuidArray([x, y])}::text[])`

    expect(left.n).toBe(0)
    expect(tombstones.map((row: { pk: string }) => row.pk).sort()).toEqual([x, y].sort())
  }, 30_000)

  test('the pending queue is empty after committed and rolled-back writers', async () => {
    const user = await newUser()
    const [kept, removed, rolledBack] = [newPk(), newPk(), newPk()]
    const c = await connect()
    const r = await connect()

    await seedTodo(removed, user, 'removed by the committed writer')
    await beginAs(c, user)
    await push(c, [insertTodo(kept, user, 'committed'), deleteTodo(removed)])
    await c`commit`
    await beginAs(r, user)
    await push(r, [insertTodo(rolledBack, user, 'rolled back')])
    await r`rollback`

    expect(await pendingRowsFromFreshSession()).toBe(0)
    expect(await changelogSeqOf(kept)).not.toBeNull()
    expect(await tombstoneSeqOf(removed)).not.toBeNull()
  }, 30_000)
})
