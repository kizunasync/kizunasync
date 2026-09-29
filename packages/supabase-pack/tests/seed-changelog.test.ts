/**
 * Seeding the changelog of a table whose rows predate its provisioning, against
 * live Postgres. `kizunasync._seed_changelog(table)` queues one upsert, labeled
 * with the row's bucket value, for every row of a configured table that has no
 * changelog entry, and the commit-time stamp numbers them like any other write,
 * so a bootstrap pull delivers rows that were inserted before the triggers
 * existed. A second call, in the same transaction or a later one, queues
 * nothing.
 *
 * The fixture is a bucketed and an unbucketed table, each given rows before it
 * is configured, then provisioned in one transaction the way a migration does
 * it: the `_config` row, the two capture triggers, and the seed. Both tables are
 * dropped with every bookkeeping row they produced. Skips loudly when Postgres
 * is unreachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const TEAMS = '_seed_teams'
const OPEN = '_seed_open'
const TABLES = [TEAMS, OPEN] as const
const EXAMPLE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/0002_example.sql'),
  'utf8',
)

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[seed-changelog] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TBucket = { table: string; params: Record<string, string> }
type TRow = { pk: string; row: Record<string, unknown>; seq: string; table: string }
type TPullResp = { cursor: string; has_more: boolean; rows: TRow[]; signal: unknown; tombstones: unknown[] }
type TEntry = { pk: string; seq: string; bucket_value: string | null; xid: string }

// MARK: - Fixture

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })
const TEAM_A = uid()
const TEAM_B = uid()
const teamA = [uid(), uid(), uid()]
const teamB = [uid(), uid()]
const open = [uid(), uid()]
const provisioned = { teams: '', teamsAgain: '', open: '', xid: '', top: '' }

async function createTables(): Promise<void> {
  await db!.unsafe(`
    drop table if exists public.${TEAMS} cascade;
    drop table if exists public.${OPEN} cascade;
    create table public.${TEAMS} (
      id uuid primary key,
      team_id uuid not null,
      title text not null
    );
    alter table public.${TEAMS} enable row level security;
    grant select, insert, update, delete on public.${TEAMS} to authenticated;
    create policy s_all on public.${TEAMS} for all to authenticated using (true) with check (true);

    create table public.${OPEN} (
      id uuid primary key,
      title text not null
    );
    alter table public.${OPEN} enable row level security;
    grant select, insert, update, delete on public.${OPEN} to authenticated;
    create policy o_all on public.${OPEN} for all to authenticated using (true) with check (true);
  `)
}

async function insertUnsynced(): Promise<void> {
  for (const pk of teamA) {
    await db!.unsafe(`insert into public.${TEAMS} (id, team_id, title) values ($1, $2, 'before')`, [pk, TEAM_A])
  }
  for (const pk of teamB) {
    await db!.unsafe(`insert into public.${TEAMS} (id, team_id, title) values ($1, $2, 'before')`, [pk, TEAM_B])
  }
  for (const pk of open) {
    await db!.unsafe(`insert into public.${OPEN} (id, title) values ($1, 'before')`, [pk])
  }
}

/** One transaction, as a provisioning migration runs: config, triggers, then the seed, called twice on the bucketed table. */
async function provision(): Promise<void> {
  const [top] = await db!`select coalesce(max(seq), 0)::text as seq from kizunasync._changelog`

  provisioned.top = top.seq as string
  await db!.begin(async (tx) => {
    await tx`
      insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
      values (${TEAMS}, 'read-write', 'team_id', 1, false), (${OPEN}, 'read-write', null, 1, false)
      on conflict (table_name) do update
        set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`

    for (const table of TABLES) {
      await tx.unsafe(`
        create trigger kizunasync_track_change after insert or update on public.${table}
          for each row execute function kizunasync.track_change();
        create trigger kizunasync_track_delete after delete on public.${table}
          for each row execute function kizunasync.track_delete();
      `)
    }
    const [teams] = await tx`select kizunasync._seed_changelog(${TEAMS})::text as queued`
    const [teamsAgain] = await tx`select kizunasync._seed_changelog(${TEAMS})::text as queued`
    const [opened] = await tx`select kizunasync._seed_changelog(${OPEN})::text as queued`
    const [xid] = await tx`select pg_current_xact_id()::text as xid`

    provisioned.teams = teams.queued as string
    provisioned.teamsAgain = teamsAgain.queued as string
    provisioned.open = opened.queued as string
    provisioned.xid = xid.xid as string
  })
}

async function cleanup(): Promise<void> {
  await db!.unsafe(`drop table if exists public.${TEAMS} cascade`)
  await db!.unsafe(`drop table if exists public.${OPEN} cascade`)

  for (const table of TABLES) {
    await db!`delete from kizunasync._changelog where table_name = ${table}`
    await db!`delete from kizunasync._tombstones where table_name = ${table}`
    await db!`delete from kizunasync._bucket_grants where table_name = ${table}`
    await db!`delete from kizunasync._config where table_name = ${table}`
  }
}

