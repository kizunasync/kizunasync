/**
 * Delivery under sustained concurrent pushes, against real Postgres. Writer
 * sessions push one to twenty inserts per transaction while two pullers each
 * follow their own saved cursor chain, for about ten seconds. Once the writers
 * stop and every transaction has ended, each puller drains its saved cursor to a
 * stable token, and every primary key the writers committed must have reached
 * every puller. A drain from `0` is the control.
 *
 * The run writes to a synced table of its own, registered the way `kizunasync init`
 * registers one, so its doorbells stay off the `kizunasync:todos` topic the demo
 * apps subscribe to. The table, its registration, and every bookkeeping row it
 * produced are removed at the end. The run holds WRITERS + PULLERS + 2
 * connections, well under a local max_connections. Skips loudly when no DB is
 * reachable.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const WRITERS = 6
const PULLERS = 2
const RUN_MS = 10_000
const MAX_ROWS_PER_PUSH = 20
const FIXTURE_TABLE = '_pull_fencing_stress'

/** The limit a client pulls with, which the pullers and the control drain keep. */
const PULLER_PAGE_LIMIT = 500

/** A drain stops at a stable token; this only bounds a broken build. */
const MAX_DRAIN_PAGES = 1_000

const TEST_TIMEOUT_MS = 180_000

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-fencing-stress] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
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

interface IVerdict {
  mutation_id: string
  verdict: 'applied' | 'rejected'
}

/** What the writers did: the pks whose insert committed, every mutation id sent, and any push that raised. */
interface IWriteLog {
  committed: Set<string>
  mutationIds: Set<string>
  pushes: number
  errors: string[]
}

/** Bun binds a JS array as a JSON scalar; the Postgres text form `{a,b}` casts cleanly to uuid[]. */
const uuidArray = (ids: Iterable<string>): string => `{${[...ids].join(',')}}`

/**
 * The fixture table with every column the push path writes, readable by every
 * signed-in session and insertable as yourself, plus the two capture triggers
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
    create policy pfs_all on public.${FIXTURE_TABLE} for all to authenticated
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

async function dropFixture(conn: SQL, mutationIds: Set<string>): Promise<void> {
  await conn.unsafe(`drop table if exists public.${FIXTURE_TABLE} cascade`)
  await conn`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._tombstones where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._bucket_grants where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._verdicts where mutation_id = any(${uuidArray(mutationIds)}::uuid[])`
}

async function beginAs(conn: TConn, user: string): Promise<void> {
  await conn`begin`
  await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: 'authenticated' })}, true)`
  await conn`set local role authenticated`
}

async function pullOn(conn: TConn, input: { user: string; cursor: string; limit: number }): Promise<IPullPage> {
  await beginAs(conn, input.user)
  const [row] = await conn`select kizunasync.pull(${[{ table: FIXTURE_TABLE }]}::jsonb, ${input.cursor}, 1, ${input.limit}) as resp`

  await conn`commit`

  return row.resp as IPullPage
}

/** Pulls from `cursor` until a final page hands back the cursor it was given, collecting every delivered pk. */
async function drainToStable(conn: TConn, input: { user: string; cursor: string; limit: number; delivered: Set<string> }): Promise<string> {
  let current = input.cursor

  for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
    const response = await pullOn(conn, { user: input.user, cursor: current, limit: input.limit })

    for (const row of response.rows) {
      input.delivered.add(row.pk)
    }

    if (!response.has_more && response.cursor === current) {
      return current
    }
    current = response.cursor
  }

  throw new Error(`the drain from ${input.cursor} never reached a stable token`)
}

async function withSession<T>(body: (conn: TConn) => Promise<T>): Promise<T> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  try {
    return await body(conn)
  } finally {
    conn.release()
    await pool.end()
  }
}

