/**
 * The no-op UPDATE guard in kizunasync.track_change() against real Postgres: the
 * layer the corpus can't reach (it runs the TS oracle over sqlite, never this
 * SQL). An UPDATE whose NEW row equals OLD writes no _changelog row and consumes
 * no _change_seq value, so it wakes no client; a real edit still writes one, and
 * so does an edit of a table whose json and point columns have no equality
 * operator. The
 * pack numbers a change when its transaction commits, so every step commits and
 * the counters are read after it. Each case creates its probe table and drops it
 * with the bookkeeping rows it left. Skips loudly (named reason) when no DB is
 * reachable.
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
    `[trigger-noop-update] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await db.end()
  }
})

type TConn = Awaited<ReturnType<SQL['reserve']>>

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
  reason?: string
}

interface ICounters {
  changelogRows: number
  seq: number
}

/** A synced probe table: its name and the column list its `create table` declares. */
interface IProbeTable {
  name: string
  columns: string
}

/**
 * An owner-only table carrying the change tracker and NO server-stamped
 * updated_at: public.todos bumps updated_at from a BEFORE UPDATE trigger, so its
 * NEW row differs from OLD on every write and it cannot carry these cases. No FK
 * on the owner column either, so a case needs no auth.users row. Created and
 * dropped around each case, so this file leaves the DB as it found it.
 */
const PROBE_TABLE = '_noop_update_probe'

const NOOP_PROBE: IProbeTable = {
  name: PROBE_TABLE,
  columns: 'id uuid primary key, user_id uuid not null, title text not null, done boolean not null default false',
}

/** The same shape with a `json` and a `point` column, two types Postgres gives no equality operator. */
const TYPED_PROBE_TABLE = '_typed_update_probe'

const TYPED_PROBE: IProbeTable = {
  name: TYPED_PROBE_TABLE,
  columns: 'id uuid primary key, user_id uuid not null, payload json not null, location point not null',
}

async function provisionProbeTable(session: TConn, probe: IProbeTable): Promise<void> {
  await session.unsafe(`
    create table public.${probe.name} (${probe.columns});
    alter table public.${probe.name} enable row level security;
    grant select, insert, update, delete on public.${probe.name} to authenticated;
    create policy np_all on public.${probe.name} for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    create trigger kizunasync_track_change after insert or update on public.${probe.name}
      for each row execute function kizunasync.track_change();
  `)
  await session`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${probe.name}, 'read-write', 'user_id', 1, false)`
}

async function dropProbeTable(session: TConn, table: string): Promise<void> {
  await session`rollback`.catch(() => undefined)
  await session.unsafe(`drop table if exists public.${table} cascade`)
  await session`delete from kizunasync._changelog where table_name = ${table}`
  await session`delete from kizunasync._tombstones where table_name = ${table}`
  await session`delete from kizunasync._config where table_name = ${table}`
}

/**
 * Changelog rows for the probe table, plus this SESSION's last _change_seq value.
 * currval is per-connection, so the apps polling the same stack cannot move it;
 * last_value could, which would make the no-advance assertion flaky. Only valid
 * after this session has committed a tracked change at least once: the stamp
 * draws the number in the committing session.
 */
async function readCounters(session: TConn, table: string = PROBE_TABLE): Promise<ICounters> {
  const [row] = await session<{ changelog_rows: number; seq: string }[]>`
    select
      (select count(*)::int from kizunasync._changelog where table_name = ${table})
        as changelog_rows,
      currval('kizunasync._change_seq')::text as seq`

  return { changelogRows: row.changelog_rows, seq: Number(row.seq) }
}

/** Runs `body` on one session against a freshly provisioned probe table, then drops the table and its bookkeeping rows. */
async function withProbeTable<T>(body: (session: TConn) => Promise<T>, probe: IProbeTable = NOOP_PROBE): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const session = await pool.reserve()

  try {
    await provisionProbeTable(session, probe)

    return await body(session)
  } finally {
    await dropProbeTable(session, probe.name)
    session.release()
    await pool.end()
  }
}

