/**
 * Re-applying `0001_kizuna_init.sql` over an install of itself, against live
 * Postgres. The re-apply leaves the `kizunasync` schema dumping exactly like a
 * fresh install (`pg_dump --schema-only -n kizunasync`), and every row the
 * install held, in the pack's tables and in the synced tables, stays as it was,
 * along with the change sequence's position.
 *
 * Both installs run in the throwaway database kizunasync_scratch_converge on the
 * server SUPABASE_DB_URL names, created and dropped by this file, over the vendor
 * stub the scratch rebuild applies. The install is provisioned the way the config
 * migration of `kizunasync init` provisions a project, then written through its
 * own triggers, push, and pull: a table bucketed on a uuid and an unbucketed
 * table, each holding rows from before its triggers existed, with an update,
 * deletes, pushed verdicts, a client registration with its bucket grants, an
 * operator setting, and a confirmed attachment with its Storage object. pg_dump
 * runs in the local stack's container (KSYNC_DB_CONTAINER, as for the scratch
 * rebuild), whose binary matches the server, or from PATH. Skips loudly when
 * Postgres or pg_dump is unavailable.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

const THROWAWAY = 'kizunasync_scratch_converge'
const CONTAINER = process.env.KSYNC_DB_CONTAINER ?? 'supabase_db_kizunasync'
const ROOT = join(import.meta.dir, '../../..')
const PACK_FILE = '0001_kizuna_init.sql'
const STUB_SQL = readFileSync(join(ROOT, 'scripts/pg-vendor-stub.sql'), 'utf8')
const PACK_SQL = readFileSync(join(ROOT, 'packages/supabase-pack/supabase/migrations', PACK_FILE), 'utf8')
const PACK_VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const THROWAWAY_URL = `${DB_URL.replace(/\?.*$/, '').replace(/\/[^/]*$/, '')}/${THROWAWAY}`

const BOARD = '_reapply_board'
const NOTES = '_reapply_notes'

// MARK: - Types

type TBucket = { table: string; params: Record<string, string> }
type TMutation = { mutation_id: string; table: string; op: 'insert'; pk: string; columns: Record<string, unknown> }
type TSnapshot = Record<string, unknown[]>

/** One synced table as the config migration provisions it. */
interface ISyncedTable {
  name: string
  bucketColumn: string | null
  registerClients: boolean
}

// MARK: - Environment

/** Runs a command and returns its stdout, or null when it cannot start or exits non-zero. */
function run(command: string[]): string | null {
  try {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' })

    return result.exitCode === 0 ? result.stdout.toString() : null
  } catch {
    return null
  }
}

/** The pg_dump command line for the throwaway database: the stack container's own binary, else the one on PATH. */
function dumpCommand(): string[] | null {
  const args = ['--schema-only', '-n', 'kizunasync']

  if (run(['docker', 'inspect', CONTAINER]) !== null) {
    return ['docker', 'exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', THROWAWAY, ...args]
  }
  if (Bun.which('pg_dump') !== null) {
    return ['pg_dump', ...args, THROWAWAY_URL]
  }
  return null
}