async function runWriter(input: { user: string; deadline: number; log: IWriteLog }): Promise<void> {
  await withSession(async (conn) => {
    while (Date.now() < input.deadline) {
      const mutations = Array.from({ length: 1 + Math.floor(Math.random() * MAX_ROWS_PER_PUSH) }, () => ({
        mutation_id: crypto.randomUUID(),
        table: FIXTURE_TABLE,
        pk: crypto.randomUUID(),
        op: 'insert',
        columns: { title: 'stress', user_id: input.user },
      }))

      for (const mutation of mutations) {
        input.log.mutationIds.add(mutation.mutation_id)
      }

      try {
        await beginAs(conn, input.user)
        const [row] = await conn`select kizunasync.push(${{ atomic: false, mutations }}::jsonb, null::uuid, 1) as resp`

        await conn`commit`
        const applied = new Set(
          (row.resp as { verdicts: IVerdict[] }).verdicts.filter((verdict) => verdict.verdict === 'applied').map((verdict) => verdict.mutation_id),
        )

        for (const mutation of mutations.filter((candidate) => applied.has(candidate.mutation_id))) {
          input.log.committed.add(mutation.pk)
        }
        input.log.pushes += 1
      } catch (error) {
        input.log.errors.push(String(error))
        await conn`rollback`.catch(() => undefined)
      }
    }
  })
}

/** Follows one saved cursor chain while the writers run, then drains that saved cursor to a stable token. */
async function followCursor(input: { user: string; base: string; isWriting: () => boolean }): Promise<{ delivered: Set<string>; cursor: string; pulls: number }> {
  return withSession(async (conn) => {
    const delivered = new Set<string>()
    let saved = input.base
    let pulls = 0

    while (input.isWriting()) {
      const response = await pullOn(conn, { user: input.user, cursor: saved, limit: PULLER_PAGE_LIMIT })

      for (const row of response.rows) {
        delivered.add(row.pk)
      }
      saved = response.cursor
      pulls += 1
    }

    return { delivered, cursor: await drainToStable(conn, { user: input.user, cursor: saved, limit: PULLER_PAGE_LIMIT, delivered }), pulls }
  })
}

const missingFrom = (committed: Set<string>, delivered: Set<string>): { missing: number; sample: string[] } => {
  const missing = [...committed].filter((pk) => !delivered.has(pk))

  return { missing: missing.length, sample: missing.slice(0, 5) }
}

describe.skipIf(!reachable)('pull delivers every commit under sustained concurrent pushes', () => {
  test(`${WRITERS} writers pushing 1 to ${MAX_ROWS_PER_PUSH} inserts per transaction lose nothing to ${PULLERS} pullers`, async () => {
    const conn = db!
    // The fixture table has no foreign key to auth.users, so a session needs only the jwt `sub` it signs in with.
    const writerUsers = Array.from({ length: WRITERS }, () => crypto.randomUUID())
    const pullerUsers = Array.from({ length: PULLERS }, () => crypto.randomUUID())
    const log: IWriteLog = { committed: new Set(), mutationIds: new Set(), pushes: 0, errors: [] }

    try {
      await provisionFixture(conn)
      const [top] = await conn`
        select coalesce(max(seq), 0)::text as seq
        from (select seq from kizunasync._changelog union all select seq from kizunasync._tombstones) s`
      const base = top.seq as string
      const deadline = Date.now() + RUN_MS
      let writing = true
      const chains = pullerUsers.map((user) => followCursor({ user, base, isWriting: () => writing }))

      await Promise.all(writerUsers.map((user) => runWriter({ user, deadline, log })))
      writing = false
      const followed = await Promise.all(chains)
      const control = new Set<string>()

      await withSession((session) =>
        drainToStable(session, { user: pullerUsers[0] as string, cursor: '0', limit: PULLER_PAGE_LIMIT, delivered: control }),
      )
      const stored = await conn.unsafe(`select id::text as id from public.${FIXTURE_TABLE}`)
      const summary = {
        pushes: log.pushes,
        committed: log.committed.size,
        pulls: followed.map((chain) => chain.pulls),
        cursors: followed.map((chain) => chain.cursor),
      }

      console.log(`[pull-fencing-stress] ${JSON.stringify(summary)}`)
      expect(log.errors).toEqual([])
      expect(log.committed.size).toBeGreaterThan(0)
      expect(new Set(stored.map((row: { id: string }) => row.id))).toEqual(log.committed)
      expect(missingFrom(log.committed, control), 'control: a drain from 0 sees every committed row').toEqual({ missing: 0, sample: [] })

      for (const [index, chain] of followed.entries()) {
        expect(missingFrom(log.committed, chain.delivered), `puller ${index} missed committed rows`).toEqual({ missing: 0, sample: [] })
      }
    } finally {
      await dropFixture(conn, log.mutationIds)
    }
  }, TEST_TIMEOUT_MS)
})
