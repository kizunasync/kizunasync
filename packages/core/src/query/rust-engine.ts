// MARK: - Rust engine adapter

/**
 * Presents the Rust core over NAPI as `ISyncEngine`, the same port the
 * driver-carried wasm bridge and the UniFFI bridge also implement.
 * `createKizunaSync` builds one app client over any of them: the query builder,
 * the scheduler, the inspector, and the rejection journal are shared code,
 * not a bridge-specific reimplementation.
 *
 * Three things cross the boundary here:
 *
 * - Calls: `(method, paramsJson) → envelope`. Failures come back as data and
 *   are re-thrown as the same typed `TEngineError`s every bridge throws. An
 *   app's `catch` reads identically regardless of which bridge is wired in.
 * - Ports: the injected `IProtocolRemote` is handed to Rust as two callbacks.
 *   Transport, auth, and the retryable/permanent classification stay in
 *   TypeScript; Rust only decides what to do with the verdict. The attachment
 *   byte ports (`IFileStore` / `ITransfer`) are not handed over at all: the
 *   shared TypeScript queue keeps driving them and only its durable rows
 *   cross the bridge. The Rust store stays the single writer of the queue
 *   table.
 * - Events: Rust's tagged event JSON is mapped onto `TEngineEvent` and fanned
 *   out to the app client's subscribers.
 *
 * What stays in TypeScript on purpose: the clock and id minting (injected: a
 * test's frozen clock reaches the Rust store through every call). The
 * origin-HLC rule and the soft-delete refusal are not among them:
 * `conflict_mode` and `soft_delete_column` cross in the config, so Rust mints
 * the stamp and raises `SOFT_DELETE_VIOLATION` itself.
 */

import type { INapiAddon, INapiEngine } from './napi-loader'
import type { IEngineLeadership, TEngineTransportFactory } from '../ports/engine-transport'
import { parseCallEnvelope } from './engine-envelope'
import { bridgeRemote, isPullRequest, isPushRequest } from './remote-bridge'
import { createNapiAttachmentStore, type TEngineCall } from './napi-attachment-store'
import { createAttachmentQueue, type IAttachmentQueue } from '../host/attachment-queue'
import { createSyncScheduler } from '../host/sync-scheduler'
import { createSyncHealthTracker, errorCode, type ISyncHealth } from '../host/sync-health'
import { alwaysOnline, type IConnectivity } from '../ports/connectivity'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ILogger } from '../util/logger'
import { verdictToMessage } from '../util/verdict-message'
import type { IInspectorSnapshot } from './inspector'
import type { IAppClientEngine } from './select-engine'
import { EConflictMode, EEngineErrorCode, EEngineEventType, ERejectionKind, ESoftBlockReason, TEngineError, type TConflictMode, type TBucketParams, type TCheckpointState, type TColumnValues, type TEngineConfig, type TEngineDeps, type TEngineEvent, type TEngineEventType, type TLocalMutation, type TOutboxEntry, type TOverwriteRecord, type TQueryResult, type TRejectReason, type TRejectionKind, type TRejectionRecord, type TSoftBlockReason, type TTableConfig, type TTransform } from '../wire/types'

// MARK: - Rust payload shapes

type TRustRejection = {
  mutation_id: string
  table: string
  pk: string
  kind: string
  reason: string
  changed_columns: string[]
  server_row: TColumnValues | null
  at: number
  dismissed: boolean
}

type TRustOverwrite = {
  id: number
  table: string
  pk: string
  column: string
  loser_value: unknown
  winner_mutation_id: string
  conflict_mode: string
  winner_seq: string | null
  at: number
  dismissed: boolean
}

type TRustOutboxEntry = {
  seq: number
  mutation_id: string
  table: string
  pk: string
  op: TOutboxEntry['op']
  columns: TColumnValues
  transforms?: Record<string, TTransform> | null
  precondition: TColumnValues | null
  batch_id: string | null
  pre_image: TColumnValues | null
  hlc: string | null
  created_at: string
}

type TRustSnapshot = {
  queued: TRustOutboxEntry[]
  depth: number
  last_mutation_id: string | null
  cursor: string
  client_id: string
}

type TRustEvent = {
  type: string
  mutation_id?: string
  offender_mutation_id?: string
  reason?: string
  depth?: number
  table?: string
  pk?: string
  column?: string
  loser_value?: unknown
  winner_mutation_id?: string
  conflict_mode?: string
}

type TRustCheckpoint = {
  cursor: string
  soft_blocked: boolean
  soft_block_reason?: string | null
}

// MARK: - Event mapping

/** An engine event as it crosses the boundary: a JSON object that names its `type`. */
function isRustEvent(value: unknown): value is TRustEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/** The mapped event, or `null` for a type this build does not know. */
const toEngineEvent = (raw: TRustEvent): TEngineEvent | null => {
  switch (raw.type) {
    case EEngineEventType.LOCAL_CHANGED:
      return { type: EEngineEventType.LOCAL_CHANGED }
    case EEngineEventType.QUEUE_DEPTH:
      return { type: EEngineEventType.QUEUE_DEPTH, depth: raw.depth ?? 0 }
    case EEngineEventType.MUTATION_REJECTED:
      return toMutationRejected(raw)
    case EEngineEventType.BATCH_ABORTED:
      return toBatchAborted(raw)
    case EEngineEventType.DEAD_LETTER:
      return toDeadLetter(raw)
    case EEngineEventType.CHECKPOINT_EXPIRED:
      return { type: EEngineEventType.CHECKPOINT_EXPIRED }
    case EEngineEventType.RESET_REQUIRED:
      return toResetRequired(raw)
    case EEngineEventType.COLUMN_OVERWRITTEN:
      return toColumnOverwritten(raw)
    default:
      return null
  }
}

