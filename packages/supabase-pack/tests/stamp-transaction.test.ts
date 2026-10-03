/**
 * The commit-time stamp runs once per transaction, against live Postgres. The
 * first statement that queues a change in `_change_pending` arms the stamp: a
 * statement-level trigger records the arming in a transaction-local setting and
 * inserts one `_stamp_marker` row for the transaction, whose deferred
 * constraint trigger runs `_stamp_transaction()` at commit. That function
 * numbers every queued change in queue order under the advisory lock, writes
 * the changelog rows and tombstones, and removes the queued rows and every
 * marker it can see, so a transaction writing any number of synced rows holds
 * one pending trigger event.
 *
 * The cases cover the marker's lifetime, queue order, savepoint rollbacks that
 * undo the arming or a later change, a stamp fired early with `set
 * constraints`, a key deleted, recreated, and deleted again in one
 * transaction, a marker a disabled stamp trigger left committed, a 50,000-row
 * commit that stays linear while `_change_pending` is analyzed as empty, and
 * the triggers and function settings the pack wires. The fixture is one bucketed
 * table, dropped with every bookkeeping row it produced. Skips loudly when
 * Postgres is unreachable.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { commitWithin } from './commit-watchdog'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const PROBE = '_stamp_probe'
const OWNER = crypto.randomUUID()
const COMMIT_BUDGET_MS = 20_000

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[stamp-transaction] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TConn = Awaited<ReturnType<SQL['reserve']>>

// MARK: - Fixture

const sessions: Array<{ pool: SQL; conn: TConn }> = []
let nextId = 1

async function provision(): Promise<void> {
  await db!.unsafe(`
    drop table if exists public.${PROBE} cascade;
    create table public.${PROBE} (id bigint primary key, owner_id uuid not null, title text not null);
    create trigger kizunasync_track_change after insert or update on public.${PROBE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${PROBE}
      for each row execute function kizunasync.track_delete();
  `)
  await db!`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, key_columns, min_schema_version, register_clients)
    values (${PROBE}, 'read-write', 'owner_id', '{id}', 1, false)`
}

async function cleanup(): Promise<void> {
  await db!.unsafe(`drop table if exists public.${PROBE} cascade`)

  for (const ledger of ['_changelog', '_tombstones', '_change_pending', '_config']) {
    await db!.unsafe(`delete from kizunasync.${ledger} where table_name = $1`, [PROBE])
  }
}

beforeAll(async () => {
  if (reachable) {
    await cleanup()
    await provision()
  }
})

afterEach(async () => {
  for (const { pool, conn } of sessions.splice(0)) {
    await conn`rollback`.catch(() => undefined)
    conn.release()
    await pool.end()
  }
})

afterAll(async () => {
  if (db !== null) {
    if (reachable) {
      await cleanup()
    }
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

/** Fresh ids, so no case reads another case's rows. */
const ids = (count: number): number[] => Array.from({ length: count }, () => nextId++)

async function insertOn(conn: TConn, id: number): Promise<void> {
  await conn.unsafe(`insert into public.${PROBE} (id, owner_id, title) values ($1, $2, 'probe')`, [id, OWNER])
}

/** The changelog seq of each id, in the order given; null for an id with no entry. */
async function seqsOf(list: number[]): Promise<Array<string | null>> {
  const rows = await db!.unsafe(
    `select pk, max(seq)::text as seq from kizunasync._changelog where table_name = $1 and pk = any($2::text[]) group by pk`,
    [PROBE, `{${list.join(',')}}`],
  )
  const byPk = new Map((rows as { pk: string; seq: string }[]).map((row) => [row.pk, row.seq]))

  return list.map((id) => byPk.get(String(id)) ?? null)
}

async function leftovers(): Promise<{ markers: number; pending: number }> {
  const [row] = await db!`
    select (select count(*) from kizunasync._stamp_marker)::int as markers,
           (select count(*) from kizunasync._change_pending where table_name = ${PROBE})::int as pending`

  return { markers: row.markers as number, pending: row.pending as number }
}

const increasing = (seqs: Array<string | null>): boolean =>
  seqs.every((seq, index) => seq !== null && (index === 0 || BigInt(seq) > BigInt(seqs[index - 1] ?? '0')))

// MARK: - Cases

