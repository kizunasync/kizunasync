/**
 * Re-keying a table whose primary key moved, against live Postgres.
 * `kizunasync._rekey_changelog(table)` deletes every bookkeeping row of the
 * table, which names a row by its old pk text: the changelog, the queued
 * changes, the tombstones, the HLC stamps, the conflict journal, and the
 * bucket grants. It then seeds one upsert per live row under the new key and
 * returns how many it seeded.
 *
 * The fixture is one table keyed by a bigint `id`, written and deleted from,
 * then moved to the composite key `(hall, seat)` with a schema bump and
 * re-keyed. Rows of another table in the same bookkeeping tables must stay.
 * Everything it produced is dropped afterwards. Skips loudly when Postgres is
 * unreachable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const TABLE = '_rekey_rows'
const OTHER_TABLE = '_rekey_other'

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[rekey-changelog] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

// MARK: - Types

type TBucket = { table: string; params: Record<string, string> }
type TRow = { pk: string; row: Record<string, unknown>; seq: string; table: string }
type TPullResp = { cursor: string; has_more: boolean; rows: TRow[]; signal: unknown; tombstones: { pk: string }[] }
type TCount = { table_name: string; n: number }

// MARK: - Fixture

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })
const TEAM = uid()
const grantee = uid()
const rekeyed = { count: '' }

/** The pk text R2 gives a (hall, seat) key. */
const pairPk = (hall: number, seat: number): string => JSON.stringify([String(hall), String(seat)]).replace(',', ', ')

async function provision(): Promise<void> {
  await db!.unsafe(`
    drop table if exists public.${TABLE} cascade;
    create table public.${TABLE} (
      id bigint primary key,
      hall bigint not null,
      seat integer not null,
      team_id uuid not null,
      title text not null,
      unique (hall, seat)
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
    insert into kizunasync._config (table_name, sync_mode, bucket_column, min_schema_version, register_clients, key_columns)
    values (${TABLE}, 'read-write', 'team_id', 1, false, '{id}')
    on conflict (table_name) do update
      set sync_mode = excluded.sync_mode, bucket_column = excluded.bucket_column,
          min_schema_version = excluded.min_schema_version, key_columns = excluded.key_columns`
}

/** Writes under the bigint key, one row edited and one deleted, then an HLC stamp, a journal entry, and grants on this table, and one row of another table in every bookkeeping table the re-key clears. */
async function writeHistory(): Promise<void> {
  await db!.unsafe(
    `insert into public.${TABLE} (id, hall, seat, team_id, title) values (1, 1, 10, $1, 'a'), (2, 1, 11, $1, 'b'), (3, 2, 5, $1, 'c')`,
    [TEAM],
  )
  await db!.unsafe(`update public.${TABLE} set title = 'a, edited' where id = 1`)
  await db!.unsafe(`delete from public.${TABLE} where id = 3`)

  for (const table of [TABLE, OTHER_TABLE]) {
    await db!`insert into kizunasync._row_hlc (table_name, pk, column_hlc) values (${table}, '1', '{}'::jsonb)`
    await db!`
      insert into kizunasync._conflict_journal (table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode)
      values (${table}, '1', 'title', '"old"'::jsonb, ${uid()}::uuid, 'arrival')`
    await db!`insert into kizunasync._bucket_grants (user_id, table_name, bucket_value) values (${grantee}::uuid, ${table}, ${TEAM})`
  }
  await db!`
    insert into kizunasync._changelog (seq, table_name, pk, op, bucket_value)
    values (nextval('kizunasync._change_seq'), ${OTHER_TABLE}, '1', 'upsert', ${TEAM})`
  await db!`
    insert into kizunasync._tombstones (seq, table_name, pk, bucket_value)
    values (nextval('kizunasync._change_seq'), ${OTHER_TABLE}, '2', ${TEAM})`
}

/** The key change, its schema bump, and the re-key, in one transaction as a provisioning migration runs them. */
async function rekey(): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe(`alter table public.${TABLE} drop constraint ${TABLE}_pkey, add primary key (hall, seat)`)
    await tx`update kizunasync._config set key_columns = '{hall,seat}', min_schema_version = 2 where table_name = ${TABLE}`
    const [row] = await tx`select kizunasync._rekey_changelog(${TABLE})::text as seeded`

    rekeyed.count = row.seeded as string
  })
}

