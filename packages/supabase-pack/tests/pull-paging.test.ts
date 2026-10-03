/**
 * Pull paging against real Postgres. A page is a prefix of one stream: the
 * deliverable rows and tombstones together in `(seq, table, pk)` order, at most
 * `limit` entries counted together. A tombstone at the head of the stream rides
 * the first continuation page, an exact fit closes the checkpoint in one page,
 * no page exceeds the limit, and a drain across interleaved rows and tombstones
 * delivers every entry once, duplicate bucket entries included. A `limit` below
 * 1 is refused, and a null one pages at the default of 500. A page also stops
 * once it has examined `_settings.max_pull_scan` candidates, the rows it
 * withholds included, and continues from the last one it examined, so it can
 * carry fewer than `limit` entries while `has_more` stays true.
 *
 * Drives the public `kizunasync.pull` RPC on a synced table of its own, registered
 * the way `kizunasync init` registers one. Each test writes under a fresh bucket
 * value and pulls from the sequence top it read before writing, so no other row
 * reaches its pages. A test that deletes gives its owner the grant an earlier pull
 * of a live row in that bucket would have recorded, since a pull carries only the
 * tombstones of bucket values its caller holds a grant for. The table, its
 * registration, and every bookkeeping row it produced are removed at the end. Skips
 * loudly when no DB is reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const FIXTURE_TABLE = '_pull_paging'
const DRAIN_LIMITS = [1, 2, 3, 5, 500]
const DRAIN_SCAN_CAPS = [1, 2, 3]
const DEFAULT_MAX_PULL_SCAN = 5000

/** A drain stops at `has_more: false`; this only bounds a broken build. */
const MAX_DRAIN_PAGES = 200

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-paging] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

type TBucket = { table: string; params: Record<string, string> }
type TRow = { pk: string; row: { title?: string } & Record<string, unknown>; seq: string; table: string }
type TTombstone = { deleted_at: string; pk: string; seq: string; table: string }

interface IPullPage {
  cursor: string
  has_more: boolean
  rows: TRow[]
  signal: unknown
  tombstones: TTombstone[]
}

/** One delivered stream entry, keyed the way a client applies it. */
type TEntry = { kind: 'row' | 'tombstone'; pk: string; seq: string }

const entryKey = (entry: TEntry): string => `${entry.kind}:${entry.pk}@${entry.seq}`
const entriesOf = (page: IPullPage): TEntry[] => [
  ...page.rows.map((row) => ({ kind: 'row' as const, pk: row.pk, seq: row.seq })),
  ...page.tombstones.map((tombstone) => ({ kind: 'tombstone' as const, pk: tombstone.pk, seq: tombstone.seq })),
]

/**
 * The fixture table, bucketed on user_id, readable and writable by every signed-in
 * session, plus the two capture triggers exactly as `kizunasync init` attaches them. A
 * table a crashed run left behind is dropped first.
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
    create policy pp_all on public.${FIXTURE_TABLE} for all to authenticated
      using (true) with check (true);
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
  await conn`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._tombstones where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._bucket_grants where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`
}

beforeAll(async () => {
  if (db !== null) {
    await provisionFixture(db)
  }
})

afterAll(async () => {
  if (db !== null) {
    await dropFixture(db)
    await db.end()
  }
})

/** The highest seq on either ledger: a cursor at or above every reap horizon, below every change a test writes next. */
async function sequenceTop(): Promise<string> {
  const [top] = await db!`
    select coalesce(max(seq), 0)::text as seq
    from (select seq from kizunasync._changelog union all select seq from kizunasync._tombstones) s`

  return top.seq as string
}

/** Inserts one row per title, each in its own transaction, so the seqs ascend in title order. */
async function insertRows(owner: string, titles: string[]): Promise<string[]> {
  const ids: string[] = []

  for (const title of titles) {
    const [row] = await db!.unsafe(
      `insert into public.${FIXTURE_TABLE} (id, user_id, title) values (gen_random_uuid(), $1::uuid, $2) returning id::text as id`,
      [owner, title],
    )

    ids.push(row.id as string)
  }

  return ids
}

