// MARK: - Engine-facing contracts + re-export of the generated wire types

/**
 * The client must not import @kizunasync/protocol at runtime: the client is the
 * client, @kizunasync/protocol is the oracle. Wire message types are generated from
 * the canonical schemas into ./wire-types.generated.ts (committed; no
 * @kizunasync/protocol import) and re-exported here. One import gives the wire
 * messages and the contracts built on them. Drift is caught by
 * @kizunasync/protocol's check:gen no-diff gate.
 */

import type { IConnectivity } from '../ports/connectivity'
import type { IForeground } from '../ports/foreground'
import type { IWakeup } from '../ports/wakeup'
import type { IFileStore } from '../ports/file-store'
import type { ITransfer } from '../ports/transfer'
import type { ILogger } from '../util/logger'
/**
 * Type-only import. The handle's shape lives beside the adapter that drives it
 * and does not reach the query layer at runtime.
 */
import type { TUniffiHandle } from '../query/rust-uniffi-engine'
import { ENGINE_ERROR_CODES, ENGINE_ERROR_RETRYABLE } from './engine-error-codes.generated'

export * from './wire-types.generated'
import type { TCursor, TUuid, TColumnValue, TColumnValues, TOp, TRejectReason, TTransform, TConflictMode } from './wire-types.generated'

// MARK: - Engine configuration

/**
 * A pull bucket's params map: the indexed-column equalities (P:mutations-and-column-masked-conflict-resolution Bucket).
 * The current corpus uses exactly one owner-equality entry per table.
 */
export type TBucketParams = Record<string, boolean | number | string>

/**
 * Per-table sync mode (P:verdict-completeness-transforms-and-conflict-rejection). `readWrite` (the default authoring choice) pulls
 * and pushes. `pullOnly` pulls only: the kernel refuses every local write with
 * LOCAL_UNSUPPORTED before it reaches the outbox.
 */
export const ESyncMode = {
  pullOnly: 'pull-only',
  readWrite: 'read-write',
} as const
export type TSyncMode = (typeof ESyncMode)[keyof typeof ESyncMode]

/**
 * Per-table sync configuration. bucketColumn is the owner/tenant equality
 * column (local RLS-mirror checks and the canonical bucket key). bucketParams
 * is the equality map sent on the wire: runtime identity, rebuilt on sign-in.
 * Absent ⇒ the request build throws; it does not send an empty bucket.
 * syncMode reaches the kernel, which refuses every local write to a
 * 'pull-only' table with LOCAL_UNSUPPORTED; the server deployment's _config
 * is the backstop. conflictMode is the OPT-IN per-table resolution mode
 * (P:verdict-completeness-transforms-and-conflict-rejection): 'arrival' (the default, column-LWW by server arrival) or 'hlc'
 * (origin-order; the engine attaches the origin HLC to each mutation so the
 * server resolves by it; conflict/003). Absent ⇒ 'arrival'.
 */
export type TTableConfig = {
  bucketColumn: string
  bucketParams?: TBucketParams

  /**
   * True for a `byOwner` bucket: the engine fills the bucket value with the
   * store owner, the subject of the first token it sees, so the app never calls
   * setBucket for it. Absent ⇒ false.
   */
  bucketOwner?: boolean

  syncMode?: TSyncMode
  conflictMode?: TConflictMode

  /**
   * Resolved attachment columns (column → bucket + owner column). Absent ⇒ the
   * table has no attachments and the engine skips every queue branch for it
   * (the conformance path pays nothing). ownerColumn is required here (the
   * config resolver fills it from the byOwner bucket or throws).
   */
  attachments?: Record<string, { storageBucket: string; ownerColumn: string }>

  /**
   * The column that holds the soft-delete marker (e.g. 'deleted_at'). When set,
   * `delete()` on this table performs the soft update instead of a hard delete:
   * the kernel stamps this column with its own `now` and queues an ordinary
   * update. A row the column marks is excluded from every local read and from
   * write targeting unless the caller asks for `includeDeleted()`. Only the
   * low-level `apply` port with op:'delete' still raises SOFT_DELETE_VIOLATION.
   * The server-side _config.soft_delete_column mirrors this value (provisioned by
   * the CLI).
   */
  softDelete?: string
}