describe.skipIf(!reachable)('the stamp runs once per transaction', () => {
  test('one transaction holds one marker row however many changes it queues, and none survives the commit', async () => {
    const conn = await connect()
    const [a, b, c, d] = ids(4)

    await conn`begin`
    await insertOn(conn, a!)
    await insertOn(conn, b!)
    await conn.unsafe(`insert into public.${PROBE} (id, owner_id, title) values ($1, $3, 'probe'), ($2, $3, 'probe')`, [c, d, OWNER])
    const [marker] = await conn`
      select count(*)::int as n, bool_and(xid = pg_current_xact_id()) as mine,
             current_setting('kizunasync.stamp_armed', true) = pg_current_xact_id()::text as armed
        from kizunasync._stamp_marker`

    await conn`commit`

    expect(marker).toEqual({ n: 1, mine: true, armed: true })
    expect(increasing(await seqsOf([a!, b!, c!, d!]))).toBe(true)
    expect(await leftovers()).toEqual({ markers: 0, pending: 0 })
  })

  test('changes are numbered in the order they were queued, whatever their keys', async () => {
    const conn = await connect()
    const [low, middle, high] = ids(3)

    await conn`begin`
    await insertOn(conn, high!)
    await insertOn(conn, low!)
    await insertOn(conn, middle!)
    await conn`commit`

    expect(increasing(await seqsOf([high!, low!, middle!]))).toBe(true)
  })

  test('a savepoint rollback that undoes the arming statement lets the next change arm the stamp again', async () => {
    const conn = await connect()
    const [undone, kept] = ids(2)

    await conn`begin`
    await conn`savepoint before_first_change`
    await insertOn(conn, undone!)
    await conn`rollback to savepoint before_first_change`
    const [afterRollback] = await conn`
      select (select count(*) from kizunasync._stamp_marker)::int as markers,
             coalesce(current_setting('kizunasync.stamp_armed', true), '') as armed`

    await insertOn(conn, kept!)
    await conn`commit`

    expect(afterRollback).toEqual({ markers: 0, armed: '' })
    expect(await seqsOf([undone!, kept!])).toEqual([null, expect.any(String)])
    expect(await leftovers()).toEqual({ markers: 0, pending: 0 })
  })

  test('a savepoint rollback after the arming keeps the stamp armed for the changes around it', async () => {
    const conn = await connect()
    const [first, undone, last] = ids(3)

    await conn`begin`
    await insertOn(conn, first!)
    await conn`savepoint middle`
    await insertOn(conn, undone!)
    await conn`rollback to savepoint middle`
    await insertOn(conn, last!)
    await conn`commit`

    const [firstSeq, undoneSeq, lastSeq] = await seqsOf([first!, undone!, last!])

    expect(undoneSeq).toBeNull()
    expect(increasing([firstSeq ?? null, lastSeq ?? null])).toBe(true)
    expect(await leftovers()).toEqual({ markers: 0, pending: 0 })
  })

  test('a stamp fired early with set constraints numbers what is queued, and a later change arms it again', async () => {
    const conn = await connect()
    const [early, late] = ids(2)

    await conn`begin`
    await insertOn(conn, early!)
    await conn`set constraints kizunasync.kizunasync_stamp_transaction immediate`
    const [mid] = await conn`
      select (select count(*) from kizunasync._changelog where table_name = ${PROBE} and pk = ${String(early)})::int as logged,
             (select count(*) from kizunasync._stamp_marker)::int as markers`

    await conn`set constraints kizunasync.kizunasync_stamp_transaction deferred`
    await insertOn(conn, late!)
    await conn`commit`

    expect(mid).toEqual({ logged: 1, markers: 0 })
    expect(increasing(await seqsOf([early!, late!]))).toBe(true)
    expect(await leftovers()).toEqual({ markers: 0, pending: 0 })
  })

  test('a key deleted, recreated, and deleted again in one transaction keeps one tombstone, at its newest seq', async () => {
    const [id] = ids(1)
    const setup = await connect()

    await setup`begin`
    await insertOn(setup, id!)
    await setup`commit`
    const conn = await connect()

    await conn`begin`
    await conn.unsafe(`delete from public.${PROBE} where id = $1`, [id])
    await insertOn(conn, id!)
    await conn.unsafe(`delete from public.${PROBE} where id = $1`, [id])
    await conn`commit`

    const tombstones = await db!`
      select seq::text as seq from kizunasync._tombstones where table_name = ${PROBE} and pk = ${String(id)}`
    const [changes] = await db!`
      select max(seq)::text as newest_upsert from kizunasync._changelog where table_name = ${PROBE} and pk = ${String(id)}`

    expect(tombstones).toHaveLength(1)
    expect(BigInt(tombstones[0]!.seq as string) > BigInt(changes.newest_upsert as string)).toBe(true)
    expect(await leftovers()).toEqual({ markers: 0, pending: 0 })
  })
})