function toMutationRejected(raw: TRustEvent): TEngineEvent {
  return {
    type: EEngineEventType.MUTATION_REJECTED,
    mutationId: raw.mutation_id ?? '',
    reason: (raw.reason ?? '') as TRejectReason,
  }
}

function toBatchAborted(raw: TRustEvent): TEngineEvent {
  return {
    type: EEngineEventType.BATCH_ABORTED,
    offenderMutationId: raw.offender_mutation_id ?? '',
    reason: (raw.reason ?? '') as TRejectReason,
  }
}

function toResetRequired(raw: TRustEvent): TEngineEvent {
  const reason = toSoftBlockReason(raw.reason)

  return reason === undefined
    ? { type: EEngineEventType.RESET_REQUIRED }
    : { type: EEngineEventType.RESET_REQUIRED, reason }
}

function toDeadLetter(raw: TRustEvent): TEngineEvent {
  return { type: EEngineEventType.DEAD_LETTER, mutationId: raw.mutation_id ?? '', reason: raw.reason ?? '' }
}

function toColumnOverwritten(raw: TRustEvent): TEngineEvent {
  return {
    type: EEngineEventType.COLUMN_OVERWRITTEN,
    table: raw.table ?? '',
    pk: raw.pk ?? '',
    column: raw.column ?? '',
    loserValue: raw.loser_value,
    winnerMutationId: raw.winner_mutation_id ?? '',
    conflictMode: conflictModeOf(raw.conflict_mode),
  }
}

const conflictModeOf = (raw: string | undefined): TConflictMode => {
  if (raw === EConflictMode.hlc || raw === EConflictMode.arrival) {
    return raw
  }
  throw new TEngineError(
    EEngineErrorCode.ENGINE_UNAVAILABLE,
    `unknown conflict_mode: ${String(raw)}`,
  )
}

/** The reason a checkpoint names, or `undefined` when sync is not soft-blocked. */
function toSoftBlockReason(raw: string | null | undefined): TSoftBlockReason | undefined {
  if (raw === null || raw === undefined) {
    return undefined
  }
  if (raw === ESoftBlockReason.resetRequired || raw === ESoftBlockReason.identityChanged) {
    return raw
  }
  throw new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, `unknown soft_block_reason: ${raw}`)
}

const REJECTION_KINDS = new Set<string>(Object.values(ERejectionKind))

const toRejectionRecord = (raw: TRustRejection): TRejectionRecord => ({
  mutationId: raw.mutation_id,
  table: raw.table,
  pk: raw.pk,
  kind: (REJECTION_KINDS.has(raw.kind) ? raw.kind : ERejectionKind.REJECTED) as TRejectionKind,
  reason: raw.reason,
  changedColumns: raw.changed_columns,
  serverRow: raw.server_row,
  at: raw.at,
  dismissed: raw.dismissed,
})

const toOverwriteRecord = (raw: TRustOverwrite): TOverwriteRecord => ({
  id: raw.id,
  table: raw.table,
  pk: raw.pk,
  column: raw.column,
  loserValue: raw.loser_value,
  winnerMutationId: raw.winner_mutation_id,
  conflictMode: conflictModeOf(raw.conflict_mode),
  winnerSeq: raw.winner_seq,
  at: raw.at,
  dismissed: raw.dismissed,
})

const toOutboxEntry = (raw: TRustOutboxEntry): TOutboxEntry => ({
  seq: raw.seq,
  mutationId: raw.mutation_id,
  table: raw.table,
  pk: raw.pk,
  op: raw.op,
  columns: raw.columns,
  transforms: raw.transforms ?? null,
  precondition: raw.precondition,
  baseHint: null,
  batchId: raw.batch_id,
  preImage: raw.pre_image,
  hlc: raw.hlc,
  createdAt: raw.created_at,
  /** `list_outbox` reads the queued rows only (`in_flight = 0`). */
  inFlight: false,
})

// MARK: - Config mapping

export const toRustConfig = (
  config: TEngineConfig,
  clientId: string,
): Record<string, unknown> => {
  const tables: Record<string, unknown> = {}

  for (const [name, table] of Object.entries(config.tables)) {
    tables[name] = toRustTableConfig(table)
  }
  const rustConfig: Record<string, unknown> = {
    tables,
    schema_version: config.schemaVersion,
    client_id: clientId,
  }

  // The page size is the app's choice, so an unset one must reach Rust as UNSET: inventing a number here would put a `limit` this client never configured on the wire.
  if (config.defaultLimit !== undefined) {
    rustConfig.default_limit = config.defaultLimit
  }
  // Same rule for the transfer budget: absent means the kernel's own default, so spelling a number here would pin a budget the app never chose.
  if (config.attachmentAttempts !== undefined) {
    rustConfig.attachment_attempts = config.attachmentAttempts
  }
  return rustConfig
}

