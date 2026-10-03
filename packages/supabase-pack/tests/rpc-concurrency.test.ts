/**
 * Concurrent writers against the real SQL. A push locks the row it is about to
 * write before it decides, so a second writer of that row waits for the first
 * one to commit and then decides on the committed row: a precondition is a
 * compare-and-set against every writer (another push, a direct supabase-js or
 * SQL update), an update that waited on a delete answers `DELETE_WINS` to a
 * caller that received the row and `RLS_DENIED` to one that did not, an hlc
 * write compares against the stamps the first writer committed, so `_row_hlc`
 * never regresses, and an hlc insert of a pk another user inserted meanwhile
 * answers `RLS_DENIED` without comparing against that user's stamps.
 *
 * Each race holds the first writer's transaction open on one reserved
 * connection, starts the second writer's push on another without awaiting it,
 * waits until that backend blocks on a lock, and only then commits the first.
 * The fixture tables are strict owner-only tables built once and dropped with
 * every bookkeeping row they left. Skips loudly when no DB is reachable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const ARRIVAL_TABLE = '_concurrency_arrival'
const HLC_TABLE = '_concurrency_hlc'
const FIXTURE_TABLES = [ARRIVAL_TABLE, HLC_TABLE] as const

/** The advisory key the gate trigger waits on, so two batches each hold their first row before either reaches its second. */
const GATE_KEY = 7_314_902_551
const GATE_TITLE = 'gate'

const OLDER_HLC = '2024-01-01T00:00:00.000Z|0|00000000-0000-4000-8000-c20000000001'
const NEWER_HLC = '2024-06-01T00:00:00.000Z|0|00000000-0000-4000-8000-c20000000002'

/** A blocked backend shows up in pg_stat_activity within a few polls; this bounds the wait at four seconds. */
const BLOCK_POLLS = 400
const BLOCK_POLL_MS = 10

const DEADLOCK_SQLSTATE = '40P01'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rpc-concurrency] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TConn = Awaited<ReturnType<SQL['reserve']>>

type TFixtureTable = (typeof FIXTURE_TABLES)[number]

type TColumns = Record<string, unknown>

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
  server_row?: TColumns | null
}

interface IMutation {
  mutation_id: string
  table: TFixtureTable
  pk: string
  op: 'insert' | 'update' | 'delete'
  columns?: TColumns
  precondition?: TColumns
  hlc?: string
}

interface IMutationInput {
  table: TFixtureTable
  pk: string
  columns?: TColumns
  precondition?: TColumns
  hlc?: string
}

type TSettled<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** One race: the first writer's statements run inside its open transaction; the second writer's push must wait for that commit. */
interface IRace {
  owner: string

  /** The second writer's user, the owner when absent. */
  caller?: string

  first: (conn: TConn) => Promise<unknown>
  second: IMutation[]
}

// MARK: - Fixture

const provisionTable = (table: TFixtureTable, conflictMode: 'arrival' | 'hlc'): string => `
  create table public.${table} (
    id uuid primary key,
    user_id uuid not null,
    title text,
    balance integer not null default 0
  );
  alter table public.${table} enable row level security;
  grant select, insert, update, delete on public.${table} to authenticated;
  create policy concurrency_owner on public.${table} for all to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  create trigger kizunasync_track_change after insert or update on public.${table}
    for each row execute function kizunasync.track_change();
  create trigger kizunasync_track_delete after delete on public.${table}
    for each row execute function kizunasync.track_delete();
  insert into kizunasync._config (table_name, sync_mode, bucket_column, conflict_mode, conflict_journal, min_schema_version, register_clients)
  values ('${table}', 'read-write', 'user_id', '${conflictMode}', false, 1, false);
`

/** An update that sets the gate title waits on the gate's advisory key, after its row is already locked. */
const PROVISION_GATE = `
  create function public._concurrency_gate() returns trigger language plpgsql set search_path to '' as $$
  begin
    perform pg_advisory_xact_lock_shared(${GATE_KEY});
    return new;
  end $$;
  grant execute on function public._concurrency_gate() to authenticated;
  create trigger concurrency_gate before update on public.${ARRIVAL_TABLE}
    for each row when (new.title = '${GATE_TITLE}') execute function public._concurrency_gate();
`

const created = { users: new Set<string>(), mutationIds: new Set<string>() }
const sessions: Array<{ pool: SQL; conn: TConn }> = []