async function deleteRow(id: string): Promise<void> {
  await db!.unsafe(`delete from public.${FIXTURE_TABLE} where id = $1::uuid`, [id])
}

async function changelogSeq(id: string): Promise<string> {
  const [row] = await db!`
    select max(seq)::text as seq from kizunasync._changelog where table_name = ${FIXTURE_TABLE} and pk = ${id}`

  return row.seq as string
}

async function tombstoneSeq(id: string): Promise<string> {
  const [row] = await db!`
    select seq::text as seq from kizunasync._tombstones where table_name = ${FIXTURE_TABLE} and pk = ${id}`

  return row.seq as string
}

const bucketsFor = (owner: string): TBucket[] => [{ table: FIXTURE_TABLE, params: { user_id: owner } }]

/** The grant a committed pull of a live row in `owner`'s bucket records; this file's pulls roll back, so none of them leaves one. */
async function holdGrant(owner: string): Promise<void> {
  await db!`insert into kizunasync._bucket_grants (user_id, table_name, bucket_value) values (${owner}::uuid, ${FIXTURE_TABLE}, ${owner})`
}

/** One pull under `owner`'s session. A `maxPullScan` is set for this pull alone: the transaction that carries it rolls back. */
async function pullAs(owner: string, input: { buckets: TBucket[]; cursor: string; limit: number | null; maxPullScan?: number }): Promise<IPullPage> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  try {
    await conn`begin`

    if (input.maxPullScan !== undefined) {
      await conn`update kizunasync._settings set max_pull_scan = ${input.maxPullScan}`
    }
    await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: 'authenticated' })}, true)`
    await conn`set local role authenticated`
    const [row] = await conn`select kizunasync.pull(${input.buckets}::jsonb, ${input.cursor}, 1, ${input.limit}) as resp`

    await conn`rollback`

    return row.resp as IPullPage
  } finally {
    conn.release()
    await pool.end()
  }
}

/** The SQLSTATE and message of a pull the pack refuses, or null when it answers. Bun's SQL client carries the SQLSTATE on `errno`. */
async function pullRefusal(owner: string, input: { buckets: TBucket[]; cursor: string; limit: number | null }): Promise<{ sqlstate: unknown; message: string } | null> {
  try {
    await pullAs(owner, input)
  } catch (error) {
    return { sqlstate: error instanceof Error && 'errno' in error ? error.errno : undefined, message: error instanceof Error ? error.message : String(error) }
  }

  return null
}

/** Every page of a drain from `cursor` to `has_more: false`. */
async function drain(owner: string, input: { buckets: TBucket[]; cursor: string; limit: number; maxPullScan?: number }): Promise<IPullPage[]> {
  const pages: IPullPage[] = []
  let cursor = input.cursor

  for (let page = 0; page < MAX_DRAIN_PAGES; page++) {
    const response = await pullAs(owner, { ...input, cursor })

    pages.push(response)

    if (!response.has_more) {
      return pages
    }
    cursor = response.cursor
  }

  throw new Error(`the drain from ${input.cursor} at limit ${input.limit} never reached has_more false`)
}

describe.skipIf(!reachable)('pull pages are prefixes of one stream of rows and tombstones', () => {
  test('a tombstone at the head of the stream rides the first continuation page', async () => {
    const owner = crypto.randomUUID()

    await holdGrant(owner)
    const base = await sequenceTop()
    const [doomed] = await insertRows(owner, ['doomed'])

    await deleteRow(doomed as string)
    const [second, third] = await insertRows(owner, ['second', 'third'])
    const first = await pullAs(owner, { buckets: bucketsFor(owner), cursor: base, limit: 2 })

    expect(first.signal).toBeNull()
    expect(first.has_more).toBe(true)
    expect(first.tombstones.map((tombstone) => [tombstone.pk, tombstone.seq])).toEqual([[doomed, await tombstoneSeq(doomed as string)]])
    expect(first.rows.map((row) => [row.pk, row.seq, row.row.title])).toEqual([[second, await changelogSeq(second as string), 'second']])
    expect(first.cursor).toBe(`${base}:${await changelogSeq(second as string)}`)

    const rest = await pullAs(owner, { buckets: bucketsFor(owner), cursor: first.cursor, limit: 2 })

    expect(rest.has_more).toBe(false)
    expect(rest.tombstones).toEqual([])
    expect(rest.rows.map((row) => row.pk)).toEqual([third])
    expect(BigInt(rest.cursor) >= BigInt(await changelogSeq(third as string))).toBe(true)
  })

  test('an exact fit closes the checkpoint in one page, rows and tombstones counted together', async () => {
    const owner = crypto.randomUUID()

    await holdGrant(owner)
    const base = await sequenceTop()
    const [gone, kept, last] = await insertRows(owner, ['gone', 'kept', 'last'])

    await deleteRow(gone as string)
    const page = await pullAs(owner, { buckets: bucketsFor(owner), cursor: base, limit: 3 })

    expect(page.has_more).toBe(false)
    expect(page.rows.map((row) => row.pk)).toEqual([kept, last])
    expect(page.tombstones.map((tombstone) => tombstone.pk)).toEqual([gone])
    expect(BigInt(page.cursor) >= BigInt(await tombstoneSeq(gone as string))).toBe(true)

    const after = await pullAs(owner, { buckets: bucketsFor(owner), cursor: page.cursor, limit: 3 })

    expect({ has_more: after.has_more, entries: entriesOf(after) }).toEqual({ has_more: false, entries: [] })
  })

  test('no page exceeds the limit, and only the last page of a drain closes it', async () => {
    const owner = crypto.randomUUID()

    await holdGrant(owner)
    const base = await sequenceTop()
    const ids = await insertRows(owner, Array.from({ length: 9 }, (_, index) => `row ${index}`))

    for (const id of ids.filter((_, index) => index % 3 === 0)) {
      await deleteRow(id)
    }
    await insertRows(owner, ['late one', 'late two'])

    for (const limit of DRAIN_LIMITS) {
      const pages = await drain(owner, { buckets: bucketsFor(owner), cursor: base, limit })

      for (const [index, page] of pages.entries()) {
        expect(entriesOf(page).length, `limit ${limit} page ${index}`).toBeLessThanOrEqual(limit)
        expect(page.has_more, `limit ${limit} page ${index}`).toBe(index < pages.length - 1)
      }
    }
  })

  test('a drain across interleaved rows and tombstones delivers every entry once, in stream order', async () => {
    const owner = crypto.randomUUID()

    await holdGrant(owner)
    const base = await sequenceTop()
    const ids = await insertRows(owner, Array.from({ length: 8 }, (_, index) => `row ${index}`))

    await deleteRow(ids[1] as string)
    await db!.unsafe(`update public.${FIXTURE_TABLE} set title = 'edited' where id = $1::uuid`, [ids[2]])
    await deleteRow(ids[4] as string)
    await insertRows(owner, ['after deletes'])
    // A recreated pk the owner can see rides the stream as a row, so its tombstone must not.
    await db!.unsafe(`insert into public.${FIXTURE_TABLE} (id, user_id, title) values ($1::uuid, $2::uuid, 'recreated')`, [ids[4], owner])
    await deleteRow(ids[6] as string)

    const expected = await db!.unsafe(
      `select 'row' as kind, cl.pk::text as pk, max(cl.seq)::text as seq
         from kizunasync._changelog cl
         join public.${FIXTURE_TABLE} t on t.id::text = cl.pk
        where cl.table_name = $1 and cl.seq > $2::bigint
        group by cl.pk
       union all
       select 'tombstone', ts.pk::text, ts.seq::text
         from kizunasync._tombstones ts
        where ts.table_name = $1 and ts.seq > $2::bigint and ts.bucket_snapshot ->> 'user_id' = $3
          and not exists (select 1 from public.${FIXTURE_TABLE} t where t.id::text = ts.pk)`,
      [FIXTURE_TABLE, base, owner],
    )
    const expectedKeys = (expected as TEntry[]).map(entryKey).sort()

    expect(expectedKeys.filter((key) => key.startsWith('tombstone:'))).toHaveLength(2)

    const duplicated: TBucket[] = [...bucketsFor(owner), ...bucketsFor(owner)]

    for (const buckets of [bucketsFor(owner), duplicated]) {
      for (const limit of DRAIN_LIMITS) {
        for (const maxPullScan of [undefined, ...DRAIN_SCAN_CAPS]) {
          const pages = await drain(owner, { buckets, cursor: base, limit, maxPullScan })
          const delivered = pages.flatMap(entriesOf)
          const stream = pages.flatMap((page) => entriesOf(page).sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1)))
          const label = `${buckets.length} bucket entries, limit ${limit}, scan cap ${maxPullScan ?? 'default'}`

          expect(delivered.map(entryKey).sort(), label).toEqual(expectedKeys)
          expect(new Set(delivered.map(entryKey)).size, label).toBe(delivered.length)
          expect(stream.map((entry) => BigInt(entry.seq)), label).toEqual(stream.map((entry) => BigInt(entry.seq)).sort((a, b) => (a < b ? -1 : 1)))
        }
      }
    }
  })

  test('a limit below 1 is refused with 22023, and a null limit pages at the default of 500', async () => {
    const owner = crypto.randomUUID()
    const base = await sequenceTop()

    await db!.unsafe(
      `insert into public.${FIXTURE_TABLE} (id, user_id, title) select gen_random_uuid(), $1::uuid, 'bulk ' || g from generate_series(1, 501) g`,
      [owner],
    )

    for (const limit of [0, -1]) {
      expect(await pullRefusal(owner, { buckets: bucketsFor(owner), cursor: base, limit }), `limit ${limit}`).toEqual({
        sqlstate: '22023',
        message: 'kizunasync.pull(): limit must be at least 1',
      })
    }
    const page = await pullAs(owner, { buckets: bucketsFor(owner), cursor: base, limit: null })

    expect({ has_more: page.has_more, entries: entriesOf(page).length }).toEqual({ has_more: true, entries: 500 })
  })
})

/** The SQLSTATE an update of `_settings.max_pull_scan` to `value` raises, in a transaction that always rolls back; null when it is accepted. */
async function settingsUpdateRefusal(value: number): Promise<unknown> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()

  try {
    await conn`begin`

    try {
      await conn`update kizunasync._settings set max_pull_scan = ${value}`

      return null
    } catch (error) {
      return error instanceof Error && 'errno' in error ? error.errno : undefined
    } finally {
      await conn`rollback`
    }
  } finally {
    conn.release()
    await pool.end()
  }
}

/** A bucket that also names the title, so a row with any other title is a candidate the page withholds. */
const keptBucket = (owner: string): TBucket[] => [{ table: FIXTURE_TABLE, params: { user_id: owner, title: 'kept' } }]

describe.skipIf(!reachable)('a page stops once it has examined max_pull_scan candidates', () => {
  test('a capped page continues from the last candidate it examined, withheld ones included', async () => {
    const owner = crypto.randomUUID()
    const base = await sequenceTop()
    const [, skipTwo, keptOne, skipThree, keptTwo] = await insertRows(owner, ['skip', 'skip', 'kept', 'skip', 'kept'])
    const first = await pullAs(owner, { buckets: keptBucket(owner), cursor: base, limit: 10, maxPullScan: 2 })

    expect({ has_more: first.has_more, entries: entriesOf(first), cursor: first.cursor }).toEqual({
      has_more: true,
      entries: [],
      cursor: `${base}:${await changelogSeq(skipTwo as string)}`,
    })

    const second = await pullAs(owner, { buckets: keptBucket(owner), cursor: first.cursor, limit: 10, maxPullScan: 2 })

    expect({ has_more: second.has_more, rows: second.rows.map((row) => row.pk), cursor: second.cursor }).toEqual({
      has_more: true,
      rows: [keptOne],
      cursor: `${base}:${await changelogSeq(skipThree as string)}`,
    })

    const last = await pullAs(owner, { buckets: keptBucket(owner), cursor: second.cursor, limit: 10, maxPullScan: 2 })

    expect({ has_more: last.has_more, rows: last.rows.map((row) => row.pk) }).toEqual({ has_more: false, rows: [keptTwo] })
    expect(last.cursor.includes(':')).toBe(false)
    expect(BigInt(last.cursor) >= BigInt(await changelogSeq(keptTwo as string))).toBe(true)
  })

  test('a stream that ends exactly at the cap closes the checkpoint', async () => {
    const owner = crypto.randomUUID()
    const base = await sequenceTop()
    const ids = await insertRows(owner, ['kept', 'skip'])
    const page = await pullAs(owner, { buckets: keptBucket(owner), cursor: base, limit: 10, maxPullScan: 2 })

    expect({ has_more: page.has_more, rows: page.rows.map((row) => row.pk) }).toEqual({ has_more: false, rows: [ids[0]] })
    expect(page.cursor.includes(':')).toBe(false)
  })

  test('the limit still ends a page first when fewer candidates than the cap fill it', async () => {
    const owner = crypto.randomUUID()
    const base = await sequenceTop()
    const ids = await insertRows(owner, ['one', 'two', 'three', 'four'])
    const page = await pullAs(owner, { buckets: bucketsFor(owner), cursor: base, limit: 2, maxPullScan: 5 })

    expect({ has_more: page.has_more, rows: page.rows.map((row) => row.pk), cursor: page.cursor }).toEqual({
      has_more: true,
      rows: ids.slice(0, 2),
      cursor: `${base}:${await changelogSeq(ids[1] as string)}`,
    })
  })

  test('a drain of withheld and kept rows under any cap delivers every kept row once', async () => {
    const owner = crypto.randomUUID()
    const base = await sequenceTop()
    const titles = Array.from({ length: 9 }, (_, index) => (index % 3 === 1 ? 'kept' : 'skip'))
    const ids = await insertRows(owner, titles)
    const kept = ids.filter((_, index) => titles[index] === 'kept').sort()

    for (const limit of [1, 2, 500]) {
      for (const maxPullScan of DRAIN_SCAN_CAPS) {
        const pages = await drain(owner, { buckets: keptBucket(owner), cursor: base, limit, maxPullScan })
        const label = `limit ${limit}, scan cap ${maxPullScan}`

        expect(pages.flatMap((page) => page.rows.map((row) => row.pk)).sort(), label).toEqual(kept)

        for (const page of pages) {
          expect(entriesOf(page).length, label).toBeLessThanOrEqual(Math.min(limit, maxPullScan))
        }
      }
    }
  })

  test(`max_pull_scan defaults to ${DEFAULT_MAX_PULL_SCAN} and refuses a value below 1`, async () => {
    const [column] = await db!`
      select column_default from information_schema.columns
      where table_schema = 'kizunasync' and table_name = '_settings' and column_name = 'max_pull_scan'`
    const sqlstate = await settingsUpdateRefusal(0)

    expect(column?.column_default).toBe(String(DEFAULT_MAX_PULL_SCAN))
    expect(sqlstate).toBe('23514')
  })
})
