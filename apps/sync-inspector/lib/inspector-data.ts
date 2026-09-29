import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { ECHANGE_OP } from '@/lib/describe-change'
import { crontabGuruUrl, formatCount, FRESH_MAX_MS, IDLE_MAX_MS } from '@/lib/formatters'

// MARK: - Row shapes

export interface ITodoRow {
  id: string
  title: string
  done: boolean
  image_path: string | null
  updated_at: string
  user_id: string
  deleted_at: string | null
}

export interface IClientRow {
  client_id: string
  user_id: string
  cursor: number
  schema_version: number
  last_seen: string
}

export interface IChangelogRow {
  seq: number
  table_name: string
  pk: string
  op: string
  arrived_at: string
}

/**
 * `kizunasync._tombstones`: the pack's exclusive record of row removals, one
 * per row and bucket value it left: a delete, or a write that moved the row to
 * another bucket value. The change-capture trigger (`track_delete`) writes only
 * here, never to `_changelog`, so a delete is invisible until this table is
 * read too.
 */
export interface ITombstoneRow {
  table_name: string
  pk: string
  seq: number
  deleted_at: string
}

/**
 * `kizunasync._verdicts` rows whose verdict is `rejected`. `reason` comes from
 * the verdict jsonb, guarded rather than trusted, the same posture
 * `describe-change.ts` takes with `_changelog.op`. The ledger stores no row
 * copy, so `hasServerRow` follows from the reason: whether the rejection
 * handed the client a `server_row`.
 */
export interface IVerdictRow {
  mutation_id: string
  reason: string | null
  recorded_at: string
  hasServerRow: boolean
}

interface IConfigRow {
  table_name: string
  sync_mode: string
  conflict_mode: string
}

/**
 * `kizunasync._settings`: the single-row push policy, pull scan cap, retention
 * knobs, and job schedules. All ten columns, transposed into `ISettingsFieldRow`
 * for display: see `settingsFieldRows`.
 */
export interface ISettingsRow {
  id: boolean
  max_batch_size: number | null
  require_atomic: boolean
  reap_schedule: string
  compact_schedule: string
  client_prune_schedule: string
  client_ttl_days: number
  hlc_max_skew_ms: number
  tombstone_ttl_days: number
  max_pull_scan: number
}

export interface ISettingsFieldRow {
  field: string
  value: string

  /** Present only on the three schedule fields: a crontab.guru link. */
  href?: string
}

/**
 * One row per `_settings` column, in column order: a table primitive reads
 * naturally as rows, while the source is a single wide row.
 */
export function settingsFieldRows(row: ISettingsRow): ISettingsFieldRow[] {
  return [
    { field: 'id', value: row.id ? 'true' : 'false' },
    {
      field: 'max_batch_size',
      value: row.max_batch_size === null ? 'unlimited' : formatCount(row.max_batch_size),
    },
    { field: 'require_atomic', value: row.require_atomic ? 'true' : 'false' },
    { field: 'reap_schedule', value: row.reap_schedule, href: crontabGuruUrl(row.reap_schedule) },
    { field: 'compact_schedule', value: row.compact_schedule, href: crontabGuruUrl(row.compact_schedule) },
    {
      field: 'client_prune_schedule',
      value: row.client_prune_schedule,
      href: crontabGuruUrl(row.client_prune_schedule),
    },
    { field: 'client_ttl_days', value: `${String(row.client_ttl_days)} days` },
    { field: 'hlc_max_skew_ms', value: `${String(row.hlc_max_skew_ms)} ms` },
    { field: 'tombstone_ttl_days', value: `${String(row.tombstone_ttl_days)} days` },
    { field: 'max_pull_scan', value: `${formatCount(row.max_pull_scan)} candidates` },
  ]
}

/**
 * `kizunasync._reap_state`: the singleton retention watermark. `reaped_at` is
 * null before the first run.
 */
export interface IReapStateRow {
  reaped_seq: number
  reaped_at: string | null
}

/** Per-table tombstone count, computed server-side (see `groupTombstonesByTable`). */
export interface ITombstoneTableCount {
  table_name: string
  count: number
}

/**
 * `kizunasync._conflict_journal`: one row per same-column overwrite, opt-in
 * per table via `_config.conflict_journal`.
 */
export interface IConflictJournalRow {
  id: number
  table_name: string
  pk: string
  column_name: string
  loser_value: unknown
  winner_mutation_id: string
  conflict_mode: string
  winner_seq: number | null
  recorded_at: string
}