/** One table's entry in the engine config JSON. */
function toRustTableConfig(table: TTableConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    bucket_column: table.bucketColumn,
    bucket_params: table.bucketParams ?? {},
  }

  // The kernel fills an owner bucket from the store owner, so the flag has to reach it: an absent one leaves the bucket to setBucket.
  if (table.bucketOwner !== undefined) {
    entry.bucket_owner = table.bucketOwner
  }
  // The kernel refuses a local write to a pull-only table, so the mode has to reach it: the value set is closed there, and an absent one is read-write.
  if (table.syncMode !== undefined) {
    entry.sync_mode = table.syncMode
  }
  // Rust owns the origin-HLC rule, so the mode has to reach it: an hlc table gets the stamp minted there, and an absent mode is arrival.
  if (table.conflictMode !== undefined) {
    entry.conflict_mode = table.conflictMode
  }
  // The attachment columns must reach Rust because the PULL side needs them: a committed checkpoint orphans a superseded ref and schedules a download entry for a peer's, both inside the checkpoint transaction where only the Rust engine stands. The queue that moves the bytes reads them from the TypeScript config instead.
  if (table.attachments !== undefined) {
    const attachments: Record<string, { storage_bucket: string; owner_column: string }> = {}

    for (const [column, spec] of Object.entries(table.attachments)) {
      attachments[column] = {
        storage_bucket: spec.storageBucket,
        owner_column: spec.ownerColumn,
      }
    }
    entry.attachments = attachments
  }
  // Rust owns the soft-delete refusal, so the column has to reach it: an absent one leaves hard deletes legal, exactly as the config declares.
  if (table.softDelete !== undefined) {
    entry.soft_delete_column = table.softDelete
  }
  // Rust derives every pk from the key columns, so they have to reach it: an absent key is `id`.
  if (table.key !== undefined) {
    entry.key = table.key
  }
  return entry
}

// MARK: - Factory

export interface IRustEngineOptions {
  addon?: INapiAddon

  /** Pre-built native handle (UniFFI). When set, `addon` is not used. */
  native?: INapiEngine

  /**
   * A driver-provided engine (`@kizunasync/web`'s worker). Used when `native` is
   * absent; it receives the same five arguments the addon constructor takes.
   */
  engineFactory?: TEngineTransportFactory

  /** The database file the Rust engine opens. `null` ⇒ a private in-memory store. */
  databasePath: string | null

  remote: IProtocolRemote
  config: TEngineConfig
  clientId: string
  now: () => string
  uuid: () => string
  logger: ILogger

  /**
   * Scheduling, connectivity, wakeup and foreground live in the TypeScript
   * host layer beside the single Rust engine, which has no loop of its own:
   * it only executes one pull/push.
   */
  deps: TEngineDeps

  /**
   * The session token the host handed before the engine opened, sent ahead of
   * every other call. `null` clears it; absent ⇒ none was handed.
   */
  accessToken?: string | null
}

/** The config and the three callbacks every backend opens an engine with. */
interface INativePorts {
  configJson: string
  pull: (requestJson: string) => Promise<string>
  push: (requestJson: string) => Promise<string>
  onEvent: (eventJson: string) => void
}

/**
 * Open an engine on whichever backend the caller supplied. A driver transport
 * wins over the addon: it is the only reachable engine wherever it is offered.
 */
function openNative(options: IRustEngineOptions, ports: INativePorts): INapiEngine {
  const { configJson, pull, push, onEvent } = ports

  if (options.engineFactory !== undefined) {
    return options.engineFactory(configJson, options.databasePath, pull, push, onEvent)
  }
  if (options.addon === undefined) {
    throw new Error(
      'createRustEngine needs one of `native`, `engineFactory` or `addon` to open a Rust engine',
    )
  }
  return new options.addon.KizunaSyncEngine(configJson, options.databasePath, pull, push, onEvent)
}

export const createRustEngine = (options: IRustEngineOptions): IAppClientEngine => {
  const { config, now, uuid } = options
  // Connectivity-gated: an offline attempt leaves the write queued; it does not burn a failure.
  const connectivity = options.deps.connectivity ?? alwaysOnline
  // The sync-health diagnostics surface (see host/sync-health.ts), built here so a UI reads a consistent shape. Ahead of the engine, because the event bus feeds it the two server signals a resolved pull still carries.
  const syncHealth = createSyncHealthTracker({
    now: () => Date.parse(now()),
    isOnline: () => connectivity.isOnline(),
  })
  const bus = createEventBus(syncHealth, options.logger)
  const native: INapiEngine = options.native ?? openNative(options, createNativePorts(options, bus.emit))
  const chain = createCallChain(native, now)
  const { call } = chain
  const session: ISessionState = { token: null }

  issueOpeningCalls({ options, call, session, syncHealth })
  const writes = createLocalWrites({ options, config, uuid, chain })
  const attachments = createEngineAttachments({ options, call, apply: writes.apply })
  const storageGate = createStorageGate(call, session)
  const network: TEngineSyncParts = {
    call,
    attachments,
    storageGate,
    connectivity,
    syncHealth,
    beforeNetwork: options.deps.beforeNetwork,
  }
  const sync = createEngineSync(network)
  const { disposers, wakeForQueuedWork } = startAutomaticSync({
    options,
    sync,
    syncHealth,
    connectivity,
    subscribers: bus.subscribers,
    leadership: native.leadership,
  })
  const reads = createLocalReads(call, config)
  const journal = createJournal(call)

  return {
    sync,
    pullOnce: createOneShot(network, 'pull_once'),
    pushOnce: createOneShot(network, 'push_once'),
    apply: writes.apply,
    query: reads.query,
    applyWhere: writes.applyWhere,
    getCheckpoint: reads.getCheckpoint,
    getOutboxDepth: reads.getOutboxDepth,
    subscribe: bus.subscribe,
    reset: async () => {
      // The engine emits LOCAL_CHANGED itself and returns the sandbox paths whose rows it wiped: the store has no file port, so the bytes are deleted here, through the queue that owns them.
      const orphanedPaths = (await call('reset')) as string[]

      syncHealth.softBlockChanged(null)

      if (attachments !== null && orphanedPaths.length > 0) {
        await attachments.clearLocal(orphanedPaths)
      }
    },
    seedCheckpoint: async (cursor) => {
      await call('seed_checkpoint', { cursor })
    },
    dispose: () => {
      while (disposers.length > 0) {
        disposers.pop()?.()
      }
      // `dispose` stays synchronous for the app that calls it from a teardown hook, so neither the calls still on a lane nor a backend releasing its engine thread and database file asynchronously is awaited here. The rejection is reported rather than swallowed: it says the engine died before it let the file go, and a caller reopening that path needs it in the log.
      chain.close((error: unknown) => {
        options.logger.error('close failed', error)
      })
    },
    setBucket: writes.setBucket,
    rejections: journal.rejections,
    dismissRejection: journal.dismissRejection,
    overwrites: journal.overwrites,
    dismissOverwrite: journal.dismissOverwrite,
    inspect: reads.inspect,
    getSyncHealth: () => syncHealth.snapshot(),
    onSyncHealth: (listener) => syncHealth.subscribe(logHealthListenerFailures(listener, options.logger)),
    attachments: toAppAttachments(attachments, { storageGate, wakeForQueuedWork }),
    setRemoteAccessToken: async (token) => {
      await setAccessToken(call, session, token)
    },
  }
}

