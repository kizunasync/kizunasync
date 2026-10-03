// MARK: - @kizunasync/core/config: the typed authoring surface

/**
 * `defineConfig<Database>` is the config a real app writes by hand and passes to
 * `createKizunaSync`. It is typed against the generated supabase-js `Database`, so a
 * typo'd table or column is a compile error: external data is validated at the
 * boundary by its canonical schema. At runtime it returns a plain `TKizunaSyncConfig`
 * that `createKizunaSync` maps to the engine's `TEngineConfig`. No domain-table
 * knowledge lives here; everything is keyed on `keyof DB['public']['Tables']`.
 */

import { EConflictMode, type TConflictMode, type TSyncMode } from '../wire/types'

// MARK: - Database shape

/**
 * The generated `Database` has `public.Tables.<name>.Row` with the column map.
 * We only need the table names (keys) and each table's column names (Row keys)
 * for compile-time validation, modeled with `unknown` leaves, never `any`.
 */
export type TDatabase = {
  public: {
    Tables: Record<string, { Row: Record<string, unknown> }>
  }
}

/** The table names of a generated Database. */
type TTableName<DB extends TDatabase> = keyof DB['public']['Tables'] & string

/** The column names of one table's Row. */
type TColumnName<DB extends TDatabase, T extends TTableName<DB>> =
  keyof DB['public']['Tables'][T]['Row'] & string

// MARK: - Bucket helpers

/**
 * byOwner(col): the owner equality is auto-detected from RLS auth.uid() = col;
 *   its value is the signed-in identity, unknown until sign-in.
 * byColumn(col): a runtime-parameterized tenant column, set via
 *   kizunasync.setBucket({ <col>: value }).
 * Both reduce to the engine's single bucketColumn; the kind is intent the
 * runtime branches on (byColumn is the one setBucket fills). `kizunasync init`
 * infers an owner column from RLS, separately from this object.
 */
export const EBucketKind = {
  byColumn: 'byColumn',
  byOwner: 'byOwner',
} as const
export type TBucketKind = (typeof EBucketKind)[keyof typeof EBucketKind]

export type TBucketSpec<C extends string = string> = {
  column: C
  kind: TBucketKind
}

export const byOwner = <C extends string>(column: C): TBucketSpec<C> => ({
  column,
  kind: EBucketKind.byOwner,
})

export const byColumn = <C extends string>(column: C): TBucketSpec<C> => ({
  column,
  kind: EBucketKind.byColumn,
})

// MARK: - Attachment helper

/**
 * attachment(bucket, { ownerColumn }) maps a column to a Storage bucket and
 * drives the upload queue for it: the column holds an attachment REFERENCE
 * (the Storage object key), the bytes travel out of band. ownerColumn is the row
 * column whose value owns the object, so the key derives from it and is
 * identical on every device (never auth.uid()); when omitted, a byOwner bucket's
 * column is used, otherwise createKizunaSync throws.
 */
export type TAttachmentSpec = {
  storageBucket: string
  ownerColumn?: string
}

export const attachment = (
  storageBucket: string,
  options: { ownerColumn?: string } = {},
): TAttachmentSpec =>
  options.ownerColumn === undefined
    ? { storageBucket }
    : { storageBucket, ownerColumn: options.ownerColumn }

// MARK: - Per-table + top-level config shapes

/**
 * One synced table, typed against its Database row. bucket columns,
 * attachment/softDelete columns and key columns are constrained to real column
 * names ⇒ a typo is a compile error.
 */
export interface ITableConfig<DB extends TDatabase, T extends TTableName<DB>> {
  sync: TSyncMode
  bucket?: TBucketSpec<TColumnName<DB, T>>
  attachments?: Partial<Record<TColumnName<DB, T>, TAttachmentSpec>>
  conflict?: TConflictMode
  softDelete?: TColumnName<DB, T>

  /**
   * The table's primary-key columns in key order, `'id'` when absent. The
   * kernel derives each row's pk from them and refuses a write that changes
   * one. A table with attachment columns keeps `'id'`.
   */
  key?: TColumnName<DB, T> | readonly TColumnName<DB, T>[]
}

/**
 * The full config. tables is keyed on real Database table names ⇒ a typo'd
 * table is a compile error.
 */
export interface IKizunaSyncConfigInput<DB extends TDatabase> {
  tables: { [T in TTableName<DB>]?: ITableConfig<DB, T> }
  pullLimit?: number
  realtimeWakeups?: boolean

  /**
   * Jittered poll fallback interval (ms): when > 0 the engine self-reschedules
   * a sync() in [pollIntervalMs/2, pollIntervalMs] so a missed realtime wakeup
   * only delays the next pull. The app-facing createKizunaSync defaults to 15 s when
   * both config and options omit it; set 0 to opt out.
   */
  pollIntervalMs?: number

