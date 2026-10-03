/**
 * The bucket-labeled changelog against live Postgres.
 *
 * Every committed write carries the bucket value of the row it wrote
 * (`_changelog.bucket_value`, null on an unbucketed table), and a pull of a
 * bucketed table reads only the entries labeled with a value it requests, each
 * normalized once through the column type, and only the tombstones keyed by such
 * a value. Labels, grants, and the rows a pull renders spell a `timestamptz`
 * value in UTC whatever the session TimeZone. A write that moves a row to another
 * bucket value queues a tombstone for the old value before the upsert for the new
 * one, so a device that received the row from the old bucket and pulls only that
 * bucket drops it. Tombstones are keyed by `(table, pk, bucket value)`, so a
 * move-out and a later delete keep one each. A move-out is not a delete: a push
 * to the moved row is decided like any other. A pull names at most 64 bucket
 * entries.
 *
 * The fixture is a team-scoped table whose policies admit only members of the
 * row's team, an unbucketed table everyone reads, and a table everyone reads
 * that is bucketed on a `timestamptz` column. All are dropped with every
 * bookkeeping row they produced. Skips loudly when Postgres is unreachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const TEAMS = '_label_teams'
const MEMBERS = '_label_members'
const OPEN = '_label_open'
const STAMPED = '_label_stamped'
const TABLES = [TEAMS, OPEN, STAMPED] as const
const MAX_BUCKET_ENTRIES = 64
const LABEL_INDEX = '_changelog_bucket_idx'
const TOMBSTONE_INDEX = '_tombstones_bucket_idx'

/** One instant, spelled in UTC; a session in either zone below renders it with its own offset unless the pack pins UTC. */
const DUE = '2024-01-01T00:00:00Z'
const DUE_IN_UTC = '2024-01-01T00:00:00+00:00'
const WRITER_ZONE = 'Asia/Tokyo'
const PULLER_ZONE = 'America/New_York'

/** Rows of another team written before the one the index test pulls, so a plan that ignored the label would have to read past them. */
const OTHER_TEAM_ROWS = 2000

/** Index statistics reach a new reader within a few polls; this bounds the wait at four seconds. */
const STATS_POLLS = 40
const STATS_POLL_MS = 100

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-bucket-label] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TBucket = { table: string; params: Record<string, string> }
type TRow = { pk: string; row: Record<string, unknown>; seq: string; table: string }
type TTombstone = { deleted_at: string; pk: string; seq: string; table: string }
type TPullResp = { cursor: string; has_more: boolean; rows: TRow[]; signal: unknown; tombstones: TTombstone[] }
type TVerdict = { mutation_id: string; verdict: string; reason?: string; server_row?: Record<string, unknown> | null }
type TPushResp = { verdicts: TVerdict[] }
type TMutation = { op: 'insert' | 'update' | 'delete'; pk: string; columns?: Record<string, unknown> }
type TLabel = { seq: string; bucket_value: string | null }
type TStoredTombstone = { seq: string; bucket_value: string; bucket_snapshot: Record<string, string>; xid: string }

// MARK: - Fixture

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })
const mintedUsers: string[] = []

