/**
 * Continuation cursors against real Postgres. A page the limit cuts returns
 * `<start>:<position>`, where the start is the checkpoint its transfer started
 * from, and the pull gate reads that start for CHECKPOINT_EXPIRED. A paged
 * bootstrap after a reap therefore completes, a transfer from a checkpoint
 * expires as soon as a reap passes its start, and the client registry stores the
 * continuation token in a form `_cursor_high_water` still reads.
 *
 * Drives the public `kizunasync.pull` RPC on a synced table of its own,
 * registered the way `kizunasync init` registers one. The reaps age only this file's
 * tombstones, and the reap watermark is restored at the end, with the table, its
 * registration, and every bookkeeping row it produced. Skips loudly when no DB
 * is reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const FIXTURE_TABLE = '_pull_continuation_start'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[pull-continuation-start] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

type TRow = { pk: string; row: Record<string, unknown>; seq: string; table: string }
type TTombstone = { deleted_at: string; pk: string; seq: string; table: string }

interface IPullPage {
  cursor: string
  has_more: boolean
  rows: TRow[]
  signal: { type: string } | null
  tombstones: TTombstone[]
}

/** The reap watermark before this file ran, restored in afterAll. */
let reapStateBefore: { reaped_seq: string; reaped_at: string | null } | null = null

/** Client registry rows this file created, deleted in afterAll. */
const registeredClients: string[] = []

/**
 * The fixture table, bucketed on user_id and registering clients, readable and
 * writable by every signed-in session, plus the two capture triggers exactly as
 * `kizunasync init` attaches them. A table a crashed run left behind is dropped first.
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
    create policy pcs_all on public.${FIXTURE_TABLE} for all to authenticated
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
    values (${FIXTURE_TABLE}, 'read-write', 'user_id', 1, true)
    on conflict (table_name) do update set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column, register_clients = true`
}

async function dropFixture(conn: SQL): Promise<void> {
  await conn.unsafe(`drop table if exists public.${FIXTURE_TABLE} cascade`)
  await conn`delete from kizunasync._changelog where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._tombstones where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._bucket_grants where table_name = ${FIXTURE_TABLE}`
  await conn`delete from kizunasync._config where table_name = ${FIXTURE_TABLE}`

  if (registeredClients.length > 0) {
    await conn`delete from kizunasync._clients where client_id::text in ${conn(registeredClients)}`
  }
}

beforeAll(async () => {
  if (db === null) {
    return
  }
  const [state] = await db`select reaped_seq::text as reaped_seq, reaped_at from kizunasync._reap_state where id`

  reapStateBefore = (state as { reaped_seq: string; reaped_at: string | null } | undefined) ?? null
  await provisionFixture(db)
})

afterAll(async () => {
  if (db === null) {
    return
  }
  await dropFixture(db)

  if (reapStateBefore !== null) {
    await db`
      update kizunasync._reap_state
         set reaped_seq = ${reapStateBefore.reaped_seq}::bigint, reaped_at = ${reapStateBefore.reaped_at}
       where id`
  }
  await db.end()
})

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

async function changelogSeq(id: string): Promise<string> {
  const [row] = await db!`
    select max(seq)::text as seq from kizunasync._changelog where table_name = ${FIXTURE_TABLE} and pk = ${id}::uuid`

  return row.seq as string
}

/** Deletes the row, ages its tombstone past every TTL, and reaps it; returns the reap horizon that follows. */
async function deleteAndReap(id: string): Promise<string> {
  await db!.unsafe(`delete from public.${FIXTURE_TABLE} where id = $1::uuid`, [id])
  await db!`
    update kizunasync._tombstones set deleted_at = now() - interval '400 days'
     where table_name = ${FIXTURE_TABLE} and pk = ${id}::uuid`
  await db!`select kizunasync.reap_tombstones()`
  const [state] = await db!`select reaped_seq::text as reaped_seq from kizunasync._reap_state where id`

  return state.reaped_seq as string
}