/** Bun binds a JS array as a JSON scalar; the Postgres text form `{a,b}` casts cleanly to uuid[]. */
const uuidArray = (ids: Iterable<string>): string => `{${[...ids].join(',')}}`

async function dropFixtures(): Promise<void> {
  const tables = `{${FIXTURE_TABLES.join(',')}}`

  await db!.unsafe(`drop table if exists public.${ARRIVAL_TABLE}, public.${HLC_TABLE} cascade`)
  await db!.unsafe('drop function if exists public._concurrency_gate()')
  await db!`delete from kizunasync._changelog where table_name = any(${tables}::text[])`
  await db!`delete from kizunasync._tombstones where table_name = any(${tables}::text[])`
  await db!`delete from kizunasync._conflict_journal where table_name = any(${tables}::text[])`
  await db!`delete from kizunasync._row_hlc where table_name = any(${tables}::text[])`
  await db!`delete from kizunasync._bucket_grants where table_name = any(${tables}::text[])`
  await db!`delete from kizunasync._config where table_name = any(${tables}::text[])`
  await db!`delete from kizunasync._verdicts where mutation_id = any(${uuidArray(created.mutationIds)}::uuid[])`
  await db!`delete from auth.users where id = any(${uuidArray(created.users)}::uuid[])`
  created.mutationIds.clear()
  created.users.clear()
}

/** Rolls back and closes every session: an open writer would otherwise block the next case and the cleanup. */
async function closeSessions(): Promise<void> {
  for (const { pool, conn } of sessions.splice(0)) {
    await conn`rollback`.catch(() => undefined)
    conn.release()
    await pool.end()
  }
}

beforeAll(async () => {
  if (db === null) {
    return
  }
  await dropFixtures()
  await db.unsafe(provisionTable(ARRIVAL_TABLE, 'arrival') + provisionTable(HLC_TABLE, 'hlc') + PROVISION_GATE)
})

afterEach(async () => {
  await closeSessions()
})

afterAll(async () => {
  if (db !== null) {
    await dropFixtures()
    await db.end()
  }
})

// MARK: - Helpers

async function connect(): Promise<TConn> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  sessions.push({ pool, conn })

  return conn
}

async function newUser(): Promise<string> {
  const [row] = await db!`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true) returning id`
  const id = row.id as string

  created.users.add(id)

  return id
}

/** A committed row written by the table owner, the way a peer's earlier change reaches the server. */
async function seedRow(table: TFixtureTable, owner: string, balance = 10): Promise<string> {
  const pk = crypto.randomUUID()

  await db!.unsafe(`insert into public.${table} (id, user_id, title, balance) values ($1, $2, 'seeded', $3)`, [pk, owner, balance])

  return pk
}