async function provision(): Promise<void> {
  const conn = db!

  await conn.unsafe(`
    drop table if exists public.${TEAMS} cascade;
    drop table if exists public.${OPEN} cascade;
    drop table if exists public.${STAMPED} cascade;
    drop table if exists public.${MEMBERS} cascade;
    create table public.${MEMBERS} (
      user_id uuid not null,
      team_id uuid not null,
      primary key (user_id, team_id)
    );
    alter table public.${MEMBERS} enable row level security;
    revoke all on public.${MEMBERS} from anon, authenticated;

    create or replace function public._label_is_member(p_team uuid) returns boolean
      language sql security definer set search_path = '' stable as $$
      select exists (
        select 1 from public.${MEMBERS} m
        where m.user_id = (select auth.uid()) and m.team_id = p_team
      ) $$;
    grant execute on function public._label_is_member(uuid) to authenticated;

    create table public.${TEAMS} (
      id uuid primary key,
      team_id uuid not null,
      title text not null
    );
    alter table public.${TEAMS} enable row level security;
    grant select, insert, update, delete on public.${TEAMS} to authenticated;
    create policy t_all on public.${TEAMS} for all to authenticated
      using (public._label_is_member(team_id))
      with check (public._label_is_member(team_id));

    create table public.${OPEN} (
      id uuid primary key,
      title text not null
    );
    alter table public.${OPEN} enable row level security;
    grant select, insert, update, delete on public.${OPEN} to authenticated;
    create policy o_all on public.${OPEN} for all to authenticated using (true) with check (true);

    create table public.${STAMPED} (
      id uuid primary key,
      due timestamptz not null,
      title text not null
    );
    alter table public.${STAMPED} enable row level security;
    grant select, insert, update, delete on public.${STAMPED} to authenticated;
    create policy d_all on public.${STAMPED} for all to authenticated using (true) with check (true);
  `)

  for (const table of TABLES) {
    await conn.unsafe(`
      create trigger kizunasync_track_change after insert or update on public.${table}
        for each row execute function kizunasync.track_change();
      create trigger kizunasync_track_delete after delete on public.${table}
        for each row execute function kizunasync.track_delete();
    `)
  }
  await conn`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values
      (${TEAMS}, 'read-write', 'team_id', 1, false),
      (${OPEN}, 'read-write', null, 1, false),
      (${STAMPED}, 'read-write', 'due', 1, false)
    on conflict (table_name) do update
      set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
}

async function cleanup(): Promise<void> {
  const conn = db!

  await conn.unsafe(`drop table if exists public.${TEAMS} cascade`)
  await conn.unsafe(`drop table if exists public.${OPEN} cascade`)
  await conn.unsafe(`drop table if exists public.${STAMPED} cascade`)
  await conn.unsafe(`drop table if exists public.${MEMBERS} cascade`)
  await conn.unsafe(`drop function if exists public._label_is_member(uuid)`)

  for (const table of TABLES) {
    await conn`delete from kizunasync._changelog where table_name = ${table}`
    await conn`delete from kizunasync._tombstones where table_name = ${table}`
    await conn`delete from kizunasync._bucket_grants where table_name = ${table}`
    await conn`delete from kizunasync._row_hlc where table_name = ${table}`
    await conn`delete from kizunasync._config where table_name = ${table}`
  }
  if (mintedUsers.length > 0) {
    await conn`delete from kizunasync._verdicts where user_id::text in ${conn(mintedUsers)}`
    await conn`delete from auth.users where id::text in ${conn(mintedUsers)}`
  }
}

beforeAll(async () => {
  if (reachable) {
    await provision()
  }
})

afterAll(async () => {
  if (db !== null) {
    await cleanup()
    await db.end()
  }
})

// MARK: - Helpers

async function mintMember(...teams: string[]): Promise<string> {
  const [user] = await db!`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), false) returning id::text as id`
  const id = user.id as string

  mintedUsers.push(id)

  for (const team of teams) {
    await db!.unsafe(`insert into public.${MEMBERS} (user_id, team_id) values ($1, $2)`, [id, team])
  }

  return id
}

async function insertRow(team: string, title: string): Promise<string> {
  const pk = uid()

  await db!.unsafe(`insert into public.${TEAMS} (id, team_id, title) values ($1, $2, $3)`, [pk, team, title])

  return pk
}

async function moveRow(pk: string, team: string): Promise<void> {
  await db!.unsafe(`update public.${TEAMS} set team_id = $2 where id = $1`, [pk, team])
}

async function deleteRow(table: string, pk: string): Promise<void> {
  await db!.unsafe(`delete from public.${table} where id = $1`, [pk])
}

/** The highest seq on either ledger: a cursor below every change a test writes next. */
async function sequenceTop(): Promise<string> {
  const [top] = await db!`
    select coalesce(max(seq), 0)::text as seq
    from (select seq from kizunasync._changelog union all select seq from kizunasync._tombstones) s`

  return top.seq as string
}

async function labelsOf(table: string, pk: string): Promise<TLabel[]> {
  return db!<TLabel[]>`
    select cl.seq::text as seq, cl.bucket_value from kizunasync._changelog cl
    where cl.table_name = ${table} and cl.pk = ${pk} order by cl.seq`
}

async function tombstonesOf(table: string, pk: string): Promise<TStoredTombstone[]> {
  return db!<TStoredTombstone[]>`
    select t.seq::text as seq, t.bucket_value, t.bucket_snapshot, t.xid::text as xid from kizunasync._tombstones t
    where t.table_name = ${table} and t.pk = ${pk} order by t.seq`
}

async function changelogXid(table: string, seq: string): Promise<string> {
  const [row] = await db!`select xid::text as xid from kizunasync._changelog where table_name = ${table} and seq = ${seq}::bigint`

  return row.xid as string
}

/** Runs `fn` under the caller's JWT and role in a transaction of its own, which it rolls back; `setup` runs first, as the connecting role. */
async function asUser<T>(sub: string, fn: (w: SQL) => Promise<T>, setup?: (w: SQL) => Promise<void>): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`

    try {
      if (setup !== undefined) {
        await setup(w as unknown as SQL)
      }
      await w`select set_config('request.jwt.claims', ${claims(sub)}, true)`
      await w`set local role authenticated`
      const out = await fn(w as unknown as SQL)

      await w`rollback`

      return out
    } catch (error) {
      await w`rollback`.catch(() => {})

      throw error
    }
  } finally {
    w.release()
    await pool.end()
  }
}