async function pullAs(owner: string, input: { cursor: string; limit: number; clientId?: string }): Promise<IPullPage> {
  const pool = new SQL(DB_URL, { max: 1 })
  const conn = await pool.reserve()
  const buckets = [{ table: FIXTURE_TABLE, params: { user_id: owner } }]

  try {
    await conn`begin`
    await conn`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner, role: 'authenticated' })}, true)`
    await conn`set local role authenticated`
    const [row] = input.clientId === undefined
      ? await conn`select kizunasync.pull(${buckets}::jsonb, ${input.cursor}, 1, ${input.limit}) as resp`
      : await conn`select kizunasync.pull(${buckets}::jsonb, ${input.cursor}, 1, ${input.limit}, ${input.clientId}::uuid) as resp`

    await conn`commit`

    return row.resp as IPullPage
  } finally {
    conn.release()
    await pool.end()
  }
}

describe.skipIf(!reachable)('continuation cursors carry the checkpoint their transfer started from', () => {
  test('a paged bootstrap after a reap completes, and every row arrives once', async () => {
    const owner = crypto.randomUUID()
    const [one, two, three] = await insertRows(owner, ['one', 'two', 'three'])
    const [doomed] = await insertRows(owner, ['doomed'])
    const horizon = await deleteAndReap(doomed as string)
    const [four] = await insertRows(owner, ['four'])
    const first = await pullAs(owner, { cursor: '0', limit: 2 })
    const secondSeq = await changelogSeq(two as string)

    expect(BigInt(secondSeq) < BigInt(horizon), 'page one ends below the reap horizon').toBe(true)
    expect({ cursor: first.cursor, has_more: first.has_more, rows: first.rows.map((row) => row.pk) }).toEqual({
      cursor: `0:${secondSeq}`,
      has_more: true,
      rows: [one, two],
    })

    const rest = await pullAs(owner, { cursor: first.cursor, limit: 2 })

    expect(rest.signal).toBeNull()
    expect({ has_more: rest.has_more, rows: rest.rows.map((row) => row.pk), tombstones: rest.tombstones }).toEqual({
      has_more: false,
      rows: [three, four],
      tombstones: [],
    })
    expect(rest.cursor).toMatch(/^\d+$/)
    expect(BigInt(rest.cursor) >= BigInt(horizon)).toBe(true)

    const later = await pullAs(owner, { cursor: rest.cursor, limit: 2 })

    expect({ signal: later.signal, has_more: later.has_more, rows: later.rows, tombstones: later.tombstones }).toEqual({
      signal: null,
      has_more: false,
      rows: [],
      tombstones: [],
    })
  })

  test('a transfer from a checkpoint expires when a reap passes its start between two pages', async () => {
    const owner = crypto.randomUUID()

    await insertRows(owner, ['before the checkpoint'])
    const checkpoint = (await pullAs(owner, { cursor: '0', limit: 500 })).cursor
    const [first, second] = await insertRows(owner, ['after one', 'after two', 'after three'])
    const [doomed] = await insertRows(owner, ['doomed'])
    const page = await pullAs(owner, { cursor: checkpoint, limit: 2 })

    expect(checkpoint).toMatch(/^\d+$/)
    expect({ cursor: page.cursor, has_more: page.has_more, rows: page.rows.map((row) => row.pk) }).toEqual({
      cursor: `${checkpoint}:${await changelogSeq(second as string)}`,
      has_more: true,
      rows: [first, second],
    })

    const horizon = await deleteAndReap(doomed as string)

    expect(BigInt(horizon) > BigInt(checkpoint), 'the reap passes the checkpoint the transfer started from').toBe(true)
    expect(await pullAs(owner, { cursor: page.cursor, limit: 2 })).toEqual({
      cursor: page.cursor,
      has_more: false,
      rows: [],
      signal: { type: 'CHECKPOINT_EXPIRED' },
      tombstones: [],
    })
  })

  test('the client registry stores a continuation token, and _cursor_high_water reads its position', async () => {
    const owner = crypto.randomUUID()
    const clientId = crypto.randomUUID()

    registeredClients.push(clientId)
    const [, second] = await insertRows(owner, ['one', 'two', 'three'])
    const page = await pullAs(owner, { cursor: '0', limit: 2, clientId })
    const [stored] = await db!`
      select cursor, kizunasync._cursor_high_water(cursor)::text as high_water, kizunasync._cursor_start(cursor)::text as start
      from kizunasync._clients where client_id = ${clientId}::uuid`

    expect(page.has_more).toBe(true)
    expect(stored).toEqual({ cursor: page.cursor, high_water: await changelogSeq(second as string), start: '0' })
  })
})
