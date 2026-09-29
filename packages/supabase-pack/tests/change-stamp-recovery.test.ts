/**
 * The two Troubleshooting recovery scripts for a change that committed while
 * the stamp trigger was down: `kizunasync._change_pending` still queues the
 * write, but nothing draws it a sequence number until the trigger is
 * restored and the queued row is deleted and re-inserted so the restored
 * trigger fires on it again. A trigger merely disabled is re-enabled; a
 * trigger that is missing or not deferred is recreated with the pack's own
 * DDL. Both cases prove the same re-queue script afterward.
 *
 * The run writes to a synced table of its own, registered the way
 * `pull-fencing-stress.test.ts` registers its own, so its doorbell stays off
 * the `kizunasync:todos` topic. The trigger is restored and the fixture is
 * dropped in `finally`, whatever the test asserts. Skips loudly when no DB is
 * reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const FIXTURE_TABLE = '_change_stamp_recovery'
const STAMP_TRIGGER = 'kizunasync_stamp_change'
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
}

/** The exact script Troubleshooting shows under "Changes queued without a sequence number". */
const RECOVERY_SQL = `begin;
with queued as (
  delete from kizunasync._change_pending
  returning id, table_name, pk, op, bucket_snapshot, arrived_at
)
insert into kizunasync._change_pending (table_name, pk, op, bucket_snapshot, arrived_at)
select table_name, pk, op, bucket_snapshot, arrived_at from queued order by id;
commit;`

/**
 * The exact DDL Troubleshooting shows under "The stamp trigger is missing,
 * disabled, or not deferred", to recreate the trigger whether it was dropped
 * or merely hand-recreated without the deferred timing. Safe to run
 * unconditionally: `drop trigger if exists` tolerates an already-missing
 * trigger.
 */
const RESTORE_TRIGGER_SQL = `drop trigger if exists ${STAMP_TRIGGER} on kizunasync._change_pending;
create constraint trigger ${STAMP_TRIGGER}
  after insert on kizunasync._change_pending
  deferrable initially deferred
  for each row execute function kizunasync._stamp_change();`

/**
 * A fixture table with the columns the push path writes, readable by every
 * signed-in session and insertable as yourself, with both capture triggers
 * exactly as `kizunasync init` attaches them. A table a crashed run left behind is
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
    values (${FIXTURE_TABLE}, 'read-write', null, 1, false)
    on conflict (table_name) do update set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
}

async function dropFixture(conn: SQL): Promise<void> {
  await conn.unsafe(`drop table if exists public.${FIXTURE_TABLE} cascade`)
  await conn`delete from kizunasync._change_pending where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._bucket_grants where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`
}

/** `_change_pending` as a new session sees it: a queued row never outlives its transaction. */
async function pendingCountFromFreshSession(): Promise<number> {
  const fresh = new SQL(DB_URL, { max: 1 })

  try {
    const [row] = await fresh`select count(*)::int as n from kizunasync._change_pending where table_name = ${FIXTURE_TABLE}`

    return row.n as number
  } finally {
    await fresh.end()
  }
}

async function changelogSeqOf(pk: string): Promise<string | null> {
  const [row] = await db!`select max(seq)::text as seq from kizunasync._changelog where pk = ${pk}::uuid`

  return (row.seq as string | null) ?? null
}

/** One pull on the given connection, in its own transaction, the way a client's request arrives. */
async function pullOn(conn: TConn, user: string, cursor: string): Promise<IPullPage> {
  await conn`begin`
  await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true)`
  await conn`set local role authenticated`
  const [row] = await conn`select kizunasync.pull(${[{ table: FIXTURE_TABLE }]}::jsonb, ${cursor}, 1, 500) as resp`

  await conn`commit`

  return row.resp as IPullPage
}

/**
 * The shape both cases share: save a cursor, break the trigger, write and
 * commit one row, confirm it queued without a number, fix the trigger, run
 * the re-queue script, then confirm the row is numbered and delivered.
 */
async function expectRecoveryDelivers(admin: TConn, input: { owner: string; pk: string; breakTrigger: () => Promise<void>; fixTrigger: () => Promise<void> }): Promise<void> {
  const saved = await pullOn(admin, input.owner, '0')

  await input.breakTrigger()
  await admin.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1, $2, 'queued without a number')`, [input.pk, input.owner])

  const queuedRows = await admin`select table_name, pk from kizunasync._change_pending where pk = ${input.pk}::uuid`

  expect(queuedRows.length, 'one committed row sits in the queue').toBe(1)
  expect(queuedRows[0]).toEqual({ table_name: FIXTURE_TABLE, pk: input.pk })
  expect(await changelogSeqOf(input.pk), 'the row has no changelog entry while the trigger is down').toBeNull()

  await input.fixTrigger()
  await admin.unsafe(RECOVERY_SQL)

  expect(await pendingCountFromFreshSession(), 'the queue is empty after the recovery script').toBe(0)
  expect(await changelogSeqOf(input.pk), 'the restored trigger numbers the re-queued row').not.toBeNull()
  const delivered = await pullOn(admin, input.owner, saved.cursor)

  expect(delivered.rows.map((row) => row.pk)).toContain(input.pk)
}

describe.skipIf(!reachable)('the change-stamp recovery scripts', () => {
  test('re-enabling a disabled trigger recovers a row it left queued', async () => {
    const conn = db!
    const owner = crypto.randomUUID()
    const pk = crypto.randomUUID()

    await provisionFixture(conn)

    // A reserved connection, because the re-queue script's own `begin`/`commit` needs one physical connection throughout.
    const pool = new SQL(DB_URL, { max: 1 })
    const admin = await pool.reserve()

    try {
      await expectRecoveryDelivers(admin, {
        owner,
        pk,
        breakTrigger: async () => {
          await admin.unsafe(`alter table kizunasync._change_pending disable trigger ${STAMP_TRIGGER}`)
        },
        fixTrigger: async () => {
          await admin.unsafe(`alter table kizunasync._change_pending enable trigger ${STAMP_TRIGGER}`)
        },
      })
    } finally {
      await conn.unsafe(RESTORE_TRIGGER_SQL).catch(() => undefined)
      admin.release()
      await pool.end()
      await dropFixture(conn)
    }
  }, TEST_TIMEOUT_MS)

  test('recreating a dropped trigger recovers a row it left queued', async () => {
    const conn = db!
    const owner = crypto.randomUUID()
    const pk = crypto.randomUUID()

    await provisionFixture(conn)

    const pool = new SQL(DB_URL, { max: 1 })
    const admin = await pool.reserve()

    try {
      await expectRecoveryDelivers(admin, {
        owner,
        pk,
        breakTrigger: async () => {
          await admin.unsafe(`drop trigger if exists ${STAMP_TRIGGER} on kizunasync._change_pending`)
        },
        fixTrigger: async () => {
          await admin.unsafe(RESTORE_TRIGGER_SQL)
        },
      })
    } finally {
      await conn.unsafe(RESTORE_TRIGGER_SQL).catch(() => undefined)
      admin.release()
      await pool.end()
      await dropFixture(conn)
    }
  }, TEST_TIMEOUT_MS)
})