// MARK: - The session the attachment queue runs under

/** The token the host last handed the engine, null once it cleared it. */
interface ISessionState {
  token: string | null
}

/** Hands the engine `token`, and records it for the storage gate once the engine took it. */
async function setAccessToken(call: TEngineCall, session: ISessionState, token: string | null): Promise<void> {
  await call('set_access_token', { token })
  session.token = token
}

/**
 * Whether the attachment queue may reach Storage now: the host set a session
 * token and the store is not soft-blocked, the rule the Rust queue follows. A
 * blocked store's queue may belong to another user than the session.
 */
type TStorageGate = () => Promise<boolean>

function createStorageGate(call: TEngineCall, session: ISessionState): TStorageGate {
  return async () => {
    if (session.token === null || session.token === '') {
      return false
    }
    const checkpoint = (await call('checkpoint')) as TRustCheckpoint

    return !checkpoint.soft_blocked
  }
}

/** What the app-facing queue needs from the engine around it. */
type TAppQueueContext = {
  storageGate: TStorageGate
  wakeForQueuedWork: () => void
}

/**
 * The queue the app reaches. `vacuum` runs only when the queue may reach
 * Storage, and `retry` wakes the automatic loop: the transfer it puts back in
 * the queue comes with no local write to wake it.
 */
function toAppAttachments(queue: IAttachmentQueue | null, context: TAppQueueContext): IAttachmentQueue | null {
  const { storageGate, wakeForQueuedWork } = context

  if (queue === null) {
    return null
  }
  return {
    ...queue,
    vacuum: async () => {
      if (await storageGate()) {
        await queue.vacuum()
      }
    },
    retry: async (ref) => {
      await queue.retry(ref)
      wakeForQueuedWork()
    },
  }
}

// MARK: - Event bus

type TSyncHealthTracker = ReturnType<typeof createSyncHealthTracker>

/**
 * The signals a sync reports without throwing. The pull resolves, so nothing
 * reaches `attemptSettled`, and a UI reading health alone would call a blocked
 * client healthy.
 */
const SIGNAL_EVENTS = new Set<TEngineEventType>([
  EEngineEventType.RESET_REQUIRED,
  EEngineEventType.CHECKPOINT_EXPIRED,
])

/** The app client's event subscribers and the one `emit` that fans an engine event out to them. */
interface IEventBus {
  subscribers: Set<(event: TEngineEvent) => void>
  emit: (event: TEngineEvent) => void
  subscribe: IAppClientEngine['subscribe']
}

function createEventBus(syncHealth: TSyncHealthTracker, logger: ILogger): IEventBus {
  const subscribers = new Set<(event: TEngineEvent) => void>()

  return {
    subscribers,
    emit: (event) => {
      recordSignal(syncHealth, event)

      for (const subscriber of subscribers) {
        try {
          subscriber(event)
        } catch (error) {
          // A listener's own fault must not break an already-committed write, nor keep the event from the listeners after it.
          logger.error('engine event subscriber failed', error)
        }
      }
    },
    subscribe: (onEvent) => {
      subscribers.add(onEvent)

      return () => {
        subscribers.delete(onEvent)
      }
    },
  }
}

/** Hands sync health a signal event, with the soft-block reason a `RESET_REQUIRED` names. */
function recordSignal(syncHealth: TSyncHealthTracker, event: TEngineEvent): void {
  if (!SIGNAL_EVENTS.has(event.type)) {
    return
  }
  const verdict = verdictToMessage(event)

  if (verdict !== null) {
    syncHealth.signalled({ code: event.type, message: verdict.message })
  }
  if (event.type === EEngineEventType.RESET_REQUIRED && event.reason !== undefined) {
    syncHealth.softBlockChanged(event.reason)
  }
}

/** What the calls an engine issues as it opens need. */
type TOpeningCalls = {
  options: IRustEngineOptions
  call: TEngineCall
  session: ISessionState
  syncHealth: TSyncHealthTracker
}