const DUMP = dumpCommand()

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL)

  await probe`select 1`
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[reapply-convergence] SKIPPED: no Postgres at ${DB_URL}. Run \`bun run db:start\` or set ` +
      `SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}
if (reachable && DUMP === null) {
  console.warn(`[reapply-convergence] SKIPPED: neither the ${CONTAINER} container nor a pg_dump on PATH is available.`)
}

const ready = reachable && DUMP !== null

// MARK: - Fixture

const uid = (): string => crypto.randomUUID()
const claims = (sub: string): string => JSON.stringify({ sub, role: 'authenticated' })

const TEAM_A = uid()
const TEAM_B = uid()
const WRITER = uid()
const CLIENT = uid()

const BOARD_BEFORE_A = uid()
const BOARD_BEFORE_B = uid()
const BOARD_WRITTEN_A = uid()
const BOARD_WRITTEN_B = uid()
const BOARD_DELETED_A = uid()
const NOTE_BEFORE = uid()
const NOTE_WRITTEN = uid()
const NOTE_DELETED = uid()
const ATTACHMENT_BUCKET = 'reapply'
const ATTACHMENT_PATH = `${WRITER}/${BOARD_WRITTEN_A}/${uid()}.png`
const ATTACHMENT_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const SYNCED: ISyncedTable[] = [
  { name: BOARD, bucketColumn: 'team_id', registerClients: true },
  { name: NOTES, bucketColumn: null, registerClients: false },
]

const PUSHED: TMutation[] = [
  { mutation_id: uid(), table: BOARD, op: 'insert', pk: uid(), columns: { team_id: TEAM_A, title: 'pushed' } },
  { mutation_id: uid(), table: NOTES, op: 'insert', pk: uid(), columns: { title: 'pushed' } },
]

const BUCKETS: TBucket[] = [
  { table: BOARD, params: { team_id: TEAM_A } },
  { table: NOTES, params: {} },
]

/** What the cases read: the two dumps, the rows before and after the re-apply, and the re-apply's error, if any. */
const state = {
  freshDump: '',
  reappliedDump: '',
  before: {} as TSnapshot,
  after: {} as TSnapshot,
  reapplyError: null as string | null,
}

let conv: SQL | null = null

/** The kizunasync schema as pg_dump prints it, without the `\restrict` lines whose key changes on every run. */
function dumpSchema(): string {
  const result = Bun.spawnSync(DUMP!, { stdout: 'pipe', stderr: 'pipe' })

  if (result.exitCode !== 0) {
    throw new Error(`pg_dump failed: ${result.stderr.toString()}`)
  }
  return result.stdout
    .toString()
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join('\n')
}

/** Drops the throwaway database and opens a connection to a new, empty one carrying the vendor stub. */
async function freshDatabase(): Promise<SQL> {
  if (conv !== null) {
    await conv.end()
    conv = null
  }
  await db!.unsafe(`drop database if exists ${THROWAWAY} with (force)`)
  await db!.unsafe(`create database ${THROWAWAY}`)
  const conn = new SQL(THROWAWAY_URL, { max: 1 })

  await conn.unsafe(STUB_SQL)
  conv = conn

  return conn
}

/** The rows `query` returns, as JSON objects in a fixed order. */
async function readJson(conn: SQL, query: string): Promise<unknown[]> {
  const [row] = await conn.unsafe(
    `select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb) as rows from (${query}) x`,
  )

  return row.rows as unknown[]
}

/** Every row of every kizunasync table and of the synced tables, and the change sequence's position. */
async function readRows(conn: SQL): Promise<TSnapshot> {
  const tables = await conn.unsafe(`select tablename::text as name from pg_tables where schemaname = 'kizunasync' order by 1`)
  const snapshot: TSnapshot = {}

  for (const { name } of tables as { name: string }[]) {
    snapshot[`kizunasync.${name}`] = await readJson(conn, `select * from kizunasync."${name}"`)
  }
  for (const { name } of SYNCED) {
    snapshot[`public.${name}`] = await readJson(conn, `select * from public."${name}"`)
  }
  snapshot['kizunasync._change_seq'] = await readJson(conn, 'select last_value, is_called from kizunasync._change_seq')

  return snapshot
}

/** The two tables, readable and writable by every signed-in user, and the writer. */
async function createTables(conn: SQL): Promise<void> {
  await conn.unsafe(`
    create table public.${BOARD} (id uuid primary key, team_id uuid not null, title text not null);
    create table public.${NOTES} (id uuid primary key, title text not null);
    alter table public.${BOARD} enable row level security;
    alter table public.${NOTES} enable row level security;
    grant select, insert, update, delete on public.${BOARD}, public.${NOTES} to authenticated;
    create policy reapply_all on public.${BOARD} for all to authenticated using (true) with check (true);
    create policy reapply_all on public.${NOTES} for all to authenticated using (true) with check (true);
  `)
  await conn`insert into auth.users (id) values (${WRITER})`
}

/** The statements the config migration of `kizunasync init` runs for one table. */
function provisionSql(table: ISyncedTable): string {
  const bucket = table.bucketColumn === null ? 'null' : `'${table.bucketColumn}'`

  return `
    insert into kizunasync._config (table_name, sync_mode, bucket_column, register_clients, min_schema_version)
    values ('${table.name}', 'read-write', ${bucket}, ${table.registerClients}, 1);
    drop trigger if exists kizunasync_track_change on public.${table.name};
    create trigger kizunasync_track_change after insert or update on public.${table.name}
      for each row execute function kizunasync.track_change();
    drop trigger if exists kizunasync_track_delete on public.${table.name};
    create trigger kizunasync_track_delete after delete on public.${table.name}
      for each row execute function kizunasync.track_delete();
    select kizunasync._seed_changelog('${table.name}');
    insert into kizunasync._provisions (object_kind, object_name, content_hash, pack_version)
    values
      ('config', 'public.${table.name}', md5('${table.name}:read-write:${table.bucketColumn ?? ''}'), '${PACK_VERSION}'),
      ('trigger', 'public.${table.name}.kizunasync_track_change', md5('track_change'), '${PACK_VERSION}'),
      ('trigger', 'public.${table.name}.kizunasync_track_delete', md5('track_delete'), '${PACK_VERSION}')
    on conflict (object_kind, object_name) do nothing;
  `
}

/** Every synced table's config row, triggers, seed, and ledger rows, in one transaction. */
async function provision(conn: SQL): Promise<void> {
  await conn.begin(async (tx) => {
    for (const table of SYNCED) {
      await tx.unsafe(provisionSql(table))
    }
  })
}

async function insertBoard(conn: SQL, pk: string, team: string, title: string): Promise<void> {
  await conn.unsafe(`insert into public.${BOARD} (id, team_id, title) values ($1, $2, $3)`, [pk, team, title])
}

async function insertNote(conn: SQL, pk: string, title: string): Promise<void> {
  await conn.unsafe(`insert into public.${NOTES} (id, title) values ($1, $2)`, [pk, title])
}

/** Direct writes after provisioning: inserts, one update, and a delete on each table. */
async function writeRows(conn: SQL): Promise<void> {
  await insertBoard(conn, BOARD_WRITTEN_A, TEAM_A, 'written')
  await insertBoard(conn, BOARD_WRITTEN_B, TEAM_B, 'written')
  await insertBoard(conn, BOARD_DELETED_A, TEAM_A, 'deleted')
  await insertNote(conn, NOTE_WRITTEN, 'written')
  await insertNote(conn, NOTE_DELETED, 'deleted')
  await conn.unsafe(`update public.${BOARD} set title = 'updated' where id = $1`, [BOARD_BEFORE_A])
  await conn.unsafe(`delete from public.${BOARD} where id = $1`, [BOARD_DELETED_A])
  await conn.unsafe(`delete from public.${NOTES} where id = $1`, [NOTE_DELETED])
}

/** One committed request as the writer, with the JWT claims and the authenticated role. */
async function asWriter<T>(conn: SQL, body: (tx: SQL) => Promise<T>): Promise<T> {
  return conn.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims(WRITER)}, true)`
    await tx`set local role authenticated`

    return body(tx as unknown as SQL)
  })
}