/**
 * `kizunasync.attachments`: metadata for a confirmed upload. Bytes live in
 * Storage; this row carries the reference and integrity metadata.
 */
export interface IAttachmentRow {
  id: string
  bucket_id: string
  object_path: string
  sha256: string | null
  size: number | null
  media_type: string | null
  created_at: string
  updated_at: string
}

/**
 * `kizunasync.jobs_status()`: the three pack jobs from `cron.job` already
 * joined to their latest `cron.job_run_details` row, server-side. Empty when
 * pg_cron is absent: the panel's empty state, not an error.
 */
export interface IJobRow {
  jobname: string
  schedule: string
  active: boolean
  last_start: string | null
  last_status: string | null
  last_message: string | null
}

/**
 * The raw shape of one `jobs_status()` row: supabase-js's untyped `.rpc()`
 * cannot prove this at compile time (see `fetchJobs`), so it is pinned here
 * as a named, testable contract rather than trusted by a blind cast.
 */
interface IJobStatusRecord {
  jobname: string
  schedule: string
  active: boolean
  last_start: string | null
  last_status: string | null
  last_message: string | null
}

/**
 * Pure pass-through of `jobs_status()`'s own contract into `IJobRow`: the
 * join already happened server-side, so this only documents and tests the
 * columns the panel depends on, rather than trusting an untyped RPC cast.
 */
export function toJobRow(record: IJobStatusRecord): IJobRow {
  return {
    jobname: record.jobname,
    schedule: record.schedule,
    active: record.active,
    last_start: record.last_start,
    last_status: record.last_status,
    last_message: record.last_message,
  }
}

const UNCONFIGURED_TOMBSTONE_TABLE = '(unconfigured tables)'

/**
 * Turns per-table exact counts (each an independent `head: true` query, never
 * a row fetch PostgREST's `max_rows` could cap) plus the exact grand total
 * into a reconciled breakdown. A table whose `_config` row was since removed
 * still leaves tombstones behind until they are reaped. The difference
 * between the total and what the known tables account for is never dropped;
 * it becomes one named row. The panel's numbers always add up to the same
 * total the rest of the app reports.
 */
export function reconcileTombstoneCounts(
  total: number,
  perTable: readonly { table_name: string; count: number }[],
): ITombstoneTableCount[] {
  const rows = perTable.filter((entry) => entry.count > 0)
  const accounted = rows.reduce((sum, entry) => sum + entry.count, 0)
  const remainder = total - accounted
  const withRemainder = remainder > 0 ? [...rows, { table_name: UNCONFIGURED_TOMBSTONE_TABLE, count: remainder }] : rows

  return [...withRemainder].sort((a, b) => b.count - a.count || a.table_name.localeCompare(b.table_name))
}

/**
 * Exact global counts, partitioned by the same thresholds the fleet table
 * chips use. Null when a count query failed: the strip then says nothing
 * about the split rather than showing a total that does not add up.
 */
interface IClientFleet {
  fresh: number
  idle: number
  gone: number
}

export type TPanelState<TRow> =
  | { kind: 'rows'; rows: TRow[]; count: number | null }
  | { kind: 'not-exposed' }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'error'; detail: string }

export interface IInspectorData {
  todos: TPanelState<ITodoRow>
  clients: TPanelState<IClientRow>
  changelog: TPanelState<IChangelogRow>
  tombstones: TPanelState<ITombstoneRow>
  rejectedVerdicts: TPanelState<IVerdictRow>
  config: TPanelState<IConfigRow>
  fleet: IClientFleet | null

  /**
   * The pack_version recorded on the newest `_provisions` row: null when the
   * read failed, same posture as `fleet`: a strip scalar, not a panel.
   */
  packVersion: string | null

  settings: TPanelState<ISettingsRow>
  jobs: TPanelState<IJobRow>
  reapState: TPanelState<IReapStateRow>
  tombstonesByTable: TPanelState<ITombstoneTableCount>

  /**
   * Exact `_changelog` row count, scalar like `packVersion`: the retention
   * panel reports it beside the reap watermark, not as a row list of its own.
   */
  changelogRowCount: number | null

  conflictJournal: TPanelState<IConflictJournalRow>
  attachments: TPanelState<IAttachmentRow>

  /**
   * When the server produced this snapshot. The strip's "updated Ns ago"
   * counts from here, so it measures the data's age rather than the age of
   * whichever refresh mechanism happened to fire.
   */
  fetchedAt: string
}

export const LATEST_LIMIT = 10

/**
 * The fleet table shows more devices than the other panels show rows: a
 * device list is scanned for who is missing, which a page of 10 cannot serve.
 */