const teamBucket = (team: string): TBucket => ({ table: TEAMS, params: { team_id: team } })

async function pullAs(sub: string, buckets: TBucket[], cursor: string, maxPullScan?: number): Promise<TPullResp> {
  const setup = maxPullScan === undefined
    ? undefined
    : async (w: SQL): Promise<void> => {
      await w`update kizunasync._settings set max_pull_scan = ${maxPullScan}`
    }

  return asUser(sub, async (w) => {
    const [r] = await w<{ resp: TPullResp }[]>`select kizunasync.pull(${buckets}::jsonb, ${cursor}, 1, 500) as resp`

    return r.resp
  }, setup)
}

/** A committed pull from '0', so the caller keeps the grant for every bucket value it received a live row from. */
async function receiveRows(sub: string, buckets: TBucket[]): Promise<void> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`
    await w`select set_config('request.jwt.claims', ${claims(sub)}, true)`
    await w`set local role authenticated`
    await w`select kizunasync.pull(${buckets}::jsonb, '0', 1, 500)`
    await w`commit`
  } finally {
    w.release()
    await pool.end()
  }
}

/** The SQLSTATE and message of a pull the pack refuses; fails loud when the pull is answered instead. Bun's SQL client carries the SQLSTATE on `errno`. */
async function pullRefusal(sub: string, buckets: TBucket[]): Promise<{ sqlstate: unknown; message: string }> {
  try {
    await pullAs(sub, buckets, '0')
  } catch (error) {
    return { sqlstate: error instanceof Error && 'errno' in error ? error.errno : undefined, message: error instanceof Error ? error.message : String(error) }
  }
  throw new Error('the pull should have been refused')
}

/** A committed push: its verdicts are what a device would keep. */
async function pushAs(sub: string, mutations: TMutation[]): Promise<TVerdict[]> {
  const batch = {
    atomic: false,
    mutations: mutations.map((mutation) => ({ mutation_id: uid(), table: TEAMS, columns: {}, ...mutation })),
  }
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`
    await w`select set_config('request.jwt.claims', ${claims(sub)}, true)`
    await w`set local role authenticated`
    const [r] = await w<{ resp: TPushResp }[]>`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

    await w`commit`

    return r.resp.verdicts
  } finally {
    w.release()
    await pool.end()
  }
}

/** Runs `statement` as the connecting role in a transaction of its own whose session TimeZone is `zone`. */
async function writeInZone(zone: string, statement: string, params: unknown[]): Promise<void> {
  await db!.begin(async (tx) => {
    await tx`select set_config('timezone', ${zone}, true)`
    await tx.unsafe(statement, params)
  })
}

/** A pull under the caller's JWT in a session whose TimeZone is `zone`; a committed one keeps the grants it records. */
async function pullInZone(zone: string, sub: string, buckets: TBucket[], cursor: string, commit: boolean): Promise<TPullResp> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`
    await w`select set_config('timezone', ${zone}, true)`
    await w`select set_config('request.jwt.claims', ${claims(sub)}, true)`
    await w`set local role authenticated`
    const [r] = await w<{ resp: TPullResp }[]>`select kizunasync.pull(${buckets}::jsonb, ${cursor}, 1, 500) as resp`

    await (commit ? w`commit` : w`rollback`)

    return r.resp
  } finally {
    w.release()
    await pool.end()
  }
}

