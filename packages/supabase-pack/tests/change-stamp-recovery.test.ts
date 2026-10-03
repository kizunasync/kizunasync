/**
 * The recovery for changes that committed while the commit-time stamp was
 * down: `kizunasync._change_pending` still queues the writes, but nothing
 * numbers them until the stamp triggers are restored and a later transaction
 * runs the stamp, which numbers every queued row it can see. A trigger merely
 * disabled is re-enabled; a missing one is recreated with the pack's own DDL.
 * The stuck rows are then numbered either by the transaction Troubleshooting
 * shows, which arms the stamp and commits, or by the next ordinary write to a
 * synced table. Either way they keep their queue order, their bucket labels,
 * and the conflict-journal entry that names one of them.
 *
 * The run writes to a synced table of its own, registered the way
 * `pull-fencing-stress.test.ts` registers its own, so its doorbell stays off
 * the `kizunasync:todos` topic. The triggers are restored and the fixture is
 * dropped in `finally`, whatever the test asserts. Skips loudly when no DB is
 * reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const FIXTURE_TABLE = '_change_stamp_recovery'
const ARM_TRIGGER = 'kizunasync_arm_stamp'
const STAMP_TRIGGER = 'kizunasync_stamp_transaction'
const TEST_TIMEOUT_MS = 30_000

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[change-stamp-recovery] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

type TConn = Awaited<ReturnType<SQL['reserve']>>

interface IPullPage {
  cursor: string
  has_more: boolean
  rows: Array<{ pk: string }>
  conflicts?: Array<{ pk: string; winner_seq: string }>
}

interface IStamped {
  seq: string
  pk: string
  bucket_value: string | null
}

/** The exact transaction Troubleshooting shows under "Changes queued without a sequence number": it arms the stamp and commits. */
const RECOVERY_SQL = `begin;
insert into kizunasync._stamp_marker values (pg_current_xact_id()) on conflict (xid) do nothing;
commit;`

/** The same arming statement after a synced write in one transaction, where the write has already armed the stamp. */
const ARM_AFTER_WRITE_SQL = `insert into kizunasync._stamp_marker values (pg_current_xact_id()) on conflict (xid) do nothing`

/**
 * The pack's own DDL for both stamp triggers, which recreates whichever was
 * dropped or hand-recreated with other timing. Safe to run unconditionally:
 * `drop trigger if exists` tolerates an already-missing trigger.
 */
const RESTORE_TRIGGER_SQL = `drop trigger if exists ${ARM_TRIGGER} on kizunasync._change_pending;
create trigger ${ARM_TRIGGER}
  after insert on kizunasync._change_pending
  for each statement execute function kizunasync._arm_stamp();
drop trigger if exists ${STAMP_TRIGGER} on kizunasync._stamp_marker;
create constraint trigger ${STAMP_TRIGGER}
  after insert on kizunasync._stamp_marker
  deferrable initially deferred
  for each row execute function kizunasync._stamp_transaction();`

/**
 * A fixture table with the columns the push path writes, readable by every
 * signed-in session and insertable as yourself, bucketed by its owner so each
 * queued change carries a bucket label, with both capture triggers exactly as
 * `kizunasync init` attaches them. A table a crashed run left behind is
 * dropped first, so its rows never reach this run's counts.
 */
