/**
 * Relabeling a table whose bucket column changed, against live Postgres.
 * `kizunasync._relabel_changelog(table)` rewrites the label of every changelog
 * row from its pk's live row, deletes the changelog rows of a pk with no live
 * row, re-keys each tombstone whose snapshot carries the new column by that
 * column's value and deletes the rest, deletes the table's bucket grants, and
 * returns how many changelog rows it relabeled.
 * It renders labels in UTC whatever the session TimeZone.
 *
 * The fixture is one table everyone reads, bucketed on `team_id` while it is
 * written, then moved to its `timestamptz` column `due` and relabeled in an
 * `Asia/Tokyo` session. It is dropped with every bookkeeping row it produced,
 * and the grant row of another table the relabel must leave alone goes with it.
 * Skips loudly when Postgres is unreachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const TABLE = '_relabel_rows'
const OTHER_TABLE = '_relabel_other'
const RELABEL_ZONE = 'Asia/Tokyo'

/** Two instants, each spelled in UTC and the way `to_jsonb` renders it in a UTC session. */
const DUE_A = '2024-01-01T00:00:00Z'
const DUE_A_IN_UTC = '2024-01-01T00:00:00+00:00'
const DUE_B = '2024-02-01T00:00:00Z'
const DUE_B_IN_UTC = '2024-02-01T00:00:00+00:00'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[relabel-changelog] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TBucket = { table: string; params: Record<string, string> }
type TRow = { pk: string; row: Record<string, unknown>; seq: string; table: string }
type TPullResp = { cursor: string; has_more: boolean; rows: TRow[]; signal: unknown; tombstones: unknown[] }
type TLabel = { pk: string; bucket_value: string | null }
type TStoredTombstone = { pk: string; bucket_value: string; bucket_snapshot: Record<string, string> }
type TGrant = { table_name: string; bucket_value: string }

// MARK: - Fixture

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })
const TEAM_A = uid()
const TEAM_B = uid()
const pks = { kept: uid(), moved: uid(), gone: uid(), legacy: uid() }
const grantees = [uid(), uid(), uid()]
const relabeled = { count: '' }

async function provision(): Promise<void> {
  await db!.unsafe(`
    drop table if exists public.${TABLE} cascade;
    create table public.${TABLE} (
      id uuid primary key,
      team_id uuid not null,
      due timestamptz not null,
      title text not null
    );
    alter table public.${TABLE} enable row level security;
    grant select, insert, update, delete on public.${TABLE} to authenticated;
    create policy r_all on public.${TABLE} for all to authenticated using (true) with check (true);
    create trigger kizunasync_track_change after insert or update on public.${TABLE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${TABLE}
      for each row execute function kizunasync.track_delete();
  `)
  await db!`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients)
    values (${TABLE}, 'read-write', 'team_id', 1, false)
    on conflict (table_name) do update set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column`
}

/** Writes under `team_id`: a row updated once, a row moved to another team, and a row deleted; then a tombstone keyed '' whose snapshot carries `due`, and grants on this table and another. */
async function writeHistory(): Promise<void> {
  await db!.unsafe(`insert into public.${TABLE} (id, team_id, due, title) values ($1, $2, $3, 'kept')`, [pks.kept, TEAM_A, DUE_A])
  await db!.unsafe(`update public.${TABLE} set title = 'kept, edited' where id = $1`, [pks.kept])
  await db!.unsafe(`insert into public.${TABLE} (id, team_id, due, title) values ($1, $2, $3, 'moved')`, [pks.moved, TEAM_A, DUE_B])
  await db!.unsafe(`update public.${TABLE} set team_id = $2 where id = $1`, [pks.moved, TEAM_B])
  await db!.unsafe(`insert into public.${TABLE} (id, team_id, due, title) values ($1, $2, $3, 'gone')`, [pks.gone, TEAM_A, DUE_A])
  await db!.unsafe(`delete from public.${TABLE} where id = $1`, [pks.gone])
  await db!`
    insert into kizunasync._tombstones (table_name, pk, seq, bucket_snapshot)
    values (${TABLE}, ${pks.legacy}::uuid, nextval('kizunasync._change_seq'), ${{ due: DUE_A_IN_UTC }}::jsonb)`
  await db!`
    insert into kizunasync._bucket_grants (user_id, table_name, bucket_value)
    values (${grantees[0]}::uuid, ${TABLE}, ${TEAM_A}), (${grantees[1]}::uuid, ${TABLE}, ${TEAM_B}), (${grantees[2]}::uuid, ${OTHER_TABLE}, '')`
}