async function beginAs(conn: TConn, user: string): Promise<void> {
  await conn`begin`
  await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true)`
  await conn`set local role authenticated`
}

/** Read before the connection runs a statement that may block: a reserved connection answers nothing else while it waits. */
async function pidOf(conn: TConn): Promise<number> {
  const [row] = await conn`select pg_backend_pid() as pid`

  return Number(row.pid)
}

const mutation = (op: IMutation['op'], input: IMutationInput): IMutation => ({ mutation_id: crypto.randomUUID(), op, ...input })

async function push(conn: TConn, mutations: IMutation[]): Promise<IVerdict[]> {
  for (const entry of mutations) {
    created.mutationIds.add(entry.mutation_id)
  }
  const batch = { atomic: false, mutations }
  const [row] = await conn`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`
  const response = row.resp as { verdicts?: IVerdict[] }

  if (response.verdicts === undefined) {
    throw new Error(`rpc-concurrency: expected per-mutation verdicts, got ${JSON.stringify(response)}`)
  }
  return response.verdicts
}

/** A committed pull of the owner's bucket: the row it delivers grants the owner that bucket value, which a committed delete answers DELETE_WINS to. */
async function receiveRows(table: TFixtureTable, owner: string): Promise<void> {
  const conn = await connect()

  await beginAs(conn, owner)
  await conn`select kizunasync.pull(${[{ table, params: { user_id: owner } }]}::jsonb, '0', 1, 500)`
  await conn`commit`
}

const settle = <T>(promise: Promise<T>): Promise<TSettled<T>> =>
  promise.then(
    (value): TSettled<T> => ({ ok: true, value }),
    (error: unknown): TSettled<T> => ({ ok: false, error }),
  )

/** Fails loud when the backend never waits on a lock, so a race that did not happen cannot pass. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < BLOCK_POLLS; attempt++) {
    const [row] = await db!`select wait_event_type from pg_stat_activity where pid = ${pid}`

    if (row?.wait_event_type === 'Lock') {
      return
    }
    await Bun.sleep(BLOCK_POLL_MS)
  }

  throw new Error(`rpc-concurrency: backend ${pid} never blocked on a lock`)
}

/** Runs the first writer in an open transaction, starts the second push behind it, commits the first once the second waits, and returns the second's verdicts after its own commit. */
async function pushBehind(race: IRace): Promise<IVerdict[]> {
  const first = await connect()
  const second = await connect()

  await beginAs(first, race.owner)
  await race.first(first)
  await beginAs(second, race.caller ?? race.owner)
  const pid = await pidOf(second)
  const waiting = settle(push(second, race.second))

  await waitUntilBlocked(pid)
  await first`commit`
  const outcome = await waiting

  if (!outcome.ok) {
    throw outcome.error
  }
  await second`commit`

  return outcome.value
}

async function readRow(table: TFixtureTable, pk: string): Promise<TColumns | null> {
  const [row] = await db!.unsafe(`select to_jsonb(t) as row from public.${table} t where t.id = $1`, [pk])

  return (row?.row as TColumns | undefined) ?? null
}

async function readStamps(table: TFixtureTable, pk: string): Promise<TColumns | null> {
  const [row] = await db!`select column_hlc from kizunasync._row_hlc where table_name = ${table} and pk = ${pk}`

  return (row?.column_hlc as TColumns | undefined) ?? null
}

async function hasTombstone(table: TFixtureTable, pk: string): Promise<boolean> {
  const [row] = await db!`select count(*)::int as n from kizunasync._tombstones where table_name = ${table} and pk = ${pk}`

  return row.n === 1
}

const outcomes = (verdicts: IVerdict[]): Array<[string, string | undefined]> => verdicts.map((verdict) => [verdict.verdict, verdict.reason])

const directUpdate = (table: TFixtureTable, pk: string, balance: number) => (conn: TConn): Promise<unknown> =>
  conn.unsafe(`update public.${table} set balance = $1 where id = $2`, [balance, pk])

const directDelete = (table: TFixtureTable, pk: string) => (conn: TConn): Promise<unknown> =>
  conn.unsafe(`delete from public.${table} where id = $1`, [pk])

const pushFirst = (mutations: IMutation[]) => async (conn: TConn): Promise<unknown> => {
  const verdicts = await push(conn, mutations)

  expect(outcomes(verdicts), 'setup: the first writer applies').toEqual(mutations.map(() => ['applied', undefined]))

  return verdicts
}

// MARK: - Preconditions

describe.skipIf(!reachable)('a precondition is a compare-and-set against every writer', () => {
  test('two pushes spending from one balance: the second waits and answers PRECONDITION with the committed row', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('update', { table: ARRIVAL_TABLE, pk, columns: { balance: 7 }, precondition: { balance: 10 } })]),
      second: [mutation('update', { table: ARRIVAL_TABLE, pk, columns: { balance: 6 }, precondition: { balance: 10 } })],
    })

    expect(verdict?.verdict).toBe('rejected')
    expect(verdict?.reason).toBe('PRECONDITION')
    expect(verdict?.server_row).toMatchObject({ id: pk, balance: 7 })
    expect(await readRow(ARRIVAL_TABLE, pk)).toMatchObject({ balance: 7 })
  }, 30_000)

  test('a push precondition behind a direct update answers PRECONDITION with the committed row', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const [verdict] = await pushBehind({
      owner,
      first: directUpdate(ARRIVAL_TABLE, pk, 7),
      second: [mutation('update', { table: ARRIVAL_TABLE, pk, columns: { balance: 6 }, precondition: { balance: 10 } })],
    })

    expect(verdict?.verdict).toBe('rejected')
    expect(verdict?.reason).toBe('PRECONDITION')
    expect(verdict?.server_row).toMatchObject({ id: pk, balance: 7 })
    expect(await readRow(ARRIVAL_TABLE, pk)).toMatchObject({ balance: 7 })
  }, 30_000)

  // The control for the two cases above: waiting on the row is not a refusal, so a precondition the first writer left true still applies.
  test('a precondition on a column the first writer left alone applies after the wait', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('update', { table: ARRIVAL_TABLE, pk, columns: { title: 'renamed' } })]),
      second: [mutation('update', { table: ARRIVAL_TABLE, pk, columns: { balance: 6 }, precondition: { balance: 10 } })],
    })

    expect(verdict?.verdict).toBe('applied')
    expect(await readRow(ARRIVAL_TABLE, pk)).toMatchObject({ title: 'renamed', balance: 6 })
  }, 30_000)
})

// MARK: - Deletes

describe.skipIf(!reachable)('a delete decides on the row it deletes', () => {
  test('a delete whose precondition a direct update broke while it waited answers PRECONDITION and the row survives', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const [verdict] = await pushBehind({
      owner,
      first: directUpdate(ARRIVAL_TABLE, pk, 7),
      second: [mutation('delete', { table: ARRIVAL_TABLE, pk, precondition: { balance: 10 } })],
    })

    expect(verdict?.verdict).toBe('rejected')
    expect(verdict?.reason).toBe('PRECONDITION')
    expect(verdict?.server_row).toMatchObject({ id: pk, balance: 7 })
    expect(await readRow(ARRIVAL_TABLE, pk)).toMatchObject({ balance: 7 })
    expect(await hasTombstone(ARRIVAL_TABLE, pk)).toBe(false)
  }, 30_000)

  test('a delete whose precondition holds applies and leaves a tombstone', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const conn = await connect()

    await beginAs(conn, owner)
    const verdicts = await push(conn, [mutation('delete', { table: ARRIVAL_TABLE, pk, precondition: { title: 'seeded', balance: 10 } })])

    await conn`commit`
    expect(outcomes(verdicts)).toEqual([['applied', undefined]])
    expect(await readRow(ARRIVAL_TABLE, pk)).toBeNull()
    expect(await hasTombstone(ARRIVAL_TABLE, pk)).toBe(true)
  }, 30_000)

  test('a delete whose precondition does not hold answers PRECONDITION with the row and deletes nothing', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const conn = await connect()

    await beginAs(conn, owner)
    const [verdict] = await push(conn, [mutation('delete', { table: ARRIVAL_TABLE, pk, precondition: { balance: 11 } })])

    await conn`commit`
    expect(verdict?.reason).toBe('PRECONDITION')
    expect(verdict?.server_row).toMatchObject({ id: pk, balance: 10 })
    expect(await readRow(ARRIVAL_TABLE, pk)).toMatchObject({ balance: 10 })
    expect(await hasTombstone(ARRIVAL_TABLE, pk)).toBe(false)
  }, 30_000)

  test('an update behind a pushed delete answers DELETE_WINS with no row', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)

    await receiveRows(ARRIVAL_TABLE, owner)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('delete', { table: ARRIVAL_TABLE, pk })]),
      second: [mutation('update', { table: ARRIVAL_TABLE, pk, columns: { balance: 6 } })],
    })

    expect(verdict?.verdict).toBe('rejected')
    expect(verdict?.reason).toBe('DELETE_WINS')
    expect(verdict?.server_row ?? null).toBeNull()
    expect(await readRow(ARRIVAL_TABLE, pk)).toBeNull()
    expect(await hasTombstone(ARRIVAL_TABLE, pk)).toBe(true)
  }, 30_000)

  test('an update behind a direct delete answers DELETE_WINS with no row', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)

    await receiveRows(ARRIVAL_TABLE, owner)
    const [verdict] = await pushBehind({
      owner,
      first: directDelete(ARRIVAL_TABLE, pk),
      second: [mutation('update', { table: ARRIVAL_TABLE, pk, columns: { balance: 6 } })],
    })

    expect(verdict?.reason).toBe('DELETE_WINS')
    expect(verdict?.server_row ?? null).toBeNull()
    expect(await readRow(ARRIVAL_TABLE, pk)).toBeNull()
  }, 30_000)

  test('a second delete behind a pushed delete answers DELETE_WINS', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)

    await receiveRows(ARRIVAL_TABLE, owner)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('delete', { table: ARRIVAL_TABLE, pk })]),
      second: [mutation('delete', { table: ARRIVAL_TABLE, pk })],
    })

    expect(verdict?.reason).toBe('DELETE_WINS')
    expect(verdict?.server_row ?? null).toBeNull()
  }, 30_000)

  test('a second delete behind a pushed delete answers RLS_DENIED to a caller that never received the row', async () => {
    const owner = await newUser()
    const pk = await seedRow(ARRIVAL_TABLE, owner, 10)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('delete', { table: ARRIVAL_TABLE, pk })]),
      second: [mutation('delete', { table: ARRIVAL_TABLE, pk })],
    })

    expect(verdict?.reason).toBe('RLS_DENIED')
    expect(verdict?.server_row ?? null).toBeNull()
    expect(await hasTombstone(ARRIVAL_TABLE, pk)).toBe(true)
  }, 30_000)
})

// MARK: - HLC races

describe.skipIf(!reachable)('hlc writes of one row serialize and _row_hlc never regresses', () => {
  test('an older update behind a newer one is SUPERSEDED with the committed row', async () => {
    const owner = await newUser()
    const pk = await seedRow(HLC_TABLE, owner)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('update', { table: HLC_TABLE, pk, columns: { title: 'newer' }, hlc: NEWER_HLC })]),
      second: [mutation('update', { table: HLC_TABLE, pk, columns: { title: 'older' }, hlc: OLDER_HLC })],
    })

    expect(verdict?.reason).toBe('SUPERSEDED')
    expect(verdict?.server_row).toMatchObject({ id: pk, title: 'newer' })
    expect(await readRow(HLC_TABLE, pk)).toMatchObject({ title: 'newer' })
    expect(await readStamps(HLC_TABLE, pk)).toEqual({ title: NEWER_HLC })
  }, 30_000)

  test('a newer update behind an older one applies over it', async () => {
    const owner = await newUser()
    const pk = await seedRow(HLC_TABLE, owner)
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('update', { table: HLC_TABLE, pk, columns: { title: 'older' }, hlc: OLDER_HLC })]),
      second: [mutation('update', { table: HLC_TABLE, pk, columns: { title: 'newer' }, hlc: NEWER_HLC })],
    })

    expect(verdict?.verdict).toBe('applied')
    expect(await readRow(HLC_TABLE, pk)).toMatchObject({ title: 'newer' })
    expect(await readStamps(HLC_TABLE, pk)).toEqual({ title: NEWER_HLC })
  }, 30_000)

  test('an older insert of a new pk behind a newer insert of it is SUPERSEDED with the committed row', async () => {
    const owner = await newUser()
    const pk = crypto.randomUUID()
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('insert', { table: HLC_TABLE, pk, columns: { user_id: owner, title: 'newer', balance: 2 }, hlc: NEWER_HLC })]),
      second: [mutation('insert', { table: HLC_TABLE, pk, columns: { user_id: owner, title: 'older', balance: 1 }, hlc: OLDER_HLC })],
    })

    expect(verdict?.reason).toBe('SUPERSEDED')
    expect(verdict?.server_row).toMatchObject({ id: pk, title: 'newer', balance: 2 })
    expect(await readRow(HLC_TABLE, pk)).toMatchObject({ title: 'newer', balance: 2 })
    expect(await readStamps(HLC_TABLE, pk)).toEqual({ user_id: NEWER_HLC, title: NEWER_HLC, balance: NEWER_HLC })
  }, 30_000)

  test('a newer insert of a new pk behind an older insert of it wins every column', async () => {
    const owner = await newUser()
    const pk = crypto.randomUUID()
    const [verdict] = await pushBehind({
      owner,
      first: pushFirst([mutation('insert', { table: HLC_TABLE, pk, columns: { user_id: owner, title: 'older', balance: 1 }, hlc: OLDER_HLC })]),
      second: [mutation('insert', { table: HLC_TABLE, pk, columns: { user_id: owner, title: 'newer', balance: 2 }, hlc: NEWER_HLC })],
    })

    expect(verdict?.verdict).toBe('applied')
    expect(await readRow(HLC_TABLE, pk)).toMatchObject({ title: 'newer', balance: 2 })
    expect(await readStamps(HLC_TABLE, pk)).toEqual({ user_id: NEWER_HLC, title: NEWER_HLC, balance: NEWER_HLC })
  }, 30_000)

  test('an insert of a new pk behind an insert of it by another user answers RLS_DENIED with no row and compares no stamp', async () => {
    const owner = await newUser()
    const intruder = await newUser()
    const pk = crypto.randomUUID()
    const [verdict] = await pushBehind({
      owner,
      caller: intruder,
      first: pushFirst([mutation('insert', { table: HLC_TABLE, pk, columns: { user_id: owner, title: 'owned', balance: 2 }, hlc: NEWER_HLC })]),
      second: [mutation('insert', { table: HLC_TABLE, pk, columns: { user_id: intruder, title: 'intruder', balance: 1 }, hlc: OLDER_HLC })],
    })

    expect(verdict?.verdict).toBe('rejected')
    expect(verdict?.reason).toBe('RLS_DENIED')
    expect(verdict?.server_row ?? null).toBeNull()
    expect(await readRow(HLC_TABLE, pk)).toMatchObject({ user_id: owner, title: 'owned', balance: 2 })
    expect(await readStamps(HLC_TABLE, pk)).toEqual({ user_id: NEWER_HLC, title: NEWER_HLC, balance: NEWER_HLC })
  }, 30_000)

  test('a merge keeps the greater hlc of every column', async () => {
    const pk = crypto.randomUUID()
    const conn = await connect()

    await conn`begin`
    await conn`select set_config('kizunasync.rpc', '1', true)`
    await conn`insert into kizunasync._row_hlc (table_name, pk, column_hlc) values (${HLC_TABLE}, ${pk}::uuid, ${{ title: NEWER_HLC, balance: OLDER_HLC }}::jsonb)`
    await conn`select kizunasync._row_hlc_merge(${HLC_TABLE}, ${pk}, ${{ title: OLDER_HLC, balance: NEWER_HLC, user_id: OLDER_HLC }}::jsonb)`
    const [row] = await conn`select column_hlc from kizunasync._row_hlc where table_name = ${HLC_TABLE} and pk = ${pk}`

    await conn`rollback`
    expect(row.column_hlc).toEqual({ title: NEWER_HLC, balance: NEWER_HLC, user_id: OLDER_HLC })
  }, 30_000)
})

// MARK: - Lock order

describe.skipIf(!reachable)('batches that lock rows in opposite orders', () => {
  test('one of two crossing batches fails with 40P01 and its retry applies', async () => {
    const owner = await newUser()
    const [left, right] = [await seedRow(ARRIVAL_TABLE, owner), await seedRow(ARRIVAL_TABLE, owner)]
    const gate = await connect()
    const leftFirst = await connect()
    const rightFirst = await connect()
    const batches = {
      leftFirst: [mutation('update', { table: ARRIVAL_TABLE, pk: left, columns: { title: GATE_TITLE } }), mutation('update', { table: ARRIVAL_TABLE, pk: right, columns: { title: 'left first' } })],
      rightFirst: [mutation('update', { table: ARRIVAL_TABLE, pk: right, columns: { title: GATE_TITLE } }), mutation('update', { table: ARRIVAL_TABLE, pk: left, columns: { title: 'right first' } })],
    }

    await gate`begin`
    await gate`select pg_advisory_xact_lock(${GATE_KEY})`
    await beginAs(leftFirst, owner)
    await beginAs(rightFirst, owner)
    const [leftPid, rightPid] = [await pidOf(leftFirst), await pidOf(rightFirst)]
    const leftOutcome = settle(push(leftFirst, batches.leftFirst))

    await waitUntilBlocked(leftPid)
    const rightOutcome = settle(push(rightFirst, batches.rightFirst))

    await waitUntilBlocked(rightPid)
    await gate`commit`
    const settled = [
      { conn: leftFirst, batch: batches.leftFirst, outcome: await leftOutcome },
      { conn: rightFirst, batch: batches.rightFirst, outcome: await rightOutcome },
    ]
    const failed = settled.filter((entry) => !entry.outcome.ok)
    const applied = settled.filter((entry) => entry.outcome.ok)

    expect(failed).toHaveLength(1)
    expect(applied).toHaveLength(1)
    const [loser] = failed
    const [winner] = applied
    const error = loser?.outcome.ok === false ? loser.outcome.error : null

    expect(error instanceof Error && 'errno' in error ? error.errno : null).toBe(DEADLOCK_SQLSTATE)
    expect(winner?.outcome.ok === true ? outcomes(winner.outcome.value) : null).toEqual([['applied', undefined], ['applied', undefined]])
    await winner!.conn`commit`
    await loser!.conn`rollback`
    await beginAs(loser!.conn, owner)
    const retried = await push(loser!.conn, loser!.batch)

    await loser!.conn`commit`
    expect(outcomes(retried)).toEqual([['applied', undefined], ['applied', undefined]])
    const titles = Object.fromEntries(loser!.batch.map((entry) => [entry.pk, entry.columns?.title]))

    expect(await readRow(ARRIVAL_TABLE, left)).toMatchObject({ title: titles[left] })
    expect(await readRow(ARRIVAL_TABLE, right)).toMatchObject({ title: titles[right] })
  }, 30_000)
})
