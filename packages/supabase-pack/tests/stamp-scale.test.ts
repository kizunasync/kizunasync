/**
 * Large transactions against live Postgres: seeding a table of 2,000,000 rows
 * and one transaction that writes 1,000,000 synced rows both complete, because
 * neither holds a trigger event per row until commit. The seed numbers every
 * row in one statement under the stamp's advisory lock; the write queues its
 * changes and the once-per-transaction stamp numbers them in queue order.
 * Every row ends with exactly one changelog entry, and the entries' seqs are
 * distinct and contiguous.
 *
 * While each transaction runs, a sampler reads the backend's private resident
 * memory (RssAnon) from the local stack's container (KSYNC_DB_CONTAINER) and
 * prints the peak. The seed's peak must stay under PEAK_CEILING_KB once the
 * sampler has read MIN_SAMPLES values; with fewer, the run only reports it.
 * The file runs through the pack's `test:scale` script, never the default
 * `test` script. Both tables are dropped with every bookkeeping row they
 * produced. Skips loudly when Postgres is unreachable.
 *
 * The write case first commits a small synced write and analyzes
 * `_change_pending`, so it starts from the statistics a busy project has, with
 * the queue recorded as empty; both commits run under a watchdog that cancels
 * the backend inside the test's own timeout, so a stall ends the transaction
 * instead of holding locks past it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { commitWithin } from './commit-watchdog'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const CONTAINER = process.env.KSYNC_DB_CONTAINER ?? 'supabase_db_kizunasync'
const SEEDED = '_stamp_scale_seed'
const WRITTEN = '_stamp_scale_write'
const WARM = '_stamp_scale_warm'
const SEED_ROWS = 2_000_000
const WRITE_ROWS = 1_000_000
const WARM_ROWS = 2_000
const SAMPLE_MS = 200
const MIN_SAMPLES = 10
const PEAK_CEILING_KB = 200 * 1024
const SCALE_TIMEOUT_MS = 900_000
const COMMIT_BUDGET_MS = SCALE_TIMEOUT_MS - 60_000

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[stamp-scale] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    if (reachable) {
      await dropTable(SEEDED)
      await dropTable(WRITTEN)
      await dropTable(WARM)
    }
    await db.end()
  }
})

// MARK: - Helpers

type TSpan = { rows: number; seqs: number; pks: number; contiguous: boolean; aboveTop: boolean }

async function dropTable(table: string): Promise<void> {
  await db!.unsafe(`drop table if exists public.${table} cascade`)

  for (const ledger of ['_changelog', '_tombstones', '_change_pending', '_config']) {
    await db!.unsafe(`delete from kizunasync.${ledger} where table_name = $1`, [table])
  }
}

async function sequenceTop(): Promise<bigint> {
  const [row] = await db!`select coalesce(max(seq), 0)::text as seq from kizunasync._changelog`

  return BigInt(row.seq as string)
}

/** The changelog entries of `table`: how many, how many distinct seqs and pks, and whether the seqs form one contiguous block above `top`. */
async function spanOf(table: string, top: bigint): Promise<TSpan> {
  const [row] = await db!`
    select count(*)::int as rows, count(distinct seq)::int as seqs, count(distinct pk)::int as pks,
           (max(seq) - min(seq) + 1) = count(*) as contiguous, min(seq) > ${top.toString()}::bigint as above_top
      from kizunasync._changelog where table_name = ${table}`

  return { rows: row.rows, seqs: row.seqs, pks: row.pks, contiguous: row.contiguous, aboveTop: row.above_top } as TSpan
}

type TMemory = { peakKb: number | null; samples: number }

/** Reads the backend's RssAnon (kB) through the stack container every SAMPLE_MS until stopped; stopping kills a read still in flight, so a slow Docker never holds the test. */
function sampleMemory(pid: number): { stop: () => Promise<TMemory> } {
  let running = true
  let peakKb: number | null = null
  let samples = 0
  let inFlight: ReturnType<typeof Bun.spawn> | null = null
  const loop = (async () => {
    while (running) {
      try {
        inFlight = Bun.spawn(['docker', 'exec', CONTAINER, 'grep', 'RssAnon', `/proc/${pid}/status`], { stdout: 'pipe', stderr: 'ignore' })
        const text = await new Response(inFlight.stdout as ReadableStream).text()
        const kb = Number(text.match(/(\d+)\s*kB/)?.[1])

        if (Number.isFinite(kb)) {
          peakKb = Math.max(peakKb ?? 0, kb)
          samples += 1
        }
      } catch {
        return
      }
      await Bun.sleep(SAMPLE_MS)
    }
  })()

  return {
    stop: async () => {
      running = false
      inFlight?.kill()
      await loop

      return { peakKb, samples }
    },
  }
}

/** Runs `work` in one transaction on a reserved connection while sampling that backend's memory. */
async function inSampledTransaction(work: (conn: SQL) => Promise<void>): Promise<{ ms: number } & TMemory> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  try {
    const [row] = await conn`select pg_backend_pid() as pid`
    const sampler = sampleMemory(Number(row.pid))
    const started = performance.now()

    await conn`begin`
    await work(conn as unknown as SQL)
    await commitWithin({ conn, admin: db!, pid: Number(row.pid), ms: COMMIT_BUDGET_MS })
    const ms = Math.round(performance.now() - started)

    return { ms, ...(await sampler.stop()) }
  } finally {
    conn.release()
    await pool.end()
  }
}