async function cleanup(): Promise<void> {
  await db!.unsafe(`drop table if exists public.${TABLE} cascade`)

  for (const table of [TABLE, OTHER_TABLE]) {
    await db!`delete from kizunasync._changelog where table_name = ${table}`
    await db!`delete from kizunasync._tombstones where table_name = ${table}`
    await db!`delete from kizunasync._row_hlc where table_name = ${table}`
    await db!`delete from kizunasync._conflict_journal where table_name = ${table}`
    await db!`delete from kizunasync._bucket_grants where table_name = ${table}`
  }
  await db!`delete from kizunasync._config where table_name = ${TABLE}`
}

beforeAll(async () => {
  if (reachable) {
    await provision()
    await writeHistory()
    await rekey()
  }
})

afterAll(async () => {
  if (db !== null) {
    await cleanup()
    await db.end()
  }
})

// MARK: - Helpers

/** Rows per table in `relation`, for this table and the other one. */
async function counts(relation: string): Promise<TCount[]> {
  return db!.unsafe(
    `select table_name, count(*)::int as n from kizunasync.${relation} where table_name in ($1, $2) group by table_name order by table_name`,
    [TABLE, OTHER_TABLE],
  )
}

/** A bootstrap pull at the bumped schema version under a fresh caller's JWT, rolled back so it leaves no grant behind. */
async function bootstrap(buckets: TBucket[]): Promise<TPullResp> {
  const pool = new SQL(DB_URL, { max: 1 })
  const w = await pool.reserve()

  try {
    await w`begin`
    await w`select set_config('request.jwt.claims', ${claims(uid())}, true)`
    await w`set local role authenticated`
    const [r] = await w<{ resp: TPullResp }[]>`select kizunasync.pull(${buckets}::jsonb, '0', 2, 500) as resp`

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

// MARK: - Re-keying

describe.skipIf(!reachable)('kizunasync._rekey_changelog', () => {
  test('seeds one upsert per live row under the new key and returns how many it seeded', async () => {
    const stored = await db!<{ pk: string; op: string; bucket_value: string }[]>`
      select pk, op, bucket_value from kizunasync._changelog where table_name = ${TABLE} order by pk`

    expect(rekeyed.count).toBe('2')
    expect(stored).toEqual([
      { pk: pairPk(1, 10), op: 'upsert', bucket_value: TEAM },
      { pk: pairPk(1, 11), op: 'upsert', bucket_value: TEAM },
    ])
  })

  test('leaves no entry under an old pk in any bookkeeping table that names rows by pk', async () => {
    for (const relation of ['_changelog', '_change_pending', '_tombstones', '_row_hlc', '_conflict_journal']) {
      const old = await db!.unsafe(
        `select pk from kizunasync.${relation} where table_name = $1 and pk in ('1', '2', '3')`,
        [TABLE],
      )

      expect(old, relation).toEqual([])
    }
  })

  test('clears the tombstones, stamps, journal, and grants of the table and no other table', async () => {
    expect(await counts('_tombstones')).toEqual([{ table_name: OTHER_TABLE, n: 1 }])
    expect(await counts('_row_hlc')).toEqual([{ table_name: OTHER_TABLE, n: 1 }])
    expect(await counts('_conflict_journal')).toEqual([{ table_name: OTHER_TABLE, n: 1 }])
    expect(await counts('_bucket_grants')).toEqual([{ table_name: OTHER_TABLE, n: 1 }])
    expect(await counts('_changelog')).toEqual([
      { table_name: OTHER_TABLE, n: 1 },
      { table_name: TABLE, n: 2 },
    ])
    expect(await counts('_change_pending')).toEqual([])
  })

  test('a bootstrap pull returns every live row under its new pk text', async () => {
    const page = await bootstrap([{ table: TABLE, params: { team_id: TEAM } }])

    expect(page.rows.map((row) => row.pk).sort()).toEqual([pairPk(1, 10), pairPk(1, 11)])
    expect(page.rows.find((row) => row.pk === pairPk(1, 10))?.row).toMatchObject({ hall: 1, seat: 10, title: 'a, edited' })
    expect(page.tombstones).toEqual([])
  })

  test('a table with no _config row is refused with 0A000', async () => {
    const failure = await refusal(() => db!`select kizunasync._rekey_changelog('_rekey_not_configured')`)

    expect(failure?.sqlstate).toBe('0A000')
    expect(failure?.message).toContain('_rekey_not_configured')
  })

  test('a call carrying a client JWT is refused with 42501', async () => {
    const failure = await refusal(() =>
      db!.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${claims(uid())}, true)`
        await tx`select kizunasync._rekey_changelog(${TABLE})`
      }),
    )

    expect(failure?.sqlstate).toBe('42501')
  })
})