/**
 * Lifecycle of one queued attachment (a row in _kizunasync_attachments). Upload:
 * queued → uploading → (confirm) → synced. Download (lazy, on first use):
 * queued → downloading → synced. orphaned marks this user's object for removal
 * from Storage once server evidence says no row carries it. evicted marks a
 * copy this device dropped without that evidence (another user's object, a
 * row that only left this device): the vacuum deletes its cached bytes, never
 * the Storage object, and the row keeps the hash that verifies it again.
 *
 * `failed` is two outcomes, distinguished by the row's `permanent` flag:
 * false, the next drive retries it; true, the transfer budget
 * (attachmentAttempts) is spent and nothing picks it up until the app calls
 * `retry(ref)`. A cancelled transfer lands `failed` with `permanent` false,
 * so the next drive retries it.
 */
export const EAttachmentState = {
  queued: 'queued',
  uploading: 'uploading',
  synced: 'synced',
  downloading: 'downloading',
  failed: 'failed',
  orphaned: 'orphaned',
  evicted: 'evicted',
} as const
export type TAttachmentState = (typeof EAttachmentState)[keyof typeof EAttachmentState]

/**
 * Runtime config the engine branches on: capabilities, never a driver name
 * (@../../../../CONVENTIONS.md). Mirrors the transcript `context.server` + bucket
 * shape.
 */
export type TEngineConfig = {
  tables: Record<string, TTableConfig>
  schemaVersion: number
  defaultLimit?: number

  /**
   * How many transfer attempts one attachment gets before the queue stops it
   * for good. Absent ⇒ the engine's own default.
   */
  attachmentAttempts?: number
}

// MARK: - Local-store row + mutation shapes

/**
 * A committed local row (the applied mirror). columns holds the { column:
 * value } map. The field name matches the `local-row` check vocabulary the
 * conformance harness compares against (transcript.schema.json).
 */
export type TLocalRow = {
  table: string
  pk: TUuid
  columns: TColumnValues
}

/**
 * An application-level write request handed to engine.apply(): the same
 * field set as TMutation minus the wire-assigned mutation_id (the engine
 * mints it via the injected uuid). precondition is the optional CAS mask.
 * batchId groups consecutive writes into ONE atomic push (P:verdict-completeness-transforms-and-conflict-rejection all-or-nothing,
 * D-atomic-batch-abort): writes sharing a non-null batchId are sent together with atomic:true
 * and revert together on abort; absent ⇒ an independent non-atomic write.
 */
export type TLocalMutation = {
  table: string
  pk: TUuid
  op: TOp
  columns: TColumnValues
  precondition?: TColumnValues
  batchId?: string

  /**
   * The origin HLC string ("<iso>|<logical>|<node>") pinned for an hlc-mode
   * mutation (conflict/003); the harness feeds the transcript's value. Absent
   * ⇒ the engine mints one for an hlc-mode table. An arrival-mode table
   * carries no hlc either way.
   */
  hlc?: string

  /** Wire field transforms for op:'update' (D-field-transforms). Absent on insert/delete. */
  transforms?: Record<string, TTransform>
}

/**
 * One decoded row of the durable outbox (JSON columns parsed): what the engine
 * reports through `inspect()` and what the inspector projects. batchId is the
 * atomic-batch grouping id (null ⇒ independent, non-atomic); preImage is the
 * pre-write row state (null ⇒ the row did not exist, so the abort revert is a
 * local delete).
 */
export type TOutboxEntry = {
  seq: number
  mutationId: string
  table: string
  pk: string
  op: TOp
  columns: TColumnValues
  transforms: Record<string, TTransform> | null
  precondition: TColumnValues | null
  baseHint: unknown
  batchId: string | null
  preImage: TColumnValues | null

  /**
   * The origin HLC string for hlc-mode tables (conflict/003); null ⇒ no hlc
   * (arrival-mode, where the request build emits no hlc field).
   */
  hlc: string | null

  createdAt: string
  inFlight: boolean
}