/** The Storage object `attachment_confirm` requires, then the writer's confirm of it. */
async function confirmAttachment(conn: SQL): Promise<void> {
  await conn`insert into storage.buckets (id, name) values (${ATTACHMENT_BUCKET}, ${ATTACHMENT_BUCKET})`
  await conn`insert into storage.objects (bucket_id, name, owner_id) values (${ATTACHMENT_BUCKET}, ${ATTACHMENT_PATH}, ${WRITER})`
  await asWriter(conn, (tx) =>
    tx`select kizunasync.attachment_confirm(${ATTACHMENT_BUCKET}, ${ATTACHMENT_PATH}, ${ATTACHMENT_SHA}, 10, 'image/png')`,
  )
}

/** Everything the install holds before the re-apply, written through its own objects. */
async function writeInstall(conn: SQL): Promise<void> {
  await conn.unsafe(PACK_SQL)
  await conn`
    insert into kizunasync._provisions (object_kind, object_name, content_hash, pack_version)
    values ('pack-file', ${PACK_FILE}, md5(${PACK_SQL}), ${PACK_VERSION})`
  await conn`update kizunasync._settings set tombstone_ttl_days = 45 where id`
  await createTables(conn)
  await insertBoard(conn, BOARD_BEFORE_A, TEAM_A, 'before')
  await insertBoard(conn, BOARD_BEFORE_B, TEAM_B, 'before')
  await insertNote(conn, NOTE_BEFORE, 'before')
  await provision(conn)
  await writeRows(conn)
  await asWriter(conn, (tx) => tx`select kizunasync.push(${{ atomic: false, mutations: PUSHED }}::jsonb, null::uuid, 1)`)
  await asWriter(conn, (tx) => tx`select kizunasync.pull(${BUCKETS}::jsonb, '0', 1, 500, ${CLIENT}::uuid)`)
  await confirmAttachment(conn)
}