/** The calls an engine issues as it opens: the token the host already handed, then the soft block the store opens with. */
function issueOpeningCalls(parts: TOpeningCalls): void {
  const { options, call, session, syncHealth } = parts

  // First on the local lane, so no call reaches the engine under an older session than the one the host already handed over.
  if (options.accessToken !== undefined) {
    void setAccessToken(call, session, options.accessToken).catch((error: unknown) => {
      options.logger.error('access token hand-over failed', error)
    })
  }
  void seedSoftBlock(call, syncHealth).catch((error: unknown) => {
    options.logger.error('soft block read failed', error)
  })
}

/**
 * The block a store opens with was latched in an earlier session, whose
 * `RESET_REQUIRED` this client never heard, so sync health reads it once from
 * the checkpoint.
 */
async function seedSoftBlock(call: TEngineCall, syncHealth: TSyncHealthTracker): Promise<void> {
  const checkpoint = (await call('checkpoint')) as TRustCheckpoint
  const reason = toSoftBlockReason(checkpoint.soft_block_reason)

  if (checkpoint.soft_blocked && reason !== undefined) {
    syncHealth.softBlockChanged(reason)
  }
}

/** An app health listener whose throw is logged instead of swallowed by the tracker. */
function logHealthListenerFailures(
  listener: (health: ISyncHealth) => void,
  logger: ILogger,
): (health: ISyncHealth) => void {
  return (health) => {
    try {
      listener(health)
    } catch (error) {
      logger.error('sync health listener failed', error)
    }
  }
}

/** The config and the three callbacks the engine is opened with when no pre-built handle is supplied. */
function createNativePorts(options: IRustEngineOptions, emit: IEventBus['emit']): INativePorts {
  const { logger } = options

  return {
    configJson: JSON.stringify(toRustConfig(options.config, options.clientId)),
    pull: bridgeRemote((request) => options.remote.pull(request), isPullRequest),
    push: bridgeRemote((request) => options.remote.push(request), isPushRequest),
    onEvent: (eventJson: string) => {
      // The addon runs this callback from a threadsafe function, where a throw reaches `napi_fatal_exception` and ends the process, so every failure stops here.
      try {
        const event = readEngineEvent(eventJson, logger)

        if (event !== null) {
          emit(event)
        }
      } catch (error) {
        logger.error('engine event handler failed', error)
      }
    },
  }
}

/** The event `eventJson` carries, or `null` once an unreadable or unknown one is logged and dropped. */
function readEngineEvent(eventJson: string, logger: ILogger): TEngineEvent | null {
  let raw: unknown

  try {
    raw = JSON.parse(eventJson) as unknown
  } catch {
    raw = null
  }
  if (!isRustEvent(raw)) {
    logger.debug('dropped an unreadable engine event')

    return null
  }
  const event = toEngineEvent(raw)

  if (event === null) {
    logger.debug('dropped an unknown engine event', { type: raw.type })
  }
  return event
}

// MARK: - Engine calls

/** What a call waits for before it reaches the bridge. */
const ECallLane = {
  local: 'local',
  network: 'network',
  both: 'both',
} as const

type TCallLane = (typeof ECallLane)[keyof typeof ECallLane]

/**
 * The methods that reach the network, and the two that replace store state
 * under both lanes; every other method is a local call.
 */
const CALL_LANES = new Map<string, TCallLane>([
  ['sync', ECallLane.network],
  ['sync_push', ECallLane.network],
  ['sync_pull', ECallLane.network],
  ['pull_once', ECallLane.network],
  ['push_once', ECallLane.network],
  ['reset', ECallLane.both],
  ['seed_checkpoint', ECallLane.both],
])

/**
 * Issue order, kept on two lanes. A local call waits for the local calls
 * issued before it, so it answers while a pull or a push awaits the network. A
 * network call waits for the network call before it and for the local tail at
 * the moment it is issued, so it carries every write and bucket value the app
 * issued first. `reset` and `seed_checkpoint` wait for both lanes and become
 * the tail of both. The order has to be kept here: the N-API addon dispatches
 * each call from a tokio task napi-rs spawns, so arrival at the engine thread
 * follows these tails, not the JS caller's return.
 */
interface ICallChain {
  /**
   * Settles once every local call issued so far has settled. `setBucket` puts
   * its own call's outcome here, so the next call re-throws a failure it could
   * not throw itself; the tail never rejects otherwise.
   */
  local: Promise<void>

  /** Settles once every network call issued so far has settled; never rejects. */
  network: Promise<void>

  call: TEngineCall

  /** Closes the engine once both lanes drain, at once when no call is in flight. */
  close: (onFailure: (error: unknown) => void) => void
}

/** Settles when `pending` settles, whatever its outcome. */
function ignoreOutcome(pending: Promise<unknown>): Promise<void> {
  return pending.then(
    () => undefined,
    () => undefined,
  )
}