/**
 * Why the engine soft-blocked sync until `reset()`: the server's schema gate
 * answered `RESET_REQUIRED`, or a token of another user than the one the
 * store belongs to reached it.
 */
export const ESoftBlockReason = {
  resetRequired: 'reset_required',
  identityChanged: 'identity_changed',
} as const
export type TSoftBlockReason = (typeof ESoftBlockReason)[keyof typeof ESoftBlockReason]

/** The durable checkpoint state (P:cursor-monotonicity-rebase-and-atomic-checkpoints cursor + schema handshake). */
export type TCheckpointState = {
  cursor: TCursor
  schemaVersion: number
  softBlocked: boolean

  /** Absent while sync is not soft-blocked. */
  softBlockReason?: TSoftBlockReason
}

/** Placeholder checkpoint a binding shows until the first async read resolves; never surfaced as real state. */
export const INITIAL_CHECKPOINT_STATE: TCheckpointState = {
  cursor: '',
  schemaVersion: 0,
  softBlocked: false,
}

// MARK: - Events

/**
 * Emitted side-channel notifications. The closed catalog is the corpus `event`
 * check vocabulary plus `LOCAL_CHANGED`, which is client-local and never
 * asserted on the wire (closed, no fallback; @../../../../CONVENTIONS.md).
 * `QUEUE_DEPTH` is emitted after every local write.
 */
export const EEngineEventType = {
  LOCAL_CHANGED: 'LOCAL_CHANGED',
  MUTATION_REJECTED: 'MUTATION_REJECTED',
  BATCH_ABORTED: 'BATCH_ABORTED',
  CHECKPOINT_EXPIRED: 'CHECKPOINT_EXPIRED',
  RESET_REQUIRED: 'RESET_REQUIRED',
  DEAD_LETTER: 'DEAD_LETTER',
  QUEUE_DEPTH: 'QUEUE_DEPTH',
  COLUMN_OVERWRITTEN: 'COLUMN_OVERWRITTEN',
} as const
export type TEngineEventType = (typeof EEngineEventType)[keyof typeof EEngineEventType]

export type TEngineEvent =
  /**
   * Emitted whenever the local row store changes, either because a local
   * optimistic write was applied or because a pull applied incoming rows, so
   * reactive bindings re-read. Carries no payload: subscribers re-query the
   * local store.
   */
  | { type: typeof EEngineEventType.LOCAL_CHANGED }
  | { type: typeof EEngineEventType.MUTATION_REJECTED; mutationId: TUuid; reason: TRejectReason }
  | { type: typeof EEngineEventType.BATCH_ABORTED; offenderMutationId: TUuid; reason: TRejectReason }
  | { type: typeof EEngineEventType.CHECKPOINT_EXPIRED }
  /** `reason` names why the engine soft-blocked sync; absent when the engine names none. */
  | { type: typeof EEngineEventType.RESET_REQUIRED; reason?: TSoftBlockReason }
  | { type: typeof EEngineEventType.DEAD_LETTER; mutationId: TUuid; reason: string }
  | { type: typeof EEngineEventType.QUEUE_DEPTH; depth: number }
  | {
      type: typeof EEngineEventType.COLUMN_OVERWRITTEN
      table: string
      pk: TUuid
      column: string
      loserValue: unknown
      winnerMutationId: TUuid
      conflictMode: TConflictMode
    }

// MARK: - Wire observation catalogs

/**
 * Closed kinds a host's interleaved wire ring uses: engine events, RPC round
 * trips, per-mutation verdicts, and host notes. The ring itself is host-owned;
 * this catalog is the discriminant so every renderer switches exhaustively.
 */