/** The bucket column change and the relabel, in one transaction of a session whose TimeZone is not UTC. */
async function relabel(): Promise<void> {
  await db!.begin(async (tx) => {
    await tx`select set_config('timezone', ${RELABEL_ZONE}, true)`
    await tx`update kizunasync._config set bucket_column = 'due' where table_name = ${TABLE}`
    const [row] = await tx`select kizunasync._relabel_changelog(${TABLE})::text as relabeled`

    relabeled.count = row.relabeled as string
  })
}

async function cleanup(): Promise<void> {
  await db!.unsafe(`drop table if exists public.${TABLE} cascade`)
  await db!`delete from kizunasync._changelog where table_name = ${TABLE}`
  await db!`delete from kizunasync._tombstones where table_name = ${TABLE}`
  await db!`delete from kizunasync._bucket_grants where table_name in (${TABLE}, ${OTHER_TABLE})`
  await db!`delete from kizunasync._config where table_name = ${TABLE}`
}

beforeAll(async () => {
  if (reachable) {
    await provision()
    await writeHistory()
    await relabel()
  }
})

afterAll(async () => {
  if (db !== null) {
    await cleanup()
    await db.end()
  }
})

// MARK: - Helpers

async function labels(): Promise<TLabel[]> {
  return db!<TLabel[]>`
    select cl.pk::text as pk, cl.bucket_value from kizunasync._changelog cl
    where cl.table_name = ${TABLE} order by cl.seq`
}

async function tombstones(): Promise<TStoredTombstone[]> {
  return db!<TStoredTombstone[]>`
    select t.pk::text as pk, t.bucket_value, t.bucket_snapshot from kizunasync._tombstones t
    where t.table_name = ${TABLE} order by t.seq`
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

/** The SQLSTATE and message of a statement the pack refuses; null when it is answered. */
async function refusal(run: () => Promise<unknown>): Promise<{ sqlstate: unknown; message: string } | null> {
  try {
    await run()
  } catch (error) {
    return {
      sqlstate: error instanceof Error && 'errno' in error ? error.errno : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  return null
}

// MARK: - Relabeling

describe.skipIf(!reachable)('kizunasync._relabel_changelog', () => {
  test('relabels every changelog row of a live pk from the new column in UTC and returns how many it relabeled', async () => {
    const stored = await labels()

    expect(relabeled.count).toBe('4')
    expect(stored.filter((label) => label.pk === pks.kept).map((label) => label.bucket_value)).toEqual([DUE_A_IN_UTC, DUE_A_IN_UTC])
    expect(stored.filter((label) => label.pk === pks.moved).map((label) => label.bucket_value)).toEqual([DUE_B_IN_UTC, DUE_B_IN_UTC])
  })

  test('deletes the changelog rows of a pk with no live row', async () => {
    expect((await labels()).filter((label) => label.pk === pks.gone)).toEqual([])
  })

  test('re-keys a tombstone whose snapshot carries the new column and deletes the others', async () => {
    expect(await tombstones()).toEqual([{ pk: pks.legacy, bucket_value: DUE_A_IN_UTC, bucket_snapshot: { due: DUE_A_IN_UTC } }])
  })

  test('deletes the bucket grants of the table and leaves those of other tables', async () => {
    const grants = await db!<TGrant[]>`
      select table_name, bucket_value from kizunasync._bucket_grants
      where user_id = any(${`{${grantees.join(',')}}`}::uuid[]) order by table_name`

    expect(grants).toEqual([{ table_name: OTHER_TABLE, bucket_value: '' }])
  })

  test('a bootstrap pull of a value of the new column delivers the rows that carry it', async () => {
    const page = await bootstrap([{ table: TABLE, params: { due: DUE_A } }])

    expect(page.rows.map((row) => row.pk)).toEqual([pks.kept])
  })

  test('a table with no _config row is refused with 0A000', async () => {
    const failure = await refusal(() => db!`select kizunasync._relabel_changelog('_relabel_not_configured')`)

    expect(failure?.sqlstate).toBe('0A000')
    expect(failure?.message).toContain('_relabel_not_configured')
  })

  test('a call carrying a client JWT is refused with 42501', async () => {
    const failure = await refusal(() =>
      db!.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${claims(uid())}, true)`
        await tx`select kizunasync._relabel_changelog(${TABLE})`
      }),
    )

    expect(failure?.sqlstate).toBe('42501')
  })
})