function createCallChain(native: INapiEngine, now: () => string): ICallChain {
  let inFlight = 0
  // Every call carries the injected clock so Rust stamps rows, the outbox and the rejection journal with the app's (or the test's) time, not its own.
  const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const stamp = now()
    const raw = await native.call(method, JSON.stringify({ ...params, now: stamp, now_ms: Date.parse(stamp) }))

    return parseCallEnvelope(raw)
  }
  const chain: ICallChain = {
    local: Promise.resolve(),
    network: Promise.resolve(),
    call: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      const lane = CALL_LANES.get(method) ?? ECallLane.local
      const { local, network } = chain
      const ready = lane === ECallLane.local ? local : Promise.all([network, local])
      const run = ready.then(async () => send(method, params))
      const done = ignoreOutcome(run)

      inFlight += 1
      void done.then(() => {
        inFlight -= 1
      })

      if (lane === ECallLane.local) {
        chain.local = done

        return run
      }
      // A local failure re-thrown here can settle this call before the network call ahead of it, so the lane waits for both.
      const drained = Promise.all([network, done]).then(() => undefined)

      chain.network = drained
      // This call consumed the local tail it waited on, so a setBucket failure is re-thrown once.
      chain.local = lane === ECallLane.both ? drained : ignoreOutcome(local)

      return run
    },
    close: (onFailure) => {
      const release = (): void => {
        void Promise.resolve(native.close()).catch(onFailure)
      }

      if (inFlight === 0) {
        release()

        return
      }
      void Promise.all([ignoreOutcome(chain.local), chain.network]).then(release).catch(onFailure)
    },
  }

  return chain
}

// MARK: - Local writes

type TLocalWritesContext = {
  options: IRustEngineOptions
  config: TEngineConfig
  uuid: () => string
  chain: ICallChain
}

function requireTable(config: TEngineConfig, table: string): void {
  if (config.tables[table] === undefined) {
    throw new TEngineError(
      EEngineErrorCode.UNKNOWN_TABLE,
      `table "${table}" is not in the engine config (fail loud)`,
      table,
    )
  }
}

function createLocalWrites(context: TLocalWritesContext): Pick<IAppClientEngine, 'apply' | 'applyWhere' | 'setBucket'> {
  const { options, config, uuid, chain } = context
  const { call } = chain

  return {
    apply: async (mutation: TLocalMutation): Promise<void> => {
      requireTable(config, mutation.table)
      await call('apply', {
        table: mutation.table,
        pk: mutation.pk,
        op: mutation.op,
        columns: mutation.columns,
        precondition: mutation.precondition ?? null,
        batch_id: mutation.batchId ?? null,
        hlc: mutation.hlc ?? null,
        transforms: mutation.transforms ?? null,
        mutation_id: uuid(),
      })
    },
    applyWhere: async (request): Promise<string[] | TColumnValues[]> =>
      (await call('apply_where', {
        table: request.table,
        op: request.op,
        filters: request.filters,
        columns: request.columns,
        transforms: request.transforms ?? null,
        precondition: request.precondition ?? null,
        includeDeleted: request.includeDeleted ?? false,
        maxAffected: request.maxAffected ?? null,
        returning: request.returning ?? false,
        cardinality: request.cardinality ?? null,
      })) as string[] | TColumnValues[],
    setBucket: (params: TBucketParams): void => {
      mirrorBucketParams(config, params)
      // The caller's keys ride along unfiltered, so a key no table declares as its bucket column reaches the kernel and is refused there with BUCKET_UNSET. Dropping it here instead would leave a misspelled bucket silently unset and the next pull reading somebody else's partition (@../../../../CONVENTIONS.md).
      const applied = call('set_bucket', { params }).then(() => undefined)

      // Fire-and-forget on purpose: `setBucket` is synchronous in the app client. It rides the local lane, so every later call is ordered after it, and its outcome becomes the local tail: the next call re-throws a failure, and the handler logs it and keeps an unobserved one from surfacing as an unhandled rejection.
      chain.local = applied
      void applied.catch((error: unknown) => {
        options.logger.error('setBucket failed', error)
      })
    },
  }
}

/**
 * The kernel's routing rule, applied to the config this client holds: a key
 * reaches every table bucketed on it and every table whose params already
 * carry it. A key no table is bucketed on refuses the whole call, so nothing
 * changes here and the kernel answers BUCKET_UNSET.
 */
function mirrorBucketParams(config: TEngineConfig, params: TBucketParams): void {
  const tables = Object.values(config.tables)
  const keys = Object.keys(params)

  if (!keys.every((key) => tables.some((table) => table.bucketColumn === key))) {
    return
  }
  for (const table of tables) {
    const routed = keys.filter((key) => table.bucketColumn === key || key in (table.bucketParams ?? {}))

    for (const key of routed) {
      table.bucketParams ??= {}
      table.bucketParams[key] = params[key]!
    }
  }
}

// MARK: - Local reads

function createLocalReads(
  call: TEngineCall,
  config: TEngineConfig,
): Pick<IAppClientEngine, 'query' | 'getCheckpoint' | 'getOutboxDepth' | 'inspect'> {
  return {
    query: async (table, plan): Promise<TQueryResult> =>
      (await call('query', { table, plan })) as TQueryResult,
    getCheckpoint: async (): Promise<TCheckpointState> => {
      const state = (await call('checkpoint')) as TRustCheckpoint
      const reason = toSoftBlockReason(state.soft_block_reason)

      return {
        cursor: state.cursor,
        schemaVersion: config.schemaVersion,
        softBlocked: state.soft_blocked,
        ...(reason === undefined ? {} : { softBlockReason: reason }),
      }
    },
    getOutboxDepth: async () => (await call('outbox_depth')) as number,
    inspect: async (): Promise<IInspectorSnapshot> => {
      const snapshot = (await call('inspect')) as TRustSnapshot

      return {
        queued: snapshot.queued.map(toOutboxEntry),
        depth: snapshot.depth,
        lastMutationId: snapshot.last_mutation_id,
        cursor: snapshot.cursor,
        clientId: snapshot.client_id,
      }
    },
  }
}

// MARK: - Journals