export const EWireEntryKind = {
  engine: 'engine',
  rpc: 'rpc',
  verdict: 'verdict',
  note: 'note',
} as const
export type TWireEntryKind = (typeof EWireEntryKind)[keyof typeof EWireEntryKind]

/**
 * The two protocol RPCs a host tap can observe: `kizunasync.pull` and
 * `kizunasync.push`.
 */
export const ERpcKind = {
  pull: 'pull',
  push: 'push',
} as const
export type TRpcKind = (typeof ERpcKind)[keyof typeof ERpcKind]

// MARK: - Rejection journal

/**
 * How a queued write died. REJECTED / SUPERSEDED come from a per-mutation
 * verdict, BATCH_ABORTED from an atomic batch's single abort outcome (recorded
 * for the offender only, since the member reverts are consequences rather than
 * verdicts), DEAD_LETTER from the sync() retry budget.
 */
export const ERejectionKind = {
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
  DEAD_LETTER: 'DEAD_LETTER',
  BATCH_ABORTED: 'BATCH_ABORTED',
} as const
export type TRejectionKind = (typeof ERejectionKind)[keyof typeof ERejectionKind]

/**
 * One journalled rejection (a row of _kizunasync_rejections). The events above are
 * fire-and-forget; the app reads this row to explain a lost write after the
 * fact. changedColumns are the columns the mutation carried; serverRow is the
 * authoritative row the verdict carried (null when it carried none); at is
 * ms epoch; dismissed is the user's acknowledgement.
 */
export type TRejectionRecord = {
  mutationId: TUuid
  table: string
  pk: TUuid
  kind: TRejectionKind
  reason: string
  changedColumns: string[]
  serverRow: TColumnValues | null
  at: number
  dismissed: boolean
}

// MARK: - Overwrite journal

/**
 * One journalled column overwrite (a row of _kizunasync_overwrites): a value this
 * device wrote that a peer's push replaced under column-LWW. COLUMN_OVERWRITTEN
 * is fire-and-forget; the app reads this row to explain a value that changed
 * under it. The winner is somebody else's write, so the row carries its own
 * `id`, which dismissOverwrite acknowledges. winnerSeq is the changelog
 * sequence the winning value arrived on, when the pull page carried one; at
 * is ms epoch.
 */
export type TOverwriteRecord = {
  id: number
  table: string
  pk: TUuid
  column: string
  loserValue: unknown
  winnerMutationId: TUuid
  conflictMode: TConflictMode
  winnerSeq: string | null
  at: number
  dismissed: boolean
}

// MARK: - Typed errors

/**
 * The engine's typed error taxonomy: the Rust-owned catalog in
 * `packages/protocol/spec/engine-errors.json`, projected by
 * `scripts/gen-engine-errors.ts`. Every loud-failure path throws one of these
 * codes (mirrors `reference.ts` fail-loud; @../../../../CONVENTIONS.md). Add a
 * code to `crates/kizunasync-engine/src/error_catalog.rs` and regenerate, never here.
 */
export const EEngineErrorCode = ENGINE_ERROR_CODES
export type TEngineErrorCode = (typeof EEngineErrorCode)[keyof typeof EEngineErrorCode]

/** Typed engine error carrying its discriminant code + optional detail. */
export class TEngineError extends Error {
  readonly code: TEngineErrorCode
  readonly detail?: unknown

  /**
   * The catalog's documented default for this code: `true` when retrying the
   * same operation unchanged may succeed (`STORE_BUSY`, a store another browser
   * context holds), `false` when it cannot (`STORE_UNAVAILABLE`). Read from the
   * generated catalog rather than set per throw site, so the answer is the same
   * wherever the error was built.
   */
  readonly retryable?: boolean

  constructor(code: TEngineErrorCode, message: string, detail?: unknown) {
    super(message)
    this.name = 'TEngineError'
    this.code = code
    this.detail = detail
    this.retryable = ENGINE_ERROR_RETRYABLE[code]
  }
}

// MARK: - Local query plan

/** The comparison kinds a local filter node carries. */
export type TQueryCompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'