async function provisionFixture(conn: SQL): Promise<void> {
  await conn.unsafe(`
    drop table if exists public.${FIXTURE_TABLE} cascade;
    create table public.${FIXTURE_TABLE} (
      id uuid primary key,
      user_id uuid not null,
      title text not null
    );
    alter table public.${FIXTURE_TABLE} enable row level security;
    grant select, insert, update, delete on public.${FIXTURE_TABLE} to authenticated;
    create policy csr_all on public.${FIXTURE_TABLE} for all to authenticated
      using (true) with check (user_id = (select auth.uid()));
    drop trigger if exists kizunasync_track_change on public."${FIXTURE_TABLE}";
    create trigger kizunasync_track_change
      after insert or update on public."${FIXTURE_TABLE}"
      for each row execute function kizunasync.track_change();
    drop trigger if exists kizunasync_track_delete on public."${FIXTURE_TABLE}";
    create trigger kizunasync_track_delete
      after delete on public."${FIXTURE_TABLE}"
      for each row execute function kizunasync.track_delete();
  `)
  await conn`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${FIXTURE_TABLE}, 'read-write', 'user_id', 1, false)
    on conflict (table_name) do update set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
}

async function dropFixture(conn: SQL): Promise<void> {
  await conn.unsafe(`drop table if exists public.${FIXTURE_TABLE} cascade`)
  await conn`delete from kizunasync._change_pending where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._conflict_journal where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._bucket_grants where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`
}

/** `_change_pending` and `_stamp_marker` as a new session sees them: neither row outlives its transaction once the stamp runs. */
async function leftoversFromFreshSession(): Promise<{ pending: number; markers: number }> {
  const fresh = new SQL(DB_URL, { max: 1 })

  try {
    const [row] = await fresh`
      select (select count(*) from kizunasync._change_pending where table_name = ${FIXTURE_TABLE})::int as pending,
             (select count(*) from kizunasync._stamp_marker)::int as markers`

    return { pending: row.pending as number, markers: row.markers as number }
  } finally {
    await fresh.end()
  }
}

/** The fixture's changelog entries in sequence order, with the bucket label each one carries. */
async function stampedRows(): Promise<IStamped[]> {
  const rows = await db!`
    select seq::text as seq, pk, bucket_value from kizunasync._changelog
     where table_name = ${FIXTURE_TABLE} order by seq`

  return rows.map((row: IStamped) => ({ seq: row.seq, pk: row.pk, bucket_value: row.bucket_value }))
}

/** One pull of the owner's bucket on the given connection, in its own transaction, the way a client's request arrives. */
async function pullOn(conn: TConn, user: string, cursor: string): Promise<IPullPage> {
  await conn`begin`
  await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true)`
  await conn`set local role authenticated`
  const [row] = await conn`select kizunasync.pull(${[{ table: FIXTURE_TABLE, params: { user_id: user } }]}::jsonb, ${cursor}, 1, 500) as resp`

  await conn`commit`

  return row.resp as IPullPage
}

/**
 * Commits the first row together with a conflict-journal entry that names its
 * queued change, the way a push that overwrote a column records one, then
 * commits the second row on its own.
 */
async function writeWhileBroken(admin: TConn, input: { owner: string; first: string; second: string }): Promise<void> {
  await admin`begin`
  await admin.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1, $2, 'first while the stamp is down')`, [input.first, input.owner])
  await admin.unsafe(
    `insert into kizunasync._conflict_journal (table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode, pending_id)
     select table_name, pk, 'title', '"before"'::jsonb, gen_random_uuid(), 'arrival', id
       from kizunasync._change_pending where pk = $1`,
    [input.first],
  )
  await admin`commit`
  await admin.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1, $2, 'second while the stamp is down')`, [input.second, input.owner])
}

interface IRecoveryCase {
  breakSql: string
  fixSql: string

  /** What numbers the stuck rows once the triggers are back: the Troubleshooting transaction, or an ordinary write. */
  recover: (admin: TConn, owner: string) => Promise<string[]>
}

/**
 * The shape every case shares: save a cursor, break a trigger, commit two
 * rows and a journal entry, confirm they sit queued without a number, fix the
 * trigger, recover, then confirm the rows are numbered in the order they were
 * written, keep their bucket labels and the journal link, and reach a pull.
 */
async function expectRecoveryDelivers(admin: TConn, recovery: IRecoveryCase): Promise<void> {
  const owner = crypto.randomUUID()
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const saved = await pullOn(admin, owner, '0')

  await admin.unsafe(recovery.breakSql)
  await writeWhileBroken(admin, { owner, first, second })

  const queued = await admin`select pk, bucket_value from kizunasync._change_pending where table_name = ${FIXTURE_TABLE} order by id`

  expect(queued.map((row: { pk: string; bucket_value: string }) => ({ ...row })), 'both rows sit queued, labeled, in write order').toEqual([
    { pk: first, bucket_value: owner },
    { pk: second, bucket_value: owner },
  ])
  expect(await stampedRows(), 'no row has a changelog entry while the trigger is down').toEqual([])

  await admin.unsafe(recovery.fixSql)
  const later = await recovery.recover(admin, owner)

  expect(await leftoversFromFreshSession(), 'the queue and the markers are empty after the recovery').toEqual({ pending: 0, markers: 0 })
  const stamped = await stampedRows()

  expect(stamped.map((row) => row.pk), 'the stuck rows are numbered first, in the order they were written').toEqual([first, second, ...later])
  expect(stamped.map((row) => row.bucket_value), 'every entry keeps its bucket label').toEqual(stamped.map(() => owner))

  const [journal] = await db!`select winner_seq::text as winner_seq, pending_id from kizunasync._conflict_journal where table_name = ${FIXTURE_TABLE}`

  expect(journal, 'the journal entry is linked to the number its change drew').toEqual({ winner_seq: stamped[0]?.seq, pending_id: null })
  const delivered = await pullOn(admin, owner, saved.cursor)

  expect(delivered.rows.map((row) => row.pk)).toEqual(expect.arrayContaining([first, second, ...later]))
  expect((delivered.conflicts ?? []).map((conflict) => ({ pk: conflict.pk, winner_seq: conflict.winner_seq })), 'the pull attaches the journal entry').toEqual([
    { pk: first, winner_seq: stamped[0]?.seq },
  ])
}