const CLIENTS_LIMIT = 50

const PGRST_SCHEMA_NOT_EXPOSED = 'PGRST106'

// MARK: - Error classification

function classifyError(error: PostgrestError, status: number): TPanelState<never> {
  if (error.code === PGRST_SCHEMA_NOT_EXPOSED) {
    return { kind: 'not-exposed' }
  }
  if (status === 0) {
    return { kind: 'unreachable', detail: error.message }
  }
  return { kind: 'error', detail: `${error.code}: ${error.message}` }
}

// MARK: - Queries

async function fetchTodos(supabase: SupabaseClient): Promise<TPanelState<ITodoRow>> {
  const { data, error, count, status } = await supabase
    .from('todos')
    .select('id, title, done, image_path, updated_at, user_id, deleted_at', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .limit(LATEST_LIMIT)
    .returns<ITodoRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

async function fetchClients(supabase: SupabaseClient): Promise<TPanelState<IClientRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_clients')
    .select('client_id, user_id, cursor, schema_version, last_seen', { count: 'exact' })
    .order('last_seen', { ascending: false })
    .limit(CLIENTS_LIMIT)
    .returns<IClientRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

async function fetchConfig(supabase: SupabaseClient): Promise<TPanelState<IConfigRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_config')
    .select('table_name, sync_mode, conflict_mode', { count: 'exact' })
    .order('table_name', { ascending: true })
    .returns<IConfigRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

// MARK: - Fleet freshness

type TCountRange = { from: string; to?: string }

async function countClientsSeen(
  supabase: SupabaseClient,
  range: TCountRange,
): Promise<number | null> {
  const query = supabase
    .schema('kizunasync')
    .from('_clients')
    .select('client_id', { count: 'exact', head: true })
    .gte('last_seen', range.from)
  const { count, error } = await (range.to === undefined ? query : query.lt('last_seen', range.to))

  if (error !== null) {
    return null
  }
  return count
}

async function fetchClientFleet(supabase: SupabaseClient, now: number): Promise<IClientFleet | null> {
  const freshFrom = new Date(now - FRESH_MAX_MS).toISOString()
  const idleFrom = new Date(now - IDLE_MAX_MS).toISOString()
  const epoch = new Date(0).toISOString()

  const [fresh, idle, gone] = await Promise.all([
    countClientsSeen(supabase, { from: freshFrom }),
    countClientsSeen(supabase, { from: idleFrom, to: freshFrom }),
    countClientsSeen(supabase, { from: epoch, to: idleFrom }),
  ])

  if (fresh === null || idle === null || gone === null) {
    return null
  }
  return { fresh, idle, gone }
}

async function fetchChangelog(supabase: SupabaseClient): Promise<TPanelState<IChangelogRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_changelog')
    .select('seq, table_name, pk, op, arrived_at', { count: 'exact' })
    .order('seq', { ascending: false })
    .limit(LATEST_LIMIT)
    .returns<IChangelogRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

// MARK: - Tombstones

async function fetchTombstones(supabase: SupabaseClient): Promise<TPanelState<ITombstoneRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_tombstones')
    .select('table_name, pk, seq, deleted_at', { count: 'exact' })
    .order('deleted_at', { ascending: false })
    .limit(LATEST_LIMIT)
    .returns<ITombstoneRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

function tombstoneAsChangelogRow(row: ITombstoneRow): IChangelogRow {
  return { seq: row.seq, table_name: row.table_name, pk: row.pk, op: ECHANGE_OP.DELETE, arrived_at: row.deleted_at }
}

/**
 * Tombstone deletes never land in `_changelog`: `track_delete` writes only
 * the tombstone (see the pack's change-capture triggers), so the changelog
 * view cannot show them without this merge. Newest first by arrival time,
 * capped at the same page size either source alone would use. A failure on
 * either side is surfaced rather than silently dropping the other feed's rows.
 */
export function mergeChangelogFeed(
  changelog: TPanelState<IChangelogRow>,
  tombstones: TPanelState<ITombstoneRow>,
): TPanelState<IChangelogRow> {
  if (changelog.kind !== 'rows') {
    return changelog
  }
  if (tombstones.kind !== 'rows') {
    return tombstones
  }
  const rows = [...changelog.rows, ...tombstones.rows.map(tombstoneAsChangelogRow)]
    .sort((a, b) => Date.parse(b.arrived_at) - Date.parse(a.arrived_at))
    .slice(0, LATEST_LIMIT)

  return {
    kind: 'rows',
    rows,
    count: (changelog.count ?? changelog.rows.length) + (tombstones.count ?? tombstones.rows.length),
  }
}

// MARK: - Rejected verdicts

interface IVerdictRecord {
  mutation_id: string
  verdict: unknown
  recorded_at: string
}

interface IRejectedVerdict {
  verdict: 'rejected'
  reason: string
}

/**
 * The rejection reasons whose verdict carries the row as the caller's SELECT
 * policy renders it (D-rejection-reasons). `DELETE_WINS` answers a deleted row,
 * so its `server_row` is always null, and a reason outside the closed union
 * carries nothing.
 */
const SERVER_ROW_REASONS: ReadonlySet<string> = new Set(['PRECONDITION', 'RLS_DENIED', 'COLUMN_DENIED', 'CONSTRAINT', 'SUPERSEDED'])

/**
 * `verdict` crosses the wire as jsonb; the server-side filter already limits
 * rows to `verdict->>verdict = 'rejected'`, but the shape is still narrowed
 * rather than asserted before its fields are read.
 */
function isRejectedVerdict(value: unknown): value is IRejectedVerdict {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).verdict === 'rejected'
}

export function toVerdictRow(record: IVerdictRecord): IVerdictRow {
  const rejected = isRejectedVerdict(record.verdict) ? record.verdict : null

  return {
    mutation_id: record.mutation_id,
    recorded_at: record.recorded_at,
    reason: rejected?.reason ?? null,
    hasServerRow: rejected !== null && SERVER_ROW_REASONS.has(rejected.reason),
  }
}

async function fetchRejectedVerdicts(supabase: SupabaseClient): Promise<TPanelState<IVerdictRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_verdicts')
    .select('mutation_id, verdict, recorded_at', { count: 'exact' })
    .eq('verdict->>verdict', 'rejected')
    .order('recorded_at', { ascending: false })
    .limit(LATEST_LIMIT)
    .returns<IVerdictRecord[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: (data ?? []).map(toVerdictRow), count }
}