describe.skipIf(!reachable)('the stamp clears what a disabled stamp trigger left behind', () => {
  test('the next stamp numbers a change left queued and deletes the marker left committed with it', async () => {
    const [left, next] = ids(2)

    try {
      await db!.unsafe('alter table kizunasync._stamp_marker disable trigger kizunasync_stamp_transaction')
      await db!.unsafe(`insert into public.${PROBE} (id, owner_id, title) values ($1, $2, 'left behind')`, [left, OWNER])
    } finally {
      await db!.unsafe('alter table kizunasync._stamp_marker enable trigger kizunasync_stamp_transaction')
    }

    expect(await leftovers()).toEqual({ markers: 1, pending: 1 })
    await db!.unsafe(`insert into public.${PROBE} (id, owner_id, title) values ($1, $2, 'probe')`, [next, OWNER])

    expect(await leftovers()).toEqual({ markers: 0, pending: 0 })
    expect(increasing(await seqsOf([left, next]))).toBe(true)
  })
})

describe.skipIf(!reachable)('a large commit stays linear when the queue reads as empty', () => {
  test('a 50,000-row commit completes inside its commit budget after _change_pending is analyzed as empty', async () => {
    const [warmFirst] = ids(1)

    nextId += 1999

    const [first] = ids(1)
    const last = first + 49_999

    nextId = last + 1
    await db!.unsafe(`insert into public.${PROBE} (id, owner_id, title) select g, $2, 'warm' from generate_series($1::bigint, $1::bigint + 1999) g`, [warmFirst, OWNER])
    await db!.unsafe('analyze kizunasync._change_pending')

    const [stats] = await db!`select reltuples::float8 as tuples, relpages::int as pages from pg_class where oid = 'kizunasync._change_pending'::regclass`

    expect(stats.tuples, 'precondition: _change_pending is analyzed as empty').toBe(0)
    expect(stats.pages, 'precondition: _change_pending keeps pages after the stamp emptied it').toBeGreaterThan(0)

    const conn = await connect()

    const [backend] = await conn`select pg_backend_pid() as pid`

    await conn`begin`
    await conn.unsafe(`insert into public.${PROBE} (id, owner_id, title) select g, $2, 'bulk' from generate_series($1::bigint, $1::bigint + 49999) g`, [first, OWNER])
    await commitWithin({ conn, admin: db!, pid: Number(backend.pid), ms: COMMIT_BUDGET_MS })

    const [span] = await db!`
      select count(*)::int as entries, count(distinct seq)::int as distinct_seqs,
             (max(seq) - min(seq) + 1) = count(*) as contiguous
        from kizunasync._changelog
       where table_name = ${PROBE} and pk::bigint between ${first} and ${last}`

    expect(span).toEqual({ entries: 50_000, distinct_seqs: 50_000, contiguous: true })
  }, 60_000)
})

describe.skipIf(!reachable)('the pack wires the stamp once per transaction', () => {
  test('the stamp plans without nested loops, so a queue analyzed as empty cannot make a large commit quadratic', async () => {
    const [stamp] = await db!`select proconfig from pg_proc where oid = 'kizunasync._stamp_transaction()'::regprocedure`

    expect(stamp.proconfig).toEqual(['search_path=""', 'enable_nestloop=off'])
  })

  test('a statement trigger arms the stamp on _change_pending, a deferred constraint trigger runs it on _stamp_marker, and no per-change stamp remains', async () => {
    const triggers = await db!`
      select c.relname::text as table_name, t.tgname::text as trigger_name, p.proname::text as function_name,
             (t.tgtype & 1) = 1 as per_row, t.tgdeferrable as deferrable, t.tginitdeferred as initially_deferred
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_proc p on p.oid = t.tgfoid
       where n.nspname = 'kizunasync' and not t.tgisinternal
       order by 1, 2`
    const [retired] = await db!`select to_regprocedure('kizunasync._stamp_change()') is null as gone`

    expect(triggers).toEqual([
      { table_name: '_change_pending', trigger_name: 'kizunasync_arm_stamp', function_name: '_arm_stamp', per_row: false, deferrable: false, initially_deferred: false },
      { table_name: '_stamp_marker', trigger_name: 'kizunasync_stamp_transaction', function_name: '_stamp_transaction', per_row: true, deferrable: true, initially_deferred: true },
    ])
    expect(retired.gone).toBe(true)
  })
})