beforeAll(async () => {
  if (reachable) {
    await createTables()
    await insertUnsynced()
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

async function entriesOf(table: string): Promise<TEntry[]> {
  return db!<TEntry[]>`
    select cl.pk::text as pk, cl.seq::text as seq, cl.bucket_value, cl.xid::text as xid
    from kizunasync._changelog cl where cl.table_name = ${table} order by cl.seq`
}

/** A bootstrap pull under a fresh caller's JWT, rolled back so it leaves no grant behind. */
async function bootstrap(buckets: TBucket[]): Promise<TPullResp> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`
    await w`select set_config('request.jwt.claims', ${claims(uid())}, true)`
    await w`set local role authenticated`
    const [r] = await w<{ resp: TPullResp }[]>`select kizunasync.pull(${buckets}::jsonb, '0', 1, 500) as resp`

    await w`rollback`

    return r.resp
  } finally {
    w.release()
    await pool.end()
  }
}

const pksOf = (page: TPullResp, table: string): string[] =>
  page.rows.filter((row) => row.table === table).map((row) => row.pk).sort()

// MARK: - Seeding

describe.skipIf(!reachable)('kizunasync._seed_changelog', () => {
  test('rows inserted before provisioning arrive on a bootstrap pull', async () => {
    const page = await bootstrap([
      { table: TEAMS, params: { team_id: TEAM_A } },
      { table: OPEN, params: {} },
    ])

    expect(page.signal).toBeNull()
    expect(page.has_more).toBe(false)
    expect(pksOf(page, TEAMS)).toEqual([...teamA].sort())
    expect(pksOf(page, OPEN)).toEqual([...open].sort())
    expect(page.rows.find((row) => row.pk === teamA[0])?.row).toEqual({ id: teamA[0], team_id: TEAM_A, title: 'before' })
  })

  test('each seeded row is one upsert labeled with its bucket value, numbered by the provisioning commit', async () => {
    const teams = await entriesOf(TEAMS)
    const opened = await entriesOf(OPEN)
    const labelOf = new Map(teams.map((entry) => [entry.pk, entry.bucket_value]))

    expect(provisioned.teams).toBe(String(teamA.length + teamB.length))
    expect(provisioned.open).toBe(String(open.length))
    expect(teams.map((entry) => entry.pk).sort()).toEqual([...teamA, ...teamB].sort())
    expect(opened.map((entry) => entry.pk).sort()).toEqual([...open].sort())

    for (const pk of teamA) {
      expect(labelOf.get(pk)).toBe(TEAM_A)
    }
    for (const pk of teamB) {
      expect(labelOf.get(pk)).toBe(TEAM_B)
    }
    expect(opened.every((entry) => entry.bucket_value === null)).toBe(true)
    expect([...teams, ...opened].every((entry) => entry.xid === provisioned.xid)).toBe(true)
    expect([...teams, ...opened].every((entry) => BigInt(entry.seq) > BigInt(provisioned.top))).toBe(true)
  })

  test('a second call in the same transaction queues nothing', () => {
    expect(provisioned.teamsAgain).toBe('0')
  })

  test('a later call queues nothing, and a row the triggers already logged is not seeded again', async () => {
    const written = uid()

    await db!.unsafe(`insert into public.${TEAMS} (id, team_id, title) values ($1, $2, 'after')`, [written, TEAM_B])
    const [again] = await db!`select kizunasync._seed_changelog(${TEAMS})::text as queued`
    const [openAgain] = await db!`select kizunasync._seed_changelog(${OPEN})::text as queued`
    const entries = await entriesOf(TEAMS)

    expect(again.queued).toBe('0')
    expect(openAgain.queued).toBe('0')
    expect(entries.filter((entry) => entry.pk === written)).toHaveLength(1)
    expect(entries).toHaveLength(teamA.length + teamB.length + 1)
  })

  test('a table with no _config row is refused with 0A000', async () => {
    let failure: { sqlstate: unknown; message: string } | null = null

    try {
      await db!`select kizunasync._seed_changelog('_seed_not_configured')`
    } catch (error) {
      failure = {
        sqlstate: error instanceof Error && 'errno' in error ? error.errno : undefined,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    expect(failure?.sqlstate).toBe('0A000')
    expect(failure?.message).toContain('_seed_not_configured')
  })

  test('a call carrying a client JWT is refused with 42501', async () => {
    let sqlstate: unknown = null

    try {
      await db!.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${claims(uid())}, true)`
        await tx`select kizunasync._seed_changelog(${OPEN})`
      })
    } catch (error) {
      sqlstate = error instanceof Error && 'errno' in error ? error.errno : undefined
    }
    expect(sqlstate).toBe('42501')
  })
})

describe('the example migration', () => {
  test('0002_example.sql seeds public.todos after it attaches the capture triggers', () => {
    const seed = EXAMPLE.indexOf("select kizunasync._seed_changelog('todos');")

    expect(seed).toBeGreaterThan(-1)
    expect(seed).toBeGreaterThan(EXAMPLE.indexOf('create trigger kizunasync_track_change'))
    expect(seed).toBeGreaterThan(EXAMPLE.indexOf('create trigger kizunasync_track_delete'))
  })
})