const rowPks = (page: TPullResp): string[] => page.rows.map((row) => row.pk)
const tombstonePks = (page: TPullResp): string[] => page.tombstones.map((tombstone) => tombstone.pk)

// MARK: - Labels

describe.skipIf(!reachable)('the changelog carries the bucket value of every write', () => {
  test('an insert and an update are labeled with the row bucket value, and an unbucketed write with null', async () => {
    const team = uid()
    const pk = await insertRow(team, 'first')

    await db!.unsafe(`update public.${TEAMS} set title = 'second' where id = $1`, [pk])
    const open = uid()

    await db!.unsafe(`insert into public.${OPEN} (id, title) values ($1, 'shared')`, [open])

    expect((await labelsOf(TEAMS, pk)).map((label) => label.bucket_value)).toEqual([team, team])
    expect((await labelsOf(OPEN, open)).map((label) => label.bucket_value)).toEqual([null])
  })

  test('a delete keys its tombstone by the bucket value the row left, and an unbucketed delete by the empty string', async () => {
    const team = uid()
    const pk = await insertRow(team, 'doomed')
    const open = uid()

    await db!.unsafe(`insert into public.${OPEN} (id, title) values ($1, 'shared')`, [open])
    await deleteRow(TEAMS, pk)
    await deleteRow(OPEN, open)

    expect((await tombstonesOf(TEAMS, pk)).map(({ bucket_value, bucket_snapshot }) => ({ bucket_value, bucket_snapshot }))).toEqual([
      { bucket_value: team, bucket_snapshot: { team_id: team } },
    ])
    expect((await tombstonesOf(OPEN, open)).map(({ bucket_value, bucket_snapshot }) => ({ bucket_value, bucket_snapshot }))).toEqual([
      { bucket_value: '', bucket_snapshot: {} },
    ])
  })
})

// MARK: - Move-out