/** Needle for local `contains` / `containedBy` (jsonb/array-shaped offline). */
export type TContainsValue =
  | TColumnValue
  | readonly TContainsValue[]
  | { readonly [key: string]: TContainsValue }

/**
 * One node of the local predicate grammar, tagged by `kind`. The kernel closes
 * both the kind set and the key set of every node, so a node this type admits is
 * a node the kernel accepts, and an operand it refuses (an `is` outside
 * null/true/false, a `textSearch` type outside the three) is refused there with a
 * catalog code rather than evaluated twice.
 */
export type TQueryFilter =
  | { kind: TQueryCompareOp; column: string; value: TColumnValue }
  | { kind: 'like' | 'ilike'; column: string; pattern: string }
  | { kind: 'is'; column: string; value: null | boolean }
  | { kind: 'in'; column: string; values: readonly TColumnValue[] }
  | { kind: 'contains' | 'containedBy'; column: string; value: TContainsValue }
  | { kind: 'and'; filters: readonly TQueryFilter[] }
  | { kind: 'or'; filters: readonly TQueryFilter[] }
  | { kind: 'not'; filter: TQueryFilter }
  | { kind: 'search'; query: string; columns: readonly string[] | null }
  | { kind: 'textSearch'; column: string; query: string; type: 'plain' | 'phrase' | 'websearch' }

/**
 * One sort key. The builder resolves both defaults before the plan leaves, so
 * `nullsFirst` (the wire key) is always named rather than inferred twice.
 */
export type TQueryOrder = { column: string; ascending: boolean; nullsFirst: boolean }

/**
 * One local read: predicates, sort keys, row cap, columns to keep, and how many
 * rows the caller expects. The kernel evaluates it in that order.
 */
export type TQueryPlan = {
  filters: readonly TQueryFilter[]
  orders: readonly TQueryOrder[]
  limit?: number
  projection?: string[]
  cardinality: 'many' | 'single' | 'maybeSingle'

  /**
   * Keep the rows a table's soft-delete column marks as deleted. Absent ⇒ the
   * kernel excludes them before the plan is evaluated, so a `limit` counts the
   * rows the caller can see.
   */
  includeDeleted?: boolean
}

/**
 * What `query` answers: an array for `many`, one row for `single`, a row or
 * null for `maybeSingle`.
 */
export type TQueryResult = TColumnValues[] | TColumnValues | null

/**
 * One filter-targeted write: the kernel resolves the targets over the same rows
 * a read reports and applies the same mutation to each.
 */
export type TApplyWhereRequest = {
  table: string
  op: TOp
  filters: readonly TQueryFilter[]
  columns: TColumnValues
  transforms?: Record<string, TTransform>
  precondition?: TColumnValues

  /**
   * Same key and same default as `TQueryPlan`: a soft-deleted row is no more a
   * write target than it is a read result.
   */
  includeDeleted?: boolean
}

// MARK: - Public engine surface

/**
 * What every engine hands back, whichever bridge reached it. `query` and
 * `applyWhere` are the whole local query surface: the plan and the target
 * filters are evaluated by the kernel, never here.
 */
export interface ISyncEngine {
  sync(): Promise<void>
  pullOnce(): Promise<void>
  pushOnce(): Promise<void>
  apply(mutation: TLocalMutation): Promise<void>
  query(table: string, plan: TQueryPlan): Promise<TQueryResult>

  /** The primary keys the write was applied to, in store order. */
  applyWhere(request: TApplyWhereRequest): Promise<string[]>

  getCheckpoint(): Promise<TCheckpointState>
  getOutboxDepth(): Promise<number>
  subscribe(onEvent: (event: TEngineEvent) => void): () => void
  reset(): Promise<void>

  /**
   * Resume from a persisted checkpoint: seed the durable cursor so the next
   * pull request carries it. Some transcripts open on that precondition, where
   * the cursor lives only in the prose of `context.notes` and never in a
   * machine-readable field. A no-op at '0'.
   */
  seedCheckpoint(cursor: TCursor): Promise<void>