  /**
   * The client's schema version, sent on every pull and push. The server
   * refuses a client below its `min_schema_version` with RESET_REQUIRED. Bump
   * this after a breaking table change, together with `kizunasync sync
   * --min-schema-version`. Default 1.
   */
  schemaVersion?: number

  /**
   * How many transfer attempts one attachment gets before the queue stops it
   * for good: the row lands `failed` with `permanent` set, no drive claims it
   * again, and only `attachments.retry(ref)` puts it back. Default 5.
   */
  attachmentAttempts?: number
}

/**
 * The resolved config value defineConfig returns (erased of the DB generic so
 * it is a plain runtime value createKizunaSync can map).
 */
export type TKizunaSyncConfig = {
  tables: Record<string, IResolvedTableConfig>
  pullLimit: number
  realtimeWakeups: boolean

  /**
   * createKizunaSync applies its 15 s app-facing default when this and the matching
   * option are absent; 0 disables polling.
   */
  pollIntervalMs?: number

  /** Absent ⇒ createKizunaSync's default of 1. */
  schemaVersion?: number

  /** Absent ⇒ the kernel's own transfer budget. */
  attachmentAttempts?: number
}

export interface IResolvedTableConfig {
  sync: TSyncMode
  bucket?: TBucketSpec
  attachments?: Record<string, TAttachmentSpec>
  conflict: TConflictMode
  softDelete?: string

  /** The key columns the input named, as a list. Absent ⇒ `['id']`. */
  key?: readonly string[]
}

// MARK: - Defaults

const DEFAULT_PULL_LIMIT = 500
const DEFAULT_REALTIME_WAKEUPS = true
const DEFAULT_CONFLICT: TConflictMode = EConflictMode.arrival

// MARK: - defineConfig

/**
 * Author the runtime config, typed against the generated Database. Applies the
 * documented defaults (conflict: arrival, pullLimit: 500,
 * realtimeWakeups: true, schemaVersion: 1, the kernel's own
 * attachmentAttempts). Server-side settings live in kizunasync._config and
 * kizunasync._settings, which `kizunasync init` and `kizunasync sync` provision: tombstone
 * retention, the push policy and the per-table conflict journal.
 */
export const defineConfig = <DB extends TDatabase>(
  input: IKizunaSyncConfigInput<DB>,
): TKizunaSyncConfig => {
  const tables: Record<string, IResolvedTableConfig> = {}

  for (const [table, tableConfig] of Object.entries(input.tables)) {
    if (tableConfig === undefined) {
      continue
    }
    tables[table] = resolveTableConfig<DB>(tableConfig)
  }
  const resolved: TKizunaSyncConfig = {
    tables,
    pullLimit: input.pullLimit ?? DEFAULT_PULL_LIMIT,
    realtimeWakeups: input.realtimeWakeups ?? DEFAULT_REALTIME_WAKEUPS,
  }

  // Absent ⇒ leave off; never coerce undefined into a 0 that reads as "set".
  if (input.pollIntervalMs !== undefined) {
    resolved.pollIntervalMs = input.pollIntervalMs
  }
  if (input.schemaVersion !== undefined) {
    resolved.schemaVersion = input.schemaVersion
  }
  if (input.attachmentAttempts !== undefined) {
    resolved.attachmentAttempts = input.attachmentAttempts
  }
  return resolved
}

/** One entry of the input's `tables`, whichever table it configures. */
type TTableConfigInput<DB extends TDatabase> = NonNullable<IKizunaSyncConfigInput<DB>['tables'][TTableName<DB>]>

function resolveTableConfig<DB extends TDatabase>(tableConfig: TTableConfigInput<DB>): IResolvedTableConfig {
  const resolved: IResolvedTableConfig = {
    sync: tableConfig.sync,
    conflict: tableConfig.conflict ?? DEFAULT_CONFLICT,
  }

  if (tableConfig.bucket !== undefined) {
    resolved.bucket = tableConfig.bucket
  }
  if (tableConfig.attachments !== undefined) {
    resolved.attachments = tableConfig.attachments as Record<string, TAttachmentSpec>
  }
  if (tableConfig.softDelete !== undefined) {
    resolved.softDelete = tableConfig.softDelete
  }
  if (tableConfig.key !== undefined) {
    resolved.key = toKeyColumns(tableConfig.key)
  }
  return resolved
}

/** A single column becomes a one-column key and a list is copied; the kernel refuses a malformed key with CONFIG_INVALID. */
function toKeyColumns(key: string | readonly string[]): readonly string[] {
  return typeof key === 'string' ? [key] : Array.from(key)
}