/** Pushes `mutation` as `actor` in its own committed transaction, then deletes the verdict it recorded. */
async function pushAs(session: TConn, actor: string, mutation: Record<string, unknown>): Promise<IVerdict | undefined> {
  // Become the actor: request JWT claims populate auth.uid() for the RLS the push applies under.
  const claims = JSON.stringify({ sub: actor, role: 'authenticated' })

  await session`begin`
  await session`select set_config('request.jwt.claims', ${claims}, true)`
  await session`set local role authenticated`

  // Pass the batch as an OBJECT: Bun.sql encodes it as a json param, so `::jsonb` yields a real object. A JSON string would cast to a jsonb string scalar (double-encoded) and the gate would see zero mutations.
  const batch = { atomic: false, mutations: [mutation] }
  const [row] = await session`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

  // Committing ends the local role, and the bookkeeping tables are readable by the table owner, never by `authenticated`.
  await session`commit`
  await session`delete from kizunasync._verdicts where mutation_id = ${mutation.mutation_id as string}::uuid`

  return (row.resp as { verdicts: IVerdict[] }).verdicts[0]
}

describe.skipIf(!reachable)('track_change ignores an UPDATE that changes nothing', () => {
  test('an UPDATE setting every column to its current value writes no changelog row', async () => {
    const { before, after } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()

      await session.unsafe(
        `insert into public.${PROBE_TABLE} (id, user_id, title, done) values ($1, $2, $3, false)`,
        [pk, crypto.randomUUID(), 'unchanged row'],
      )
      const seen = await readCounters(session)

      await session.unsafe(
        `update public.${PROBE_TABLE} set user_id = user_id, title = title, done = done where id = $1`,
        [pk],
      )

      return { before: seen, after: await readCounters(session) }
    })

    expect(after.changelogRows).toBe(before.changelogRows)
    expect(after.seq).toBe(before.seq)
  })

  test('an UPDATE that changes one column writes exactly one changelog row', async () => {
    const { before, after } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()

      await session.unsafe(
        `insert into public.${PROBE_TABLE} (id, user_id, title, done) values ($1, $2, $3, false)`,
        [pk, crypto.randomUUID(), 'edited row'],
      )
      const seen = await readCounters(session)

      await session.unsafe(`update public.${PROBE_TABLE} set done = true where id = $1`, [pk])

      return { before: seen, after: await readCounters(session) }
    })

    expect(after.changelogRows).toBe(before.changelogRows + 1)
    expect(after.seq).toBe(before.seq + 1)
  })

  test('an identical insert … on conflict do update writes nothing on the second run', async () => {
    const { rowsForPk, afterFirst, afterSecond } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()
      const owner = crypto.randomUUID()
      // The demo's staging shape: a fixed pk re-upserted with the same values.
      const upsert = async (): Promise<void> => {
        await session.unsafe(
          `insert into public.${PROBE_TABLE} (id, user_id, title, done) values ($1, $2, $3, false)
           on conflict (id) do update
             set user_id = excluded.user_id, title = excluded.title, done = excluded.done`,
          [pk, owner, 'staged row'],
        )
      }
      await upsert()
      const first = await readCounters(session)

      await upsert()
      const second = await readCounters(session)
      const [counted] = await session<{ n: number }[]>`
        select count(*)::int as n from kizunasync._changelog
        where table_name = ${PROBE_TABLE} and pk = ${pk}::uuid`

      return { rowsForPk: counted.n, afterFirst: first, afterSecond: second }
    })

    expect(rowsForPk).toBe(1)
    expect(afterSecond.changelogRows).toBe(afterFirst.changelogRows)
    expect(afterSecond.seq).toBe(afterFirst.seq)
  })

  test('a push of identical values is applied and writes no changelog row', async () => {
    const { verdict, before, after } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()
      const actor = crypto.randomUUID()
      const mutationId = crypto.randomUUID()

      await session.unsafe(
        `insert into public.${PROBE_TABLE} (id, user_id, title, done) values ($1, $2, $3, true)`,
        [pk, actor, 'pushed row'],
      )
      const seen = await readCounters(session)
      const pushed = await pushAs(session, actor, {
        mutation_id: mutationId,
        table: PROBE_TABLE,
        pk,
        op: 'update',
        columns: { title: 'pushed row', done: true },
      })

      return { verdict: pushed, before: seen, after: await readCounters(session) }
    })

    expect(verdict?.verdict).toBe('applied')
    expect(after.changelogRows).toBe(before.changelogRows)
    expect(after.seq).toBe(before.seq)
  })
})

/**
 * `json` and `point` have no equality operator, so a whole-row comparison of a
 * table carrying either one cannot run. The tracker compares the rows' jsonb
 * renderings instead, where equality is semantic: a json rewrite that changes
 * only whitespace or key order, or a point written as `(1.0,2.0)`, is no change.
 */
describe.skipIf(!reachable)('track_change compares rows that carry json and point columns', () => {
  const insertTypedRow = async (session: TConn, pk: string, owner: string): Promise<void> => {
    await session.unsafe(
      `insert into public.${TYPED_PROBE_TABLE} (id, user_id, payload, location) values ($1, $2, '{"a": 1, "b": 1}', '(1,2)')`,
      [pk, owner],
    )
  }

  test('a direct UPDATE of the json column writes exactly one changelog row', async () => {
    const { before, after } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()

      await insertTypedRow(session, pk, crypto.randomUUID())
      const seen = await readCounters(session, TYPED_PROBE_TABLE)

      await session.unsafe(`update public.${TYPED_PROBE_TABLE} set payload = '{"a": 2, "b": 1}' where id = $1`, [pk])

      return { before: seen, after: await readCounters(session, TYPED_PROBE_TABLE) }
    }, TYPED_PROBE)

    expect(after.changelogRows).toBe(before.changelogRows + 1)
    expect(after.seq).toBe(before.seq + 1)
  })

  test('a direct UPDATE that only reformats the json and rewrites the same point writes no changelog row', async () => {
    const { before, after } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()

      await insertTypedRow(session, pk, crypto.randomUUID())
      const seen = await readCounters(session, TYPED_PROBE_TABLE)

      await session.unsafe(
        `update public.${TYPED_PROBE_TABLE} set payload = '{ "b": 1,   "a": 1.0 }', location = '(1.0,2.0)' where id = $1`,
        [pk],
      )

      return { before: seen, after: await readCounters(session, TYPED_PROBE_TABLE) }
    }, TYPED_PROBE)

    expect(after.changelogRows).toBe(before.changelogRows)
    expect(after.seq).toBe(before.seq)
  })

  test('a push writing the json and point columns is applied and writes exactly one changelog row', async () => {
    const { verdict, before, after, stored } = await withProbeTable(async (session) => {
      const pk = crypto.randomUUID()
      const actor = crypto.randomUUID()

      await insertTypedRow(session, pk, actor)
      const seen = await readCounters(session, TYPED_PROBE_TABLE)
      const pushed = await pushAs(session, actor, {
        mutation_id: crypto.randomUUID(),
        table: TYPED_PROBE_TABLE,
        pk,
        op: 'update',
        columns: { payload: { a: 3 }, location: '(3,4)' },
      })
      const [row] = await session.unsafe(
        `select payload::text as payload, location::text as location from public.${TYPED_PROBE_TABLE} where id = $1`,
        [pk],
      )

      return { verdict: pushed, before: seen, after: await readCounters(session, TYPED_PROBE_TABLE), stored: row }
    }, TYPED_PROBE)

    expect(verdict?.verdict).toBe('applied')
    expect(after.changelogRows).toBe(before.changelogRows + 1)
    expect(after.seq).toBe(before.seq + 1)
    expect(stored).toEqual({ payload: '{"a": 3}', location: '(3,4)' })
  })
})