  /** Release engine-held subscriptions (wakeup channel + debounce timer). */
  dispose?(): void
}

/**
 * Injected non-determinism: clock + id minting (no Date.now / Math.random in
 * loops or apply, mirroring the executor determinism rule).
 * connectivity gates sync() (queue while offline) + auto-flushes on reconnect;
 * defaults to alwaysOnline so the conformance harness is unaffected.
 */
export type TEngineDeps = {
  now?: () => string
  uuid?: () => string
  connectivity?: IConnectivity

  /**
   * Opt-in server-change hint (e.g. Supabase Realtime): a debounced "pull now",
   * never a data path. Absent ⇒ poll + reconnect only (corpus byte-identical).
   */
  wakeup?: IWakeup

  /**
   * Opt-in app-became-visible hint. The adapter refreshes the session JWT
   * before forwarding, so a long-lived tab does not poll with a dead Bearer.
   * Absent ⇒ poll + reconnect only (corpus byte-identical).
   */
  foreground?: IForeground

  /**
   * Opt-in session gate the app client awaits before the network call of
   * `sync()`, `pullOnce()` and `pushOnce()`, so a host whose transport lives
   * inside the engine (UniFFI) can refresh the session and hand the engine its
   * token first. A rejection fails that call before it reaches the network and
   * counts as a failed attempt in sync health. Absent ⇒ no gate (corpus
   * byte-identical).
   */
  beforeNetwork?: () => Promise<void>

  /**
   * Opt-in jittered poll fallback (@../../../../docs/resources/architecture.md):
   * a missed wakeup only delays the next poll. When > 0 the engine
   * self-reschedules a sync() on a full-jittered interval in
   * [pollIntervalMs/2, pollIntervalMs]. Absent or <= 0 ⇒ NO timer is armed and
   * no Math.random is touched, so the conformance harness (which injects only
   * now + uuid) stays byte-identical.
   */
  pollIntervalMs?: number

  /**
   * Opt-in switch for the automatic sync loop, consulted on every automatic
   * wake (poll tick, connectivity, wakeup, foreground, local write). False
   * skips that wake: no attempt starts and sync health does not change. An
   * explicit `sync()` ignores it. Absent ⇒ always on (corpus byte-identical).
   */
  shouldSyncAutomatically?: () => boolean

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout. The handle is opaque, because the engine only
   * round-trips it to clearTimer, so it is typed unknown to admit both the
   * platform Timeout and a fake's numeric handle. Only used when
   * pollIntervalMs > 0.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void

  /**
   * Attachment ports (the upload queue). Both must be present when any table
   * declares attachment(): createKizunaSync enforces this (ATTACHMENT_PORTS_MISSING).
   * Absent ⇒ the engine never touches the queue (the conformance harness injects
   * neither, so the corpus stays byte-identical).
   */
  fileStore?: IFileStore

  transfer?: ITransfer

  /**
   * Resolved diagnostic logger (createKizunaSync builds it from options.logging).
   * Absent ⇒ the engine logs nothing (the conformance harness injects none).
   */
  logger?: ILogger

  /**
   * When a UniFFI engine is linked (React Native), open `kizunasync-remote-http`
   * with these credentials instead of injecting `IProtocolRemote` callbacks.
   * Node/Bun keep the NAPI callback remote. Same PostgREST RPCs, different
   * transport (reqwest vs fetch).
   */
  nativeHttpRemote?: {
    url: string
    publishableKey?: string

    /** Alias of `publishableKey`, read when that one is absent. */
    anonKey?: string

    accessToken?: string
  }

  /**
   * Pre-linked UniFFI handle (tests, or a host that already constructed one).
   * `selectEngine` prefers this over probing `@kizunasync/rn-uniffi`. It is the whole
   * contract: an engine that cannot be subscribed to or shut down is not one the
   * app client can drive.
   */
  uniffiHandle?: TUniffiHandle
}