function createJournal(
  call: TEngineCall,
): Pick<IAppClientEngine, 'rejections' | 'dismissRejection' | 'overwrites' | 'dismissOverwrite'> {
  return {
    rejections: async (listOptions) => {
      const records = (await call('rejections', {
        include_dismissed: listOptions?.includeDismissed ?? false,
      })) as TRustRejection[]

      return records.map(toRejectionRecord)
    },
    dismissRejection: async (mutationId) => {
      await call('dismiss_rejection', { mutation_id: mutationId })
    },
    overwrites: async (listOptions) => {
      const records = (await call('overwrites', {
        include_dismissed: listOptions?.includeDismissed ?? false,
      })) as TRustOverwrite[]

      return records.map(toOverwriteRecord)
    },
    dismissOverwrite: async (id) => {
      await call('dismiss_overwrite', { id })
    },
  }
}

// MARK: - Attachments

/** What the attachment queue is built from: the engine's calls and its local write. */
type TEngineAttachmentsSource = {
  options: IRustEngineOptions
  call: TEngineCall
  apply: IAppClientEngine['apply']
}

/**
 * The attachment queue, live only when BOTH byte ports are injected, so a
 * config declaring `attachment()` is refused by `createKizunaSync` with
 * `ATTACHMENT_PORTS_MISSING` before an engine is chosen at all. The rows live
 * in the Rust store (see `napi-attachment-store.ts`); the bytes never cross the
 * FFI.
 */
function createEngineAttachments(source: TEngineAttachmentsSource): IAttachmentQueue | null {
  const { options, call, apply } = source
  const { fileStore, transfer } = options.deps

  return fileStore !== undefined && transfer !== undefined
    ? createAttachmentQueue({
        store: createNapiAttachmentStore(call),
        config: options.config,
        fileStore,
        transfer,
        apply,
        now: options.now,
        uuid: options.uuid,
        logger: options.logger.child('attachments'),
      })
    : null
}

// MARK: - Sync

type TEngineSyncParts = {
  call: TEngineCall
  attachments: IAttachmentQueue | null
  storageGate: TStorageGate
  connectivity: IConnectivity
  syncHealth: TSyncHealthTracker
  beforeNetwork: TEngineDeps['beforeNetwork']
}

function createEngineSync(parts: TEngineSyncParts): () => Promise<void> {
  const { call, attachments, storageGate, connectivity, syncHealth, beforeNetwork } = parts

  return async (): Promise<void> => {
    if (!connectivity.isOnline()) {
      return
    }
    // Started AFTER the guard: an offline no-op reached no wire, so recording it as an attempt would report a success that never happened.
    const attempt = syncHealth.attemptStarted()

    try {
      // The host's session gate runs inside the attempt, so a refused gate is the failure the attempt settles with.
      if (beforeNetwork !== undefined) {
        await beforeNetwork()
      }
      await (attachments === null ? call('sync') : syncAroundAttachments(call, { attachments, storageGate }))
    } catch (error) {
      syncHealth.attemptSettled(attempt, error)

      throw error
    }
    syncHealth.attemptSettled(attempt, null)
  }
}

/**
 * `pullOnce` and `pushOnce`: one network call behind the host's session gate.
 * They are no attempt of the sync loop, so only a refused gate reaches sync
 * health, as a failed attempt of its own.
 */
function createOneShot(parts: TEngineSyncParts, method: 'pull_once' | 'push_once'): () => Promise<void> {
  const { call, syncHealth, beforeNetwork } = parts

  return async (): Promise<void> => {
    if (beforeNetwork !== undefined) {
      try {
        await beforeNetwork()
      } catch (error) {
        syncHealth.attemptSettled(syncHealth.attemptStarted(), error)

        throw error
      }
    }
    await call(method)
  }
}

/**
 * The Rust `sync` split in two, with the attachment bytes moved between the
 * halves: uploads only start once the outbox is drained, because the ref
 * column must already be on the server or a peer would fetch an object no row
 * points at. Splitting `sync` in the adapter (the queue is not driven from
 * inside Rust) keeps the byte transfer on the side where the ports were
 * injected. It keeps the kernel's own rule: a failed push still pulls unless it
 * is a retryable transport failure, the push failure is what the call reports,
 * and the queue moves only after a clean push.
 */
async function syncAroundAttachments(call: TEngineCall, queue: TQueueUnderGate): Promise<void> {
  const pushed = await call('sync_push').then(
    () => null,
    (error: unknown) => ({ error }),
  )

  if (pushed === null) {
    await driveAfterCleanPush(call, queue)
    await call('sync_pull')

    return
  }
  if (isRetryableTransportFailure(pushed.error)) {
    throw pushed.error
  }
  // The push failure is the one reported; the pull only runs so a write the server refuses does not hold remote rows back.
  await call('sync_pull').catch(() => undefined)

  throw pushed.error
}

/** The queue a sync drives, and the gate that decides whether it may reach Storage. */
type TQueueUnderGate = {
  attachments: IAttachmentQueue
  storageGate: TStorageGate
}

/** Drives the queue once the push drained the outbox, and never without a session or on a soft-blocked store. */
async function driveAfterCleanPush(call: TEngineCall, queue: TQueueUnderGate): Promise<void> {
  const { attachments, storageGate } = queue

  if (((await call('outbox_depth')) as number) !== 0) {
    return
  }
  if (!(await storageGate())) {
    return
  }
  await attachments.drive()
  // The completed push is what makes a superseded ref safe to collect: the row column carrying the winner is on the server, so no peer can still resolve the loser. Orphans accumulate on every replaced or deleted attachment, and nothing else calls this, so without it a device's Storage grows for the life of the app.
  await attachments.vacuum()
}