beforeAll(async () => {
  if (!ready) {
    return
  }
  const fresh = await freshDatabase()

  await fresh.unsafe(PACK_SQL)
  state.freshDump = dumpSchema()

  const installed = await freshDatabase()

  await writeInstall(installed)
  state.before = await readRows(installed)

  try {
    await installed.unsafe(PACK_SQL)
  } catch (error) {
    state.reapplyError = error instanceof Error ? error.message : String(error)
  }
  state.reappliedDump = dumpSchema()
  state.after = await readRows(installed)
}, 120_000)

afterAll(async () => {
  if (conv !== null) {
    await conv.end()
  }
  if (db !== null) {
    if (ready) {
      await db.unsafe(`drop database if exists ${THROWAWAY} with (force)`)
    }
    await db.end()
  }
})

// MARK: - Cases

const rowsOf = (snapshot: TSnapshot, table: string): unknown[] => snapshot[`kizunasync.${table}`] ?? []

describe.skipIf(!ready)('re-applying 0001 over an install of itself', () => {
  test('the re-apply runs without an error', () => {
    expect(state.reapplyError).toBeNull()
  })

  test('the kizunasync schema dumps exactly like a fresh install', () => {
    expect(state.reappliedDump.length).toBeGreaterThan(0)
    expect(state.reappliedDump).toBe(state.freshDump)
  })

  test('the install holds every kind of row the fixture writes', () => {
    const kinds = rowsOf(state.before, '_provisions').map((row) => (row as { object_kind: string }).object_kind)

    expect(rowsOf(state.before, '_config')).toHaveLength(SYNCED.length)
    expect(rowsOf(state.before, '_changelog').length).toBeGreaterThan(0)
    expect(rowsOf(state.before, '_tombstones')).toHaveLength(2)
    expect(rowsOf(state.before, '_verdicts')).toHaveLength(PUSHED.length)
    expect(rowsOf(state.before, '_clients')).toHaveLength(1)
    expect(rowsOf(state.before, '_bucket_grants')).toHaveLength(BUCKETS.length)
    expect(rowsOf(state.before, 'attachments')).toHaveLength(1)
    expect(rowsOf(state.before, '_settings')).toEqual([expect.objectContaining({ tombstone_ttl_days: 45 })])
    expect(new Set(kinds)).toEqual(new Set(['function', 'policy', 'cron', 'role', 'pack-file', 'config', 'trigger']))
  })

  test('every row the install held survives the re-apply unchanged', () => {
    expect(Object.keys(state.after).sort()).toEqual(Object.keys(state.before).sort())

    for (const [table, rows] of Object.entries(state.before)) {
      expect(state.after[table], table).toEqual(rows)
    }
  })
})