// MARK: - Cases

describe.skipIf(!reachable)('large transactions hold no per-row trigger event', () => {
  test(`seeding a table of ${SEED_ROWS} rows logs each row once, in one contiguous block`, async () => {
    await dropTable(SEEDED)
    await db!.unsafe(`
      create table public.${SEEDED} (id bigint primary key, owner_id uuid not null, title text not null);
      insert into public.${SEEDED} (id, owner_id, title)
      select g, '00000000-0000-4000-8000-000000000001', 'row ' || g from generate_series(1, ${SEED_ROWS}) as g;
    `)
    const top = await sequenceTop()
    let queued = ''
    const run = await inSampledTransaction(async (conn) => {
      await conn`
        insert into kizunasync._config (table_name, sync_mode, bucket_column, key_columns, min_schema_version, register_clients)
        values (${SEEDED}, 'pull-only', 'owner_id', '{id}', 1, false)`
      await conn.unsafe(`
        create trigger kizunasync_track_change after insert or update on public.${SEEDED}
          for each row execute function kizunasync.track_change();
        create trigger kizunasync_track_delete after delete on public.${SEEDED}
          for each row execute function kizunasync.track_delete();
      `)
      const [row] = await conn`select kizunasync._seed_changelog(${SEEDED})::text as queued`

      queued = row.queued as string
    })

    console.log(`[stamp-scale] seed of ${SEED_ROWS} rows: ${run.ms} ms, peak backend RssAnon ${run.peakKb ?? 'unavailable'} kB over ${run.samples} samples`)

    if (run.samples >= MIN_SAMPLES) {
      expect(run.peakKb ?? Number.POSITIVE_INFINITY).toBeLessThan(PEAK_CEILING_KB)
    } else {
      console.warn(`[stamp-scale] seed memory not asserted: ${run.samples} samples read from ${CONTAINER}`)
    }
    expect(queued).toBe(String(SEED_ROWS))
    expect(await spanOf(SEEDED, top)).toEqual({ rows: SEED_ROWS, seqs: SEED_ROWS, pks: SEED_ROWS, contiguous: true, aboveTop: true })
    await dropTable(SEEDED)
  }, SCALE_TIMEOUT_MS)

  test(`one transaction writing ${WRITE_ROWS} synced rows numbers them all, in the order it wrote them`, async () => {
    await dropTable(WRITTEN)
    await db!.unsafe(`
      create table public.${WRITTEN} (id bigint primary key, title text not null);
      create trigger kizunasync_track_change after insert or update on public.${WRITTEN}
        for each row execute function kizunasync.track_change();
      create trigger kizunasync_track_delete after delete on public.${WRITTEN}
        for each row execute function kizunasync.track_delete();
    `)
    await db!`
      insert into kizunasync._config (table_name, sync_mode, bucket_column, key_columns, min_schema_version, register_clients)
      values (${WRITTEN}, 'read-write', null, '{id}', 1, false)`
    await dropTable(WARM)
    await db!.unsafe(`
      create table public.${WARM} (id bigint primary key, title text not null);
      create trigger kizunasync_track_change after insert or update on public.${WARM}
        for each row execute function kizunasync.track_change();
      create trigger kizunasync_track_delete after delete on public.${WARM}
        for each row execute function kizunasync.track_delete();
    `)
    await db!`
      insert into kizunasync._config (table_name, sync_mode, bucket_column, key_columns, min_schema_version, register_clients)
      values (${WARM}, 'read-write', null, '{id}', 1, false)`
    await db!.unsafe(`insert into public.${WARM} (id, title) select g, 'warm ' || g from generate_series(1, ${WARM_ROWS}) as g`)
    await db!.unsafe('analyze kizunasync._change_pending')

    const [stats] = await db!`select reltuples::float8 as tuples, relpages::int as pages from pg_class where oid = 'kizunasync._change_pending'::regclass`

    expect(stats.tuples, 'precondition: _change_pending is analyzed as empty').toBe(0)
    expect(stats.pages, 'precondition: _change_pending keeps pages after the stamp emptied it').toBeGreaterThan(0)

    const top = await sequenceTop()
    const run = await inSampledTransaction(async (conn) => {
      await conn.unsafe(`insert into public.${WRITTEN} (id, title) select g, 'row ' || g from generate_series(1, ${WRITE_ROWS}) as g`)
    })
    const [order] = await db!`
      select count(*) filter (where previous >= seq)::int as inversions
        from (select seq, lag(seq) over (order by pk::bigint) as previous from kizunasync._changelog where table_name = ${WRITTEN}) entries`
    const [left] = await db!`
      select (select count(*) from kizunasync._change_pending)::int as pending, (select count(*) from kizunasync._stamp_marker)::int as markers`

    console.log(`[stamp-scale] one transaction of ${WRITE_ROWS} rows: ${run.ms} ms, peak backend RssAnon ${run.peakKb ?? 'unavailable'} kB over ${run.samples} samples`)
    expect(await spanOf(WRITTEN, top)).toEqual({ rows: WRITE_ROWS, seqs: WRITE_ROWS, pks: WRITE_ROWS, contiguous: true, aboveTop: true })
    expect(order.inversions).toBe(0)
    expect(left).toEqual({ pending: 0, markers: 0 })
    await dropTable(WRITTEN)
    await dropTable(WARM)
  }, SCALE_TIMEOUT_MS)
})