// MARK: - Pack version

interface IProvisionVersionRecord {
  pack_version: string
}

async function fetchPackVersion(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .schema('kizunasync')
    .from('_provisions')
    .select('pack_version')
    .order('created_at', { ascending: false })
    .limit(1)
    .returns<IProvisionVersionRecord[]>()

  if (error !== null) {
    return null
  }
  return data?.[0]?.pack_version ?? null
}

// MARK: - Settings

async function fetchSettings(supabase: SupabaseClient): Promise<TPanelState<ISettingsRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_settings')
    .select(
      'id, max_batch_size, require_atomic, reap_schedule, compact_schedule, client_prune_schedule, client_ttl_days, hlc_max_skew_ms, tombstone_ttl_days, max_pull_scan',
      { count: 'exact' },
    )
    .returns<ISettingsRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

// MARK: - Jobs

async function fetchJobs(supabase: SupabaseClient): Promise<TPanelState<IJobRow>> {
  const { data, error, status } = await supabase.schema('kizunasync').rpc('jobs_status')

  if (error !== null) {
    return classifyError(error, status)
  }
  // The untyped client cannot infer a setof-row shape from .rpc() alone (it assumes a single JSON value without a typed Database schema): the same posture packages/supabase/src/rpc-remote.ts takes for every RPC result. toJobRow is the tested boundary that pins jobs_status()'s real columns.
  const records = (data ?? []) as IJobStatusRecord[]
  const rows = records.map(toJobRow)

  return { kind: 'rows', rows, count: rows.length }
}

// MARK: - Retention

async function fetchReapState(supabase: SupabaseClient): Promise<TPanelState<IReapStateRow>> {
  const { data, error, status } = await supabase
    .schema('kizunasync')
    .from('_reap_state')
    .select('reaped_seq, reaped_at')
    .returns<IReapStateRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count: data?.length ?? 0 }
}

async function fetchChangelogRowCount(supabase: SupabaseClient): Promise<number | null> {
  const { count, error } = await supabase
    .schema('kizunasync')
    .from('_changelog')
    .select('seq', { count: 'exact', head: true })

  if (error !== null) {
    return null
  }
  return count
}

async function fetchTombstoneCountForTable(supabase: SupabaseClient, tableName: string): Promise<number> {
  const { count, error } = await supabase
    .schema('kizunasync')
    .from('_tombstones')
    .select('table_name', { count: 'exact', head: true })
    .eq('table_name', tableName)

  if (error !== null) {
    return 0
  }
  return count ?? 0
}

/**
 * `tableNames` comes from the already-fetched `_config` rows: the tables the
 * pack currently tracks. Every count is an exact `head: true` query (see
 * `reconcileTombstoneCounts`), never a row fetch `max_rows` could truncate.
 */