describe.skipIf(!reachable)('a write that moves a row to another bucket value', () => {
  test('queues the old bucket tombstone before the new bucket upsert, in the same commit', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const pk = await insertRow(teamA, 'moving')

    await moveRow(pk, teamB)
    const labels = await labelsOf(TEAMS, pk)
    const [tombstone, ...others] = await tombstonesOf(TEAMS, pk)
    const upsert = labels.at(-1)!

    expect(others).toEqual([])
    expect({ bucket_value: tombstone!.bucket_value, bucket_snapshot: tombstone!.bucket_snapshot }).toEqual({
      bucket_value: teamA,
      bucket_snapshot: { team_id: teamA },
    })
    expect(labels.map((label) => label.bucket_value)).toEqual([teamA, teamB])
    expect(BigInt(tombstone!.seq) < BigInt(upsert.seq)).toBe(true)
    expect(tombstone!.xid).toBe(await changelogXid(TEAMS, upsert.seq))

    await db!.unsafe(`update public.${TEAMS} set title = 'still in B' where id = $1`, [pk])

    expect(await tombstonesOf(TEAMS, pk)).toHaveLength(1)
  })

  test('a later delete leaves a second tombstone beside the move-out one', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const pk = await insertRow(teamA, 'moving')

    await moveRow(pk, teamB)
    await deleteRow(TEAMS, pk)
    const stored = await tombstonesOf(TEAMS, pk)

    expect(stored.map((tombstone) => tombstone.bucket_value)).toEqual([teamA, teamB])
    expect(stored.map((tombstone) => tombstone.bucket_snapshot)).toEqual([{ team_id: teamA }, { team_id: teamB }])
  })

  test('a pull of the old bucket receives the tombstone, of the new bucket the row, and of both only the row', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const bob = await mintMember(teamB)
    const carol = await mintMember(teamA, teamB)
    const base = await sequenceTop()
    const pk = await insertRow(teamA, 'moving')
    const afterInsert = await sequenceTop()

    await receiveRows(alice, [teamBucket(teamA)])
    await receiveRows(carol, [teamBucket(teamA), teamBucket(teamB)])
    await moveRow(pk, teamB)

    for (const cursor of [base, afterInsert]) {
      const old = await pullAs(alice, [teamBucket(teamA)], cursor)
      const next = await pullAs(bob, [teamBucket(teamB)], cursor)
      const both = await pullAs(carol, [teamBucket(teamA), teamBucket(teamB)], cursor)

      expect({ rows: rowPks(old), tombstones: tombstonePks(old) }, `alice from ${cursor}`).toEqual({ rows: [], tombstones: [pk] })
      expect({ rows: rowPks(next), tombstones: tombstonePks(next) }, `bob from ${cursor}`).toEqual({ rows: [pk], tombstones: [] })
      expect({ rows: rowPks(both), tombstones: tombstonePks(both) }, `carol from ${cursor}`).toEqual({ rows: [pk], tombstones: [] })
    }
  })

  test('a row moved back reaches its first bucket as a row, and that bucket tombstone stays out', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const bob = await mintMember(teamB)
    const base = await sequenceTop()
    const pk = await insertRow(teamA, 'round trip')

    await moveRow(pk, teamB)
    await receiveRows(bob, [teamBucket(teamB)])
    await moveRow(pk, teamA)
    const home = await pullAs(alice, [teamBucket(teamA)], base)
    const away = await pullAs(bob, [teamBucket(teamB)], base)

    expect({ rows: rowPks(home), tombstones: tombstonePks(home) }).toEqual({ rows: [pk], tombstones: [] })
    expect({ rows: rowPks(away), tombstones: tombstonePks(away) }).toEqual({ rows: [], tombstones: [pk] })
  })
})

// MARK: - Pushes to a moved row