/**
 * A failure the injected remote marked retryable (`transportError` rebuilds it
 * as a plain `Error` carrying the flag): the network or the session, which the
 * pull would hit the same way. A typed `TEngineError` is never one, whatever
 * its catalog default says.
 */
function isRetryableTransportFailure(error: unknown): boolean {
  return error instanceof Error && !(error instanceof TEngineError) && 'retryable' in error && error.retryable === true
}

type TAutomaticSyncParts = {
  options: IRustEngineOptions
  sync: () => Promise<void>
  syncHealth: TSyncHealthTracker
  connectivity: IConnectivity
  subscribers: IEventBus['subscribers']

  /** Absent on a transport that is always its engine's leader. */
  leadership: IEngineLeadership | undefined
}

/**
 * The host's say over the automatic loop: its own switch, and on an engine
 * shared with other hosts whether this one leads it. An explicit `sync()`
 * never asks.
 */
function isAutomaticSyncAllowed(deps: TEngineDeps, leadership: IEngineLeadership | undefined): boolean {
  return (deps.shouldSyncAutomatically?.() ?? true) && (leadership?.isLeader() ?? true)
}

/** The running loop: what `dispose` releases, and the wake a local write rings. */
type TAutomaticSync = {
  disposers: Array<() => void>
  wakeForQueuedWork: () => void
}

/**
 * The one funnel for every automatic sync (start, poll tick, realtime doorbell,
 * return to connectivity or to the foreground, local write, attachment retry,
 * promotion), so its liveness guarantees hold for every trigger that can start
 * a sync.
 */
function createLoopScheduler(parts: TAutomaticSyncParts, logger: ILogger): ReturnType<typeof createSyncScheduler> {
  const { options, sync, syncHealth, leadership } = parts

  return createSyncScheduler({
    sync,
    intervalMs: options.deps.pollIntervalMs ?? 0,
    setTimer: options.deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer:
      options.deps.clearTimer ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      }),
    logger,
    observer: syncHealth,
    now: () => Date.parse(options.now()),
    shouldRun: () => isAutomaticSyncAllowed(options.deps, leadership),
  })
}

/** Starts the scheduler, wires every trigger into it, and answers what `dispose` releases. */
function startAutomaticSync(parts: TAutomaticSyncParts): TAutomaticSync {
  const { options, syncHealth, connectivity, subscribers, leadership } = parts
  const logger = options.logger.child('sync')
  const scheduler = createLoopScheduler(parts, logger)
  const disposers: Array<() => void> = [scheduler.dispose]

  disposers.push(
    subscribeTrigger(logger, {
      port: 'connectivity',
      subscribe: () =>
        connectivity.subscribe((online) => {
          // Both directions: the phase is derived from the port, so going offline has to publish a snapshot as much as coming back does.
          syncHealth.connectivityChanged()

          if (online) {
            scheduler.wake('connectivity')
          }
        }),
    }),
  )
  const wakeup = options.deps.wakeup

  if (wakeup !== undefined) {
    disposers.push(
      subscribeTrigger(logger, {
        port: 'wakeup',
        subscribe: () =>
          wakeup.subscribe(() => {
            scheduler.wake('wakeup')
          }),
      }),
    )
  }
  const foreground = options.deps.foreground

  if (foreground !== undefined) {
    disposers.push(
      subscribeTrigger(logger, {
        port: 'foreground',
        subscribe: () =>
          foreground.subscribe(() => {
            scheduler.wake('foreground')
          }),
      }),
    )
  }
  const wakeForQueuedWork = (): void => {
    scheduler.wake('queue')
  }
  // QUEUE_DEPTH is local-apply only, so this never fires after a pull (which emits LOCAL_CHANGED), which is what keeps a doorbell receive from triggering a second empty cycle.
  const wakeOnLocalWrite = (event: TEngineEvent): void => {
    if (event.type === EEngineEventType.QUEUE_DEPTH && event.depth > 0) {
      wakeForQueuedWork()
    }
  }
  subscribers.add(wakeOnLocalWrite)
  disposers.push(() => {
    subscribers.delete(wakeOnLocalWrite)
  })

  if (leadership !== undefined) {
    disposers.push(
      subscribeTrigger(logger, {
        port: 'leadership',
        subscribe: () =>
          leadership.subscribe((isLeader) => {
            // A promoted host runs the only loop on its engine now, so it catches up at once rather than a poll interval later.
            if (isLeader) {
              scheduler.wake('promotion')
            }
          }),
      }),
    )
  }
  // The loop starts on the app's first use, so the first pull lands within the debounce window instead of one poll interval later.
  scheduler.wake('start')

  return { disposers, wakeForQueuedWork }
}

/** A port the automatic loop subscribes to when it starts, and the subscription it makes there. */
type TTrigger = {
  port: 'connectivity' | 'wakeup' | 'foreground' | 'leadership'
  subscribe: () => () => void
}

/**
 * Subscribes one trigger and answers its unsubscribe. A port that throws here
 * loses only its own trigger: the loop keeps the others and the poll, and the
 * open succeeds. The warning carries the port, the error code and the error
 * name but not the message, which can quote a session token.
 */
function subscribeTrigger(logger: ILogger, trigger: TTrigger): () => void {
  try {
    return trigger.subscribe()
  } catch (error) {
    logger.warn('port.subscribe_failed', {
      port: trigger.port,
      code: errorCode(error),
      name: error instanceof Error ? error.name : null,
    })

    return releaseNothing
  }
}

function releaseNothing(): void {}