async function fetchTombstonesByTable(
  supabase: SupabaseClient,
  tableNames: readonly string[],
): Promise<TPanelState<ITombstoneTableCount>> {
  const { count: total, error, status } = await supabase
    .schema('kizunasync')
    .from('_tombstones')
    .select('table_name', { count: 'exact', head: true })

  if (error !== null) {
    return classifyError(error, status)
  }
  const counts = await Promise.all(tableNames.map((table_name) => fetchTombstoneCountForTable(supabase, table_name)))
  const perTable = tableNames.map((table_name, index) => ({ table_name, count: counts[index] ?? 0 }))
  const rows = reconcileTombstoneCounts(total ?? 0, perTable)

  return { kind: 'rows', rows, count: rows.length }
}

// MARK: - Conflict journal

async function fetchConflictJournal(supabase: SupabaseClient): Promise<TPanelState<IConflictJournalRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('_conflict_journal')
    .select('id, table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode, winner_seq, recorded_at', {
      count: 'exact',
    })
    .order('recorded_at', { ascending: false })
    .limit(LATEST_LIMIT)
    .returns<IConflictJournalRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

// MARK: - Attachments

async function fetchAttachments(supabase: SupabaseClient): Promise<TPanelState<IAttachmentRow>> {
  const { data, error, count, status } = await supabase
    .schema('kizunasync')
    .from('attachments')
    .select('id, bucket_id, object_path, sha256, size, media_type, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(LATEST_LIMIT)
    .returns<IAttachmentRow[]>()

  if (error !== null) {
    return classifyError(error, status)
  }
  return { kind: 'rows', rows: data ?? [], count }
}

// MARK: - Status summary

export interface IStatusSummary {
  packVersion: string | null
  syncedTables: number | null
  syncedTableNames: string[] | null
  clients: number | null
  fleet: IClientFleet | null
  latestStep: number | null
  changes: number | null
  fetchedAt: string
}

/**
 * Null means the query behind a metric did not come back. Never 0: a zero is
 * a claim about the database, and a failed read cannot make one.
 */
function countOf<TRow>(state: TPanelState<TRow>): number | null {
  if (state.kind !== 'rows') {
    return null
  }
  return state.count ?? state.rows.length
}

export function summarizeInspectorData(data: IInspectorData): IStatusSummary {
  const changelog = data.changelog

  return {
    packVersion: data.packVersion,
    syncedTables: countOf(data.config),
    syncedTableNames:
      data.config.kind === 'rows' && data.config.rows.length > 0
        ? data.config.rows.map((row) => row.table_name)
        : null,
    clients: countOf(data.clients),
    fleet: data.fleet,
    // Rows arrive ordered by seq desc, so the first one carries the max.
    latestStep: changelog.kind === 'rows' ? (changelog.rows[0]?.seq ?? null) : null,
    changes: countOf(changelog),
    fetchedAt: data.fetchedAt,
  }
}

export async function loadInspectorData(supabase: SupabaseClient): Promise<IInspectorData> {
  const now = Date.now()
  const [
    todos,
    clients,
    changelog,
    tombstones,
    rejectedVerdicts,
    config,
    fleet,
    packVersion,
    settings,
    jobs,
    reapState,
    changelogRowCount,
    conflictJournal,
    attachments,
  ] = await Promise.all([
    fetchTodos(supabase),
    fetchClients(supabase),
    fetchChangelog(supabase),
    fetchTombstones(supabase),
    fetchRejectedVerdicts(supabase),
    fetchConfig(supabase),
    fetchClientFleet(supabase, now),
    fetchPackVersion(supabase),
    fetchSettings(supabase),
    fetchJobs(supabase),
    fetchReapState(supabase),
    fetchChangelogRowCount(supabase),
    fetchConflictJournal(supabase),
    fetchAttachments(supabase),
  ])
  // The per-table breakdown needs the table names `config` resolved, so it cannot join the batch above: a real dependency, not an ordering habit.
  const tombstonesByTable = await fetchTombstonesByTable(
    supabase,
    config.kind === 'rows' ? config.rows.map((row) => row.table_name) : [],
  )

  return {
    todos,
    clients,
    changelog,
    tombstones,
    rejectedVerdicts,
    config,
    fleet,
    packVersion,
    settings,
    jobs,
    reapState,
    tombstonesByTable,
    changelogRowCount,
    conflictJournal,
    attachments,
    fetchedAt: new Date(now).toISOString(),
  }
}