describe.skipIf(!reachable)('a push to a moved row is decided like any other write', () => {
  test('a member of the new bucket updates it, and a former member is refused by RLS rather than DELETE_WINS', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const bob = await mintMember(teamB)
    const pk = await insertRow(teamA, 'moving')

    await moveRow(pk, teamB)
    const [update] = await pushAs(bob, [{ op: 'update', pk, columns: { title: 'kept in B' } }])
    const refused = await pushAs(alice, [
      { op: 'update', pk, columns: { title: 'from A' } },
      { op: 'delete', pk },
    ])

    expect(update?.verdict).toBe('applied')
    expect(refused.map(({ verdict, reason, server_row }) => ({ verdict, reason, server_row }))).toEqual([
      { verdict: 'rejected', reason: 'RLS_DENIED', server_row: null },
      { verdict: 'rejected', reason: 'RLS_DENIED', server_row: null },
    ])
  })

  test('a batch that moves a row and then edits it applies both', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const carol = await mintMember(teamA, teamB)
    const pk = await insertRow(teamA, 'moving')
    const verdicts = await pushAs(carol, [
      { op: 'update', pk, columns: { team_id: teamB } },
      { op: 'update', pk, columns: { title: 'edited after the move' } },
    ])

    expect(verdicts.map((verdict) => verdict.verdict)).toEqual(['applied', 'applied'])
    expect((await tombstonesOf(TEAMS, pk)).map((tombstone) => tombstone.bucket_value)).toEqual([teamA])
  })

  test('a deleted row still answers DELETE_WINS, after a move and inside the deleting batch', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const carol = await mintMember(teamA, teamB)
    const moved = await insertRow(teamA, 'moved then deleted')

    await moveRow(moved, teamB)
    await receiveRows(carol, [teamBucket(teamB)])
    await deleteRow(TEAMS, moved)
    const [afterDelete] = await pushAs(carol, [{ op: 'update', pk: moved, columns: { title: 'too late' } }])
    const sameBatch = await insertRow(teamA, 'deleted in the batch')
    const verdicts = await pushAs(carol, [
      { op: 'delete', pk: sameBatch },
      { op: 'update', pk: sameBatch, columns: { title: 'too late' } },
    ])

    expect({ verdict: afterDelete?.verdict, reason: afterDelete?.reason }).toEqual({ verdict: 'rejected', reason: 'DELETE_WINS' })
    expect(verdicts.map(({ verdict, reason }) => ({ verdict, reason }))).toEqual([
      { verdict: 'applied', reason: undefined },
      { verdict: 'rejected', reason: 'DELETE_WINS' },
    ])
  })
})

// MARK: - Session time zones

describe.skipIf(!reachable)('a timestamptz bucket value reads the same in every session time zone', () => {
  test(`a row written in ${WRITER_ZONE} reaches a puller in ${PULLER_ZONE}, and so does its tombstone`, async () => {
    const puller = await mintMember()
    const bucket: TBucket = { table: STAMPED, params: { due: DUE } }
    const base = await sequenceTop()
    const pk = uid()

    await writeInZone(WRITER_ZONE, `insert into public.${STAMPED} (id, due, title) values ($1, $2, 'stamped')`, [pk, DUE])
    const received = await pullInZone(PULLER_ZONE, puller, [bucket], base, true)

    await writeInZone(WRITER_ZONE, `delete from public.${STAMPED} where id = $1`, [pk])
    const removed = await pullInZone(PULLER_ZONE, puller, [bucket], received.cursor, false)

    expect((await labelsOf(STAMPED, pk)).map((label) => label.bucket_value)).toEqual([DUE_IN_UTC])
    expect({ rows: rowPks(received), due: received.rows[0]?.row.due }).toEqual({ rows: [pk], due: DUE_IN_UTC })
    expect((await tombstonesOf(STAMPED, pk)).map((tombstone) => tombstone.bucket_value)).toEqual([DUE_IN_UTC])
    expect({ rows: rowPks(removed), tombstones: tombstonePks(removed) }).toEqual({ rows: [], tombstones: [pk] })
  })
})

// MARK: - Labeled reads

