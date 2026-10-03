/**
 * Tombstone delivery grants against live Postgres.
 *
 * A pull records a grant in `_bucket_grants` for every (table, bucket value) it
 * delivers a live row from, `''` on an unbucketed table. A tombstone reaches a
 * caller only for a pair that caller holds, and only when the row's current
 * state is not deliverable to that caller under the requested buckets, so a
 * foreign bucket value reveals no deleted pk, a device that pulls both sides of
 * a move keeps the row, and a caller who cannot see a recreated row still drops
 * its copy. Tombstones match the bucket column alone, so a bucket with extra
 * params receives deletes. A committed tombstone answers `DELETE_WINS` only to a
 * caller who holds a grant for its bucket value and `RLS_DENIED` to anyone else;
 * a delete the same push queued earlier always answers `DELETE_WINS`.
 *
 * The fixture is a team-scoped table whose read policy admits members of the
 * row's team, minus rows marked private to another member, plus an unbucketed
 * table everyone reads. Every pull commits, so its grants persist. Both tables
 * are dropped with every bookkeeping row they produced. Skips loudly when
 * Postgres is unreachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const TEAMS = '_grant_teams'
const MEMBERS = '_grant_members'
const OPEN = '_grant_open'
const TABLES = [TEAMS, OPEN] as const

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-tombstone-grants] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TBucket = { table: string; params: Record<string, string> }
type TRow = { pk: string; row: Record<string, unknown>; seq: string; table: string }
type TTombstone = { deleted_at: string; pk: string; seq: string; table: string }
type TPullResp = { cursor: string; has_more: boolean; rows: TRow[]; signal: unknown; tombstones: TTombstone[] }
type TVerdict = { mutation_id: string; verdict: string; reason?: string; server_row?: Record<string, unknown> | null }
type TMutation = { op: 'insert' | 'update' | 'delete'; pk: string; columns?: Record<string, unknown> }
type TGrant = { table_name: string; bucket_value: string }

// MARK: - Fixture

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })
const mintedUsers: string[] = []

async function provision(): Promise<void> {
  const conn = db!

  await conn.unsafe(`
    drop table if exists public.${TEAMS} cascade;
    drop table if exists public.${OPEN} cascade;
    drop table if exists public.${MEMBERS} cascade;
    create table public.${MEMBERS} (
      user_id uuid not null,
      team_id uuid not null,
      primary key (user_id, team_id)
    );
    alter table public.${MEMBERS} enable row level security;
    revoke all on public.${MEMBERS} from anon, authenticated;

    create or replace function public._grant_is_member(p_team uuid) returns boolean
      language sql security definer set search_path = '' stable as $$
      select exists (
        select 1 from public.${MEMBERS} m
        where m.user_id = (select auth.uid()) and m.team_id = p_team
      ) $$;
    grant execute on function public._grant_is_member(uuid) to authenticated;

    create table public.${TEAMS} (
      id uuid primary key,
      team_id uuid not null,
      title text not null,
      status text not null default 'open',
      private_to uuid
    );
    alter table public.${TEAMS} enable row level security;
    grant select, insert, update, delete on public.${TEAMS} to authenticated;
    create policy g_all on public.${TEAMS} for all to authenticated
      using (public._grant_is_member(team_id) and (private_to is null or private_to = (select auth.uid())))
      with check (public._grant_is_member(team_id));

    create table public.${OPEN} (
      id uuid primary key,
      title text not null
    );
    alter table public.${OPEN} enable row level security;
    grant select, insert, update, delete on public.${OPEN} to authenticated;
    create policy o_all on public.${OPEN} for all to authenticated using (true) with check (true);
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
      (${OPEN}, 'read-write', null, 1, false)
    on conflict (table_name) do update
      set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
}

async function cleanup(): Promise<void> {
  const conn = db!

  await conn.unsafe(`drop table if exists public.${TEAMS} cascade`)
  await conn.unsafe(`drop table if exists public.${OPEN} cascade`)
  await conn.unsafe(`drop table if exists public.${MEMBERS} cascade`)
  await conn.unsafe(`drop function if exists public._grant_is_member(uuid)`)

  for (const table of TABLES) {
    await conn`delete from kizunasync._changelog where table_name = ${table}`
    await conn`delete from kizunasync._tombstones where table_name = ${table}`
    await conn`delete from kizunasync._bucket_grants where table_name = ${table}`
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

async function insertRow(team: string, title: string, pk = uid(), privateTo: string | null = null): Promise<string> {
  await db!.unsafe(`insert into public.${TEAMS} (id, team_id, title, private_to) values ($1, $2, $3, $4)`, [pk, team, title, privateTo])

  return pk
}

async function insertOpen(title: string): Promise<string> {
  const pk = uid()

  await db!.unsafe(`insert into public.${OPEN} (id, title) values ($1, $2)`, [pk, title])

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

async function grantsOf(user: string): Promise<TGrant[]> {
  return db!<TGrant[]>`
    select table_name, bucket_value from kizunasync._bucket_grants
    where user_id = ${user}::uuid order by table_name, bucket_value`
}

/** Runs `fn` under the caller's JWT and role in a transaction of its own, which it commits, so a pull's grants persist. */
async function asUser<T>(sub: string, fn: (w: SQL) => Promise<T>): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`

    try {
      await w`select set_config('request.jwt.claims', ${claims(sub)}, true)`
      await w`set local role authenticated`
      const out = await fn(w as unknown as SQL)

      await w`commit`

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

const teamBucket = (team: string, extra: Record<string, string> = {}): TBucket => ({ table: TEAMS, params: { team_id: team, ...extra } })
const openBucket: TBucket = { table: OPEN, params: {} }

async function pullAs(sub: string, buckets: TBucket[], cursor: string, limit = 500): Promise<TPullResp> {
  return asUser(sub, async (w) => {
    const [r] = await w<{ resp: TPullResp }[]>`select kizunasync.pull(${buckets}::jsonb, ${cursor}, 1, ${limit}) as resp`

    return r.resp
  })
}

async function pushAs(sub: string, mutations: TMutation[]): Promise<TVerdict[]> {
  const batch = {
    atomic: false,
    mutations: mutations.map((mutation) => ({ mutation_id: uid(), table: TEAMS, columns: {}, ...mutation })),
  }

  return asUser(sub, async (w) => {
    const [r] = await w<{ resp: { verdicts: TVerdict[] } }[]>`select kizunasync.push(${batch}::jsonb, null::uuid, 1) as resp`

    return r.resp.verdicts
  })
}

const rowPks = (page: TPullResp): string[] => page.rows.map((row) => row.pk)
const tombstonePks = (page: TPullResp): string[] => page.tombstones.map((tombstone) => tombstone.pk)
const page = (response: TPullResp): { rows: string[]; tombstones: string[] } => ({ rows: rowPks(response), tombstones: tombstonePks(response) })
const answers = (verdicts: TVerdict[]): Array<{ verdict: string; reason?: string; server_row?: unknown }> =>
  verdicts.map(({ verdict, reason, server_row }) => ({ verdict, reason, server_row }))

// MARK: - Grants

describe.skipIf(!reachable)('a pull records a grant for every bucket value it delivers a live row from', () => {
  test('a delivered row grants its bucket value, an unbucketed one the empty string, and a withheld row nothing', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const base = await sequenceTop()

    await insertRow(teamA, 'mine')
    await insertRow(teamB, 'hidden from alice')
    await insertOpen('shared')
    const response = await pullAs(alice, [teamBucket(teamA), teamBucket(teamB), openBucket], base)

    expect(response.rows).toHaveLength(2)
    expect(await grantsOf(alice)).toEqual([
      { table_name: OPEN, bucket_value: '' },
      { table_name: TEAMS, bucket_value: teamA },
    ])
  })

  test('a page that stops at its limit grants only the rows it carries', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA, teamB)
    const base = await sequenceTop()
    const first = await insertRow(teamA, 'first')

    await insertRow(teamB, 'past the limit')
    const response = await pullAs(alice, [teamBucket(teamA), teamBucket(teamB)], base, 1)

    expect({ rows: rowPks(response), has_more: response.has_more }).toEqual({ rows: [first], has_more: true })
    expect(await grantsOf(alice)).toEqual([{ table_name: TEAMS, bucket_value: teamA }])
  })
})

// MARK: - Delivery

describe.skipIf(!reachable)('a tombstone reaches only a caller who holds a grant for its bucket value', () => {
  test('a first pull that never received a live row of the bucket receives no tombstone, and the cursor still passes it', async () => {
    const team = uid()
    const alice = await mintMember(team)
    const base = await sequenceTop()
    const pk = await insertRow(team, 'gone before alice pulled')

    await deleteRow(TEAMS, pk)
    const top = await sequenceTop()
    const response = await pullAs(alice, [teamBucket(team)], base)

    expect(page(response)).toEqual({ rows: [], tombstones: [] })
    expect(BigInt(response.cursor) >= BigInt(top)).toBe(true)
  })

  test('a member who received a live row receives its delete', async () => {
    const team = uid()
    const alice = await mintMember(team)
    const base = await sequenceTop()
    const pk = await insertRow(team, 'doomed')
    const first = await pullAs(alice, [teamBucket(team)], base)

    await deleteRow(TEAMS, pk)
    const second = await pullAs(alice, [teamBucket(team)], first.cursor)

    expect(page(first)).toEqual({ rows: [pk], tombstones: [] })
    expect(page(second)).toEqual({ rows: [], tombstones: [pk] })
  })

  test('a foreign bucket value gets no tombstone', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const bob = await mintMember(teamB)
    const base = await sequenceTop()
    const pk = await insertRow(teamA, 'tenant a')

    await insertRow(teamB, 'tenant b')
    await pullAs(alice, [teamBucket(teamA)], base)
    const bobFirst = await pullAs(bob, [teamBucket(teamA), teamBucket(teamB)], base)

    await deleteRow(TEAMS, pk)
    const bobSecond = await pullAs(bob, [teamBucket(teamA), teamBucket(teamB)], bobFirst.cursor)
    const aliceSecond = await pullAs(alice, [teamBucket(teamA)], base)

    expect(tombstonePks(bobSecond)).toEqual([])
    expect(await grantsOf(bob)).toEqual([{ table_name: TEAMS, bucket_value: teamB }])
    expect(tombstonePks(aliceSecond)).toEqual([pk])
  })

  test('an unbucketed table delivers a delete to a caller who received any live row of it, and to no one else', async () => {
    const [alice, bob] = [await mintMember(), await mintMember()]
    const base = await sequenceTop()

    await insertOpen('seen by alice')
    const aliceFirst = await pullAs(alice, [openBucket], base)
    const pk = await insertOpen('inserted and deleted between pulls')

    await deleteRow(OPEN, pk)
    const aliceSecond = await pullAs(alice, [openBucket], aliceFirst.cursor)
    const bobFirst = await pullAs(bob, [openBucket], aliceFirst.cursor)

    expect(tombstonePks(aliceSecond)).toEqual([pk])
    expect(tombstonePks(bobFirst)).toEqual([])
  })

  test('a bucket that names extra params receives deletes, since tombstones match the bucket column alone', async () => {
    const team = uid()
    const alice = await mintMember(team)
    const base = await sequenceTop()
    const pk = await insertRow(team, 'open item')
    const bucket = teamBucket(team, { status: 'open' })
    const first = await pullAs(alice, [bucket], base)

    await deleteRow(TEAMS, pk)
    const second = await pullAs(alice, [bucket], first.cursor)

    expect(page(first)).toEqual({ rows: [pk], tombstones: [] })
    expect(page(second)).toEqual({ rows: [], tombstones: [pk] })
  })
})

// MARK: - Move-out and recreate

describe.skipIf(!reachable)('a tombstone is withheld while the row is deliverable to the caller', () => {
  test('a move-out removes the row for an old-bucket-only device and keeps it for a device that pulls both buckets', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const alice = await mintMember(teamA)
    const carol = await mintMember(teamA, teamB)
    const base = await sequenceTop()
    const pk = await insertRow(teamA, 'moving')
    const aliceFirst = await pullAs(alice, [teamBucket(teamA)], base)
    const carolFirst = await pullAs(carol, [teamBucket(teamA), teamBucket(teamB)], base)

    await moveRow(pk, teamB)
    const aliceSecond = await pullAs(alice, [teamBucket(teamA)], aliceFirst.cursor)
    const carolSecond = await pullAs(carol, [teamBucket(teamA), teamBucket(teamB)], carolFirst.cursor)

    expect(page(aliceSecond)).toEqual({ rows: [], tombstones: [pk] })
    expect(page(carolSecond)).toEqual({ rows: [pk], tombstones: [] })
  })

  test('a caller who cannot see a recreated row gets the tombstone, and one who can gets the row', async () => {
    const team = uid()
    const alice = await mintMember(team)
    const bob = await mintMember(team)
    const base = await sequenceTop()
    const pk = await insertRow(team, 'first life')
    const aliceFirst = await pullAs(alice, [teamBucket(team)], base)
    const bobFirst = await pullAs(bob, [teamBucket(team)], base)

    await deleteRow(TEAMS, pk)
    await insertRow(team, 'second life, private to bob', pk, bob)
    const aliceSecond = await pullAs(alice, [teamBucket(team)], aliceFirst.cursor)
    const bobSecond = await pullAs(bob, [teamBucket(team)], bobFirst.cursor)

    expect(page(aliceSecond)).toEqual({ rows: [], tombstones: [pk] })
    expect(page(bobSecond)).toEqual({ rows: [pk], tombstones: [] })
  })
})

// MARK: - DELETE_WINS

describe.skipIf(!reachable)('a committed tombstone answers DELETE_WINS only to a caller who holds a grant for its bucket value', () => {
  test('with a grant every op answers DELETE_WINS, and without one RLS_DENIED, both with no row', async () => {
    const team = uid()
    const carol = await mintMember(team)
    const dave = await mintMember(team)
    const base = await sequenceTop()
    const pk = await insertRow(team, 'deleted under both')

    await pullAs(carol, [teamBucket(team)], base)
    await deleteRow(TEAMS, pk)
    const ops: TMutation[] = [
      { op: 'update', pk, columns: { title: 'too late' } },
      { op: 'insert', pk, columns: { team_id: team, title: 'again' } },
      { op: 'delete', pk },
    ]
    const withGrant = await pushAs(carol, ops)
    const withoutGrant = await pushAs(dave, ops)

    expect(answers(withGrant)).toEqual(ops.map(() => ({ verdict: 'rejected', reason: 'DELETE_WINS', server_row: null })))
    expect(answers(withoutGrant)).toEqual(ops.map(() => ({ verdict: 'rejected', reason: 'RLS_DENIED', server_row: null })))
    expect(await grantsOf(dave)).toEqual([])
  })

  test('a delete the same push queued earlier answers DELETE_WINS without any grant', async () => {
    const team = uid()
    const dave = await mintMember(team)
    const pk = await insertRow(team, 'deleted in the batch')
    const verdicts = await pushAs(dave, [
      { op: 'delete', pk },
      { op: 'update', pk, columns: { title: 'too late' } },
    ])

    expect(await grantsOf(dave)).toEqual([])
    expect(answers(verdicts)).toEqual([
      { verdict: 'applied', reason: undefined, server_row: undefined },
      { verdict: 'rejected', reason: 'DELETE_WINS', server_row: null },
    ])
  })

  test('a moved and then deleted row answers by the grant for the bucket value it was deleted from', async () => {
    const [teamA, teamB] = [uid(), uid()]
    const carol = await mintMember(teamA, teamB)
    const erin = await mintMember(teamA, teamB)
    const base = await sequenceTop()
    const pk = await insertRow(teamA, 'moved then deleted')

    await pullAs(carol, [teamBucket(teamA)], base)
    await moveRow(pk, teamB)
    await pullAs(erin, [teamBucket(teamB)], base)
    await deleteRow(TEAMS, pk)
    const [fromA] = await pushAs(carol, [{ op: 'update', pk, columns: { title: 'from a' } }])
    const [fromB] = await pushAs(erin, [{ op: 'update', pk, columns: { title: 'from b' } }])

    expect({ reason: fromA?.reason, server_row: fromA?.server_row }).toEqual({ reason: 'RLS_DENIED', server_row: null })
    expect({ reason: fromB?.reason, server_row: fromB?.server_row }).toEqual({ reason: 'DELETE_WINS', server_row: null })
  })
})