/** Provisions the fixture, runs one recovery case on its own reserved connection, and restores both triggers whatever happens. */
async function runRecoveryCase(recovery: IRecoveryCase): Promise<void> {
  const conn = db!

  await provisionFixture(conn)

  // A reserved connection, because the recovery's own `begin`/`commit` needs one physical connection throughout.
  const pool = new SQL(DB_URL, { max: 1 })
  const admin = await pool.reserve()

  try {
    await expectRecoveryDelivers(admin, recovery)
  } finally {
    await conn.unsafe(RESTORE_TRIGGER_SQL).catch(() => undefined)
    admin.release()
    await pool.end()
    await dropFixture(conn)
  }
}

/** The Troubleshooting transaction: it writes no row, so it numbers only the stuck ones. */
async function armAndCommit(admin: TConn): Promise<string[]> {
  await admin.unsafe(RECOVERY_SQL)

  return []
}

/** A synced write and the arming statement in one transaction: the statement inserts nothing, and the stamp still runs once at commit. */
async function writeThenArm(admin: TConn, owner: string): Promise<string[]> {
  const pk = crypto.randomUUID()

  await admin`begin`
  await admin.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1, $2, 'written before the arming statement')`, [pk, owner])
  await admin.unsafe(ARM_AFTER_WRITE_SQL)
  await admin`commit`

  return [pk]
}

/** An ordinary write to the synced table after the repair, which numbers the stuck rows ahead of its own. */
async function writeOnce(admin: TConn, owner: string): Promise<string[]> {
  const pk = crypto.randomUUID()

  await admin.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1, $2, 'after the repair')`, [pk, owner])

  return [pk]
}

describe.skipIf(!reachable)('the change-stamp recovery', () => {
  test('re-enabling a disabled stamp trigger, then the Troubleshooting transaction, numbers the rows it left queued', async () => {
    await runRecoveryCase({
      breakSql: `alter table kizunasync._stamp_marker disable trigger ${STAMP_TRIGGER}`,
      fixSql: `alter table kizunasync._stamp_marker enable trigger ${STAMP_TRIGGER}`,
      recover: armAndCommit,
    })
  }, TEST_TIMEOUT_MS)

  test('re-enabling a disabled arming trigger, then the Troubleshooting transaction, numbers the rows it left queued', async () => {
    await runRecoveryCase({
      breakSql: `alter table kizunasync._change_pending disable trigger ${ARM_TRIGGER}`,
      fixSql: `alter table kizunasync._change_pending enable trigger ${ARM_TRIGGER}`,
      recover: armAndCommit,
    })
  }, TEST_TIMEOUT_MS)

  test('recreating a dropped stamp trigger, then the Troubleshooting transaction, numbers the rows it left queued', async () => {
    await runRecoveryCase({ breakSql: `drop trigger if exists ${STAMP_TRIGGER} on kizunasync._stamp_marker`, fixSql: RESTORE_TRIGGER_SQL, recover: armAndCommit })
  }, TEST_TIMEOUT_MS)

  test('recreating a dropped arming trigger, then the Troubleshooting transaction, numbers the rows it left queued', async () => {
    await runRecoveryCase({ breakSql: `drop trigger if exists ${ARM_TRIGGER} on kizunasync._change_pending`, fixSql: RESTORE_TRIGGER_SQL, recover: armAndCommit })
  }, TEST_TIMEOUT_MS)

  test('the arming statement after a synced write in the same transaction inserts nothing and the stamp still numbers every row', async () => {
    await runRecoveryCase({
      breakSql: `alter table kizunasync._stamp_marker disable trigger ${STAMP_TRIGGER}`,
      fixSql: `alter table kizunasync._stamp_marker enable trigger ${STAMP_TRIGGER}`,
      recover: writeThenArm,
    })
  }, TEST_TIMEOUT_MS)

  test('after the repair, the next write to a synced table numbers the stuck rows ahead of its own', async () => {
    await runRecoveryCase({
      breakSql: `alter table kizunasync._stamp_marker disable trigger ${STAMP_TRIGGER}`,
      fixSql: `alter table kizunasync._stamp_marker enable trigger ${STAMP_TRIGGER}`,
      recover: writeOnce,
    })
  }, TEST_TIMEOUT_MS)
})