describe.skipIf(!reachable)('a pull reads only the changelog entries and tombstones of the bucket values it requests', () => {
  test('rows of another bucket value never count against the scan cap', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const base = await sequenceTop()

    for (const title of ['b one', 'b two', 'b three']) {
      await insertRow(teamB, title)
    }
    const mine = await insertRow(teamA, 'a one')
    const page = await pullAs(alice, [teamBucket(teamA)], base, 1)

    expect({ rows: rowPks(page), has_more: page.has_more }).toEqual({ rows: [mine], has_more: false })
  })

  test('a requested value is normalized through the column type, and a value the type refuses fails the pull', async () => {
    const team = uid()
    const alice = await mintMember(team)
    const base = await sequenceTop()
    const pk = await insertRow(team, 'case blind')
    const page = await pullAs(alice, [teamBucket(team.toUpperCase())], base)

    expect(rowPks(page)).toEqual([pk])
    expect((await pullRefusal(alice, [teamBucket('not a uuid')])).sqlstate).toBe('22P02')
  })

  test('the labeled read goes through the (table_name, bucket_value, seq) index', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const base = await sequenceTop()

    await db!.unsafe(
      `insert into public.${TEAMS} (id, team_id, title) select gen_random_uuid(), $1::uuid, 'other ' || g from generate_series(1, ${OTHER_TEAM_ROWS}) g`,
      [teamB],
    )
    const mine = await insertRow(teamA, 'needle')

    await db!`analyze kizunasync._changelog`
    const before = await indexScans(LABEL_INDEX)
    const page = await pullAs(alice, [teamBucket(teamA)], base)
    const after = await indexScansAfter(LABEL_INDEX, before)

    expect(rowPks(page)).toEqual([mine])
    expect(after).toBeGreaterThan(before)
  })

  test('the tombstone read goes through the (table_name, bucket_value, seq) index', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const mine = await insertRow(teamA, 'needle')

    await receiveRows(alice, [teamBucket(teamA)])
    const base = await sequenceTop()

    await db!.unsafe(
      `insert into public.${TEAMS} (id, team_id, title) select gen_random_uuid(), $1::uuid, 'other ' || g from generate_series(1, ${OTHER_TEAM_ROWS}) g`,
      [teamB],
    )
    await db!.unsafe(`delete from public.${TEAMS} where team_id = $1::uuid`, [teamB])
    await deleteRow(TEAMS, mine)
    await db!`analyze kizunasync._tombstones`
    const before = await indexScans(TOMBSTONE_INDEX)
    const page = await pullAs(alice, [teamBucket(teamA)], base)
    const after = await indexScansAfter(TOMBSTONE_INDEX, before)

    expect({ rows: rowPks(page), tombstones: tombstonePks(page) }).toEqual({ rows: [], tombstones: [mine] })
    expect(after).toBeGreaterThan(before)
  })

  test(`a pull names at most ${MAX_BUCKET_ENTRIES} bucket entries`, async () => {
    const team = uid()
    const alice = await mintMember(team)
    const entries = (count: number): TBucket[] => Array.from({ length: count }, () => teamBucket(team))

    expect(await pullRefusal(alice, entries(MAX_BUCKET_ENTRIES + 1))).toEqual({
      sqlstate: '22023',
      message: `kizunasync.pull(): a pull names at most ${MAX_BUCKET_ENTRIES} bucket entries`,
    })
    expect((await pullAs(alice, entries(MAX_BUCKET_ENTRIES), '0')).signal).toBeNull()
  })
})

/** Index scans of one pack index so far. */
async function indexScans(index: string): Promise<number> {
  const pool = new SQL(DB_URL, { max: 1 })

  try {
    const [row] = await pool`select coalesce(idx_scan, 0)::int as n from pg_stat_all_indexes where schemaname = 'kizunasync' and indexrelname = ${index}`

    return (row?.n as number | undefined) ?? 0
  } finally {
    await pool.end()
  }
}

/** A backend reports its index counters when it exits, a moment after its client disconnects, so the reader polls until the count moves past `before`. */
async function indexScansAfter(index: string, before: number): Promise<number> {
  for (let poll = 0; poll < STATS_POLLS; poll++) {
    const scans = await indexScans(index)

    if (scans > before) {
      return scans
    }
    await Bun.sleep(STATS_POLL_MS)
  }

  return indexScans(index)
}
