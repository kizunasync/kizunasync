// MARK: - createKizunaSync

/**
 * Builds the supabase-js-shaped surface (kizunasync.from / on / setBucket / sync)
 * over the Rust core selected in select-engine.ts. It maps the
 * typed defineConfig output (TKizunaSyncConfig) to TEngineConfig and owns ZERO
 * domain-table knowledge: every table comes from config.
 *
 * Bucketed tables seed an empty bucket param (''). setBucket fills a byColumn
 * one at runtime; the engine fills a byOwner one with the store owner, the
 * subject of the first token it sees. buildPullBuckets throws if a bucket is
 * still unset at pull time; it does not send an empty bucket.
 */

import { selectEngine, type TEngineKind } from './select-engine'
import { createDeferredAttachments, createDeferredEngine, createDeferredInspector } from './deferred-engine'
import { createInspector, type IInspector } from './inspector'
import { createFromBuilder, type ILocalFromBuilder } from './builder'
import type { IAttachmentClient } from '../host/attachment-queue'
import type { ISyncHealth } from '../host/sync-health'
import type { IStoreLocator } from '../ports/store-locator'
import type { IProtocolRemote } from '../ports/protocol-remote'
import { alwaysOnline, type IConnectivity } from '../ports/connectivity'
import type { IForeground } from '../ports/foreground'
import { EBucketKind, type IResolvedTableConfig, type TAttachmentSpec, type TBucketSpec, type TKizunaSyncConfig } from '../config/config'
import { createLogger, type ILogger, type ILoggerOptions } from '../util/logger'
import { EConflictMode, EEngineErrorCode, ESyncMode, TEngineError, type TBucketParams, type TCheckpointState, type TEngineConfig, type TEngineDeps, type TEngineEvent, type TOverwriteRecord, type TRejectionRecord, type TTableConfig, type TUuid } from '../wire/types'

// MARK: - Public surface

export interface IKizunaSync {
  from(table: string): ILocalFromBuilder
  on(handler: (event: TEngineEvent) => void): () => void
  setBucket(params: TBucketParams): void
  sync(): Promise<void>
  pullOnce(): Promise<void>
  pushOnce(): Promise<void>
  getCheckpoint(): Promise<TCheckpointState>
  getOutboxDepth(): Promise<number>

  /**
   * What the automatic sync loop is doing right now: phase, failure streak,
   * next armed attempt, last success, last error. Synchronous: it reads the
   * loop's own state, not the database.
   */
  getSyncHealth(): ISyncHealth

  /**
   * Observe every sync-loop transition. Returns the unsubscribe function. After
   * a failed open the listener hears the failure snapshot once.
   */
  onSyncHealth(listener: (health: ISyncHealth) => void): () => void

  /**
   * Durable journal of every write the server refused (rejected, superseded,
   * batch-aborted, dead-lettered), newest first. The `on` events are
   * fire-and-forget; this survives reloads until dismissed.
   */
  rejections(options?: { includeDismissed?: boolean }): Promise<TRejectionRecord[]>

  /**
   * Acknowledge one journalled rejection: it stops appearing in rejections()
   * unless includeDismissed is set.
   */
  dismissRejection(mutationId: TUuid): Promise<void>

  /**
   * Durable journal of every column a peer's write replaced under column-LWW,
   * newest first. The COLUMN_OVERWRITTEN events are fire-and-forget; this
   * survives reloads until dismissed.
   */
  overwrites(options?: { includeDismissed?: boolean }): Promise<TOverwriteRecord[]>

  /**
   * Acknowledge one journalled overwrite by its `id`: it stops appearing in
   * overwrites() unless includeDismissed is set.
   */
  dismissOverwrite(id: number): Promise<void>

  reset(): Promise<void>

  /**
   * Resume from / rewind to a persisted durable cursor (resume-on-launch + the
   * edge-case lab's checkpoint-expiry approximation).
   */
  seedCheckpoint(cursor: string): Promise<void>

  /**
   * Release engine subscriptions (the optional wakeup channel). Before the
   * first use it opens nothing, every later engine call fails with
   * ENGINE_UNAVAILABLE saying the client was disposed, and sync health reads
   * idle.
   */
  dispose(): void

  /**
   * Which core is executing this client, diagnostics rather than a switch. See
   * select-engine.ts for how it is chosen; there is nothing to override.
   * Reading it opens the engine.
   */
  readonly engine: TEngineKind

  /**
   * Cache devtools handle, or null when off (production + no `inspector: true`).
   * Its methods open the engine; reading the property does not.
   */
  readonly inspector?: IInspector | null

  /**
   * Attachment surface (fromFile / useAttachment). Its methods open the
   * engine; reading the property does not. Without both the fileStore and the
   * transfer ports every method fails with ATTACHMENT_PORTS_MISSING and
   * `watch` hears nothing.
   */
  readonly attachments: IAttachmentClient

  /**
   * The network signal the automatic loop follows: the `connectivity` option,
   * else the driver's `platformPorts.connectivity`, else `alwaysOnline`.
   * Reading it opens nothing.
   */
  readonly connectivity: IConnectivity

  /**
   * Update the UniFFI/HTTP remote user JWT after sign-in or token refresh.
   * Before the first use it opens nothing: the client keeps the latest token
   * and hands it to the engine ahead of every other call when it opens.
   */
  setRemoteAccessToken(token: string | null): Promise<void>
}

export interface IKizunaSyncOptions extends TEngineDeps {
  /**
   * Overridden by `defineConfig`'s own `schemaVersion` when the config sets
   * one, the same precedence `pollIntervalMs` follows.
   */
  schemaVersion?: number

  /** Enable the Cache inspector. Default: on when `NODE_ENV` is `development` or `test`. */
  inspector?: boolean

  /**
   * Logging config: a level and/or a bring-your-own ILogger sink. Default:
   * silent. Set `{ level: 'debug' }` to trace sync + attachments.
   */
  logging?: ILoggerOptions

  /**
   * Identifies this client on the wire and in the server's `_clients` registry.
   * Must be a uuid, because that registry's column is one: a value of any other
   * shape is refused here with `CONFIG_INVALID` rather than at the first pull.
   * Defaults to a freshly minted uuid v4, so one install keeps one identity
   * across sign-ins while two installs never share one.
   */
  clientId?: string
}

const DEFAULT_SCHEMA_VERSION = 1

/**
 * RFC 4122 textual layout, any version and variant nibble, case-insensitive:
 * the shape `kizunasync._clients.client_id` accepts. Identical to the pattern
 * `packages/protocol/harness/ajv-validate.ts` registers for the wire key.
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * The poll fallback is the client's last-resort recovery path. The app-facing
 * client arms it by default. The conformance harness drives the engine
 * directly and arms nothing, so the corpus stays byte-identical.
 *
 * The two faster paths can fail silently and stay that way: a realtime
 * channel can die on an expired JWT or a dropped socket without reporting it,
 * and the connectivity signal never fires when the link stays up but the
 * route does not (a captive portal leaves navigator.onLine true). A client
 * that reacts only to those stops syncing for good: the app is open and
 * quiet. Set `pollIntervalMs: 0` in the config or the options to opt out.
 */
const DEFAULT_POLL_INTERVAL_MS = 15_000

// MARK: - Config mapping

/** One table's attachment columns, beside the bucket that can own their Storage objects. */
type TAttachmentColumns = {
  table: string
  attachments: Record<string, TAttachmentSpec>
  bucket: TBucketSpec | undefined
}

function toAttachmentSpecs(columns: TAttachmentColumns): NonNullable<TTableConfig['attachments']> {
  const { table, bucket } = columns
  const attachments: NonNullable<TTableConfig['attachments']> = {}

  for (const [column, spec] of Object.entries(columns.attachments)) {
    const ownerColumn =
      spec.ownerColumn ??
      (bucket?.kind === EBucketKind.byOwner ? bucket.column : undefined)

    if (ownerColumn === undefined) {
      throw new TEngineError(
        EEngineErrorCode.CONFIG_INVALID,
        `attachment column "${column}" on table "${table}" needs ownerColumn, the row column that owns the Storage object (the key derives from it)`,
      )
    }
    attachments[column] = { storageBucket: spec.storageBucket, ownerColumn }
  }
  return attachments
}

function toTableConfig(table: string, tableConfig: IResolvedTableConfig): TTableConfig {
  const entry: TTableConfig = {
    bucketColumn: tableConfig.bucket?.column ?? '',
    syncMode: tableConfig.sync === ESyncMode.pullOnly ? ESyncMode.pullOnly : ESyncMode.readWrite,
  }

  if (tableConfig.bucket !== undefined) {
    entry.bucketParams = { [tableConfig.bucket.column]: '' }
  } else {
    // No bucket ⇒ unpartitioned request; server RLS still defines visibility.
    entry.bucketParams = {}
  }
  if (tableConfig.bucket?.kind === EBucketKind.byOwner) {
    entry.bucketOwner = true
  }
  // 'arrival' is the engine default (absent conflictMode); only carry 'hlc'.
  if (tableConfig.conflict === EConflictMode.hlc) {
    entry.conflictMode = tableConfig.conflict
  }
  if (tableConfig.softDelete !== undefined) {
    entry.softDelete = tableConfig.softDelete
  }
  if (tableConfig.attachments !== undefined) {
    entry.attachments = toAttachmentSpecs({ table, attachments: tableConfig.attachments, bucket: tableConfig.bucket })
  }
  return entry
}

const toEngineConfig = (config: TKizunaSyncConfig, schemaVersion: number): TEngineConfig => {
  const tables: Record<string, TTableConfig> = {}

  for (const [table, tableConfig] of Object.entries(config.tables)) {
    tables[table] = toTableConfig(table, tableConfig)
  }
  const engineConfig: TEngineConfig = {
    schemaVersion,
    tables,
    defaultLimit: config.pullLimit,
  }

  // Absent ⇒ the kernel's own budget; never a number this config did not choose.
  if (config.attachmentAttempts !== undefined) {
    engineConfig.attachmentAttempts = config.attachmentAttempts
  }
  return engineConfig
}

// MARK: - Factory

/**
 * Main factory function for creating a KizunaSync instance. Construction checks
 * the config and does nothing else; the engine opens, and its automatic loop
 * starts, on the first call that needs it (see deferred-engine.ts).
 * @param db - The database implementation.
 * @param remote - The remote protocol implementation.
 * @param config - The KizunaSync configuration.
 * @param options - The KizunaSync options.
 * @returns A new KizunaSync instance.
 */
export const createKizunaSync = (db: IStoreLocator, remote: IProtocolRemote, config: TKizunaSyncConfig, options: IKizunaSyncOptions = {}): IKizunaSync => {
  const { engineConfig, uuid, now, clientId, pollIntervalMs } = resolveSetup(config, options)

  assertAttachmentPorts(engineConfig, options)
  const logger = createLogger(options.logging)
  const ports = resolvePlatformPorts(db, options)
  const isInspectorEnabled = isInspectorOn(options)
  // Which engine backs this client is decided ONCE, on the first call that needs it (see select-engine.ts): the Rust core through the driver's transport, a UniFFI handle or the NAPI addon, and `ENGINE_UNAVAILABLE` when this runtime can reach none of them. Everything below (the builder, the inspector, the rejection journal) is written against the port rather than against an engine.
  const deferred = createDeferredEngine({
    openEngine: (accessToken) => {
      const { engine, kind } = selectEngine({
        db,
        remote,
        config: engineConfig,
        clientId,
        logger,
        now,
        uuid,
        accessToken,
        deps: toEngineDeps({ config, options, uuid, logger, pollIntervalMs, ports }),
      })

      return { engine, kind, inspector: isInspectorEnabled ? createInspector(engine, now) : null }
    },
    now: () => Date.parse(now()),
    logger,
  })
  const { engine } = deferred

  return {
    from: (table) => {
      // A table absent from config has no bucket, no sync rules: reads and eq-targeted writes on it would silently no-op. Fail loud instead (@../../../../CONVENTIONS.md).
      if (config.tables[table] === undefined) {
        throw new TEngineError(
          EEngineErrorCode.UNKNOWN_TABLE,
          `from("${table}"): table is not in the kizunasync config (configured: ${Object.keys(config.tables).join(', ') || 'none'})`,
          { table },
        )
      }
      return createFromBuilder(engine, table, uuid)
    },
    on: (handler) => engine.subscribe(handler),
    setBucket: (params) => { engine.setBucket(params) },
    sync: () => engine.sync(),
    pullOnce: () => engine.pullOnce(),
    pushOnce: () => engine.pushOnce(),
    getCheckpoint: () => engine.getCheckpoint(),
    getOutboxDepth: () => engine.getOutboxDepth(),
    getSyncHealth: () => engine.getSyncHealth(),
    onSyncHealth: (listener) => engine.onSyncHealth(listener),
    rejections: (listOptions) => engine.rejections(listOptions),
    dismissRejection: (mutationId) => engine.dismissRejection(mutationId),
    overwrites: (listOptions) => engine.overwrites(listOptions),
    dismissOverwrite: (id) => engine.dismissOverwrite(id),
    reset: () => engine.reset(),
    seedCheckpoint: (cursor) => engine.seedCheckpoint(cursor),
    dispose: () => {
      deferred.dispose()
    },
    get engine() {
      return deferred.open().kind
    },
    // Both are decided from the options alone, by the same rules the open builds the engine's by, so reading the property never opens the engine.
    inspector: isInspectorEnabled ? createDeferredInspector({ deferred, of: (opened) => opened.inspector! }) : null,
    attachments: hasAttachmentPorts(options) ? createDeferredAttachments({ deferred, of: (opened) => opened.engine.attachments! }) : createPortlessAttachments(),
    connectivity: ports.connectivity,
    setRemoteAccessToken: (token) => engine.setRemoteAccessToken?.(token) ?? Promise.resolve(),
  }
}

// MARK: - Construction

/** The engine config and identity a client is built on, checked before any engine is chosen. */
type TClientSetup = {
  engineConfig: TEngineConfig
  uuid: () => string
  now: () => string
  clientId: string
  pollIntervalMs: number
}

function resolveSetup(config: TKizunaSyncConfig, options: IKizunaSyncOptions): TClientSetup {
  const schemaVersion = config.schemaVersion ?? options.schemaVersion ?? DEFAULT_SCHEMA_VERSION
  const pollIntervalMs = config.pollIntervalMs ?? options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  assertClientConfig({ config, schemaVersion, pollIntervalMs })
  const engineConfig = toEngineConfig(config, schemaVersion)
  const uuid = options.uuid ?? defaultUuid
  const now = options.now ?? (() => new Date().toISOString())
  // Minted with the built-in uuid rather than the injected one: `options.uuid` is the mutation-id source a test freezes to a counter, and a counter is not an identity the server's uuid column can hold.
  const clientId = options.clientId ?? defaultUuid()

  if (!UUID_PATTERN.test(clientId)) {
    throw new TEngineError(
      EEngineErrorCode.CONFIG_INVALID,
      `clientId "${clientId}" is not a uuid (the server registry keys clients by one)`,
    )
  }
  return { engineConfig, uuid, now, clientId, pollIntervalMs }
}

/**
 * The values the config mapping would otherwise pass on unread: `toTableConfig`
 * compares `sync` and `conflict` with one value each, so a misspelled
 * `pull-only` would push a table the server owns and a misspelled `hlc` would
 * drop the origin order, and the numbers reach the kernel and the poll timer
 * as they are.
 */
function assertClientConfig(input: { config: TKizunaSyncConfig; schemaVersion: number; pollIntervalMs: number }): void {
  const { config, schemaVersion, pollIntervalMs } = input

  for (const [table, tableConfig] of Object.entries(config.tables)) {
    assertTableModes(table, tableConfig)
  }
  if (!Number.isSafeInteger(config.pullLimit) || config.pullLimit < 1) {
    throw configInvalid(`pullLimit must be a positive integer, got ${quoteValue(config.pullLimit)}`)
  }
  if (!Number.isSafeInteger(schemaVersion)) {
    throw configInvalid(`schemaVersion must be an integer, got ${quoteValue(schemaVersion)}`)
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw configInvalid(`pollIntervalMs must be 0 or a positive number of milliseconds, got ${quoteValue(pollIntervalMs)}`)
  }
}

const SYNC_MODES: ReadonlySet<string> = new Set(Object.values(ESyncMode))
const CONFLICT_MODES: ReadonlySet<string> = new Set(Object.values(EConflictMode))

function assertTableModes(table: string, tableConfig: IResolvedTableConfig): void {
  if (!SYNC_MODES.has(tableConfig.sync)) {
    throw configInvalid(`tables.${table}.sync must be ${listValues(SYNC_MODES)}, got ${quoteValue(tableConfig.sync)}`)
  }
  if (!CONFLICT_MODES.has(tableConfig.conflict)) {
    throw configInvalid(
      `tables.${table}.conflict must be ${listValues(CONFLICT_MODES)}, got ${quoteValue(tableConfig.conflict)}`,
    )
  }
}

function configInvalid(message: string): TEngineError {
  return new TEngineError(EEngineErrorCode.CONFIG_INVALID, message)
}

/** A refused value as the message quotes it: a string in quotes, anything else as JavaScript prints it. */
function quoteValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value)
}

function listValues(values: ReadonlySet<string>): string {
  return [...values].map(quoteValue).join(' or ')
}

/** Both byte ports are present, the rule the engine builds its attachment queue by. */
function hasAttachmentPorts(options: IKizunaSyncOptions): boolean {
  return options.fileStore !== undefined && options.transfer !== undefined
}

/** A configured attachment column needs both ports. Missing either throws; image bytes are not silently dropped. */
function assertAttachmentPorts(engineConfig: TEngineConfig, options: IKizunaSyncOptions): void {
  const usesAttachments = Object.values(engineConfig.tables).some(
    (table) => table.attachments !== undefined,
  )

  if (usesAttachments && !hasAttachmentPorts(options)) {
    throw new TEngineError(
      EEngineErrorCode.ATTACHMENT_PORTS_MISSING,
      'a table declares attachment() but createKizunaSync was called without both fileStore and transfer ports',
    )
  }
}

/**
 * The attachment surface of a client built without both byte ports. It opens
 * no engine: with no queue behind it, every call fails the same way whatever
 * the engine would say, and `watch` stays silent like a subscription after a
 * failed open.
 */
function createPortlessAttachments(): IAttachmentClient {
  const refuse = async (): Promise<never> => {
    throw new TEngineError(
      EEngineErrorCode.ATTACHMENT_PORTS_MISSING,
      'createKizunaSync was called without both fileStore and transfer ports, so this app client has no attachment queue',
    )
  }

  return {
    fromFile: refuse,
    resolveDownload: refuse,
    vacuum: refuse,
    getStatus: refuse,
    watch: () => () => undefined,
    retry: refuse,
    cancel: refuse,
    remove: refuse,
  }
}

/** The platform ports the automatic loop follows, resolved once at construction. */
type TPlatformPorts = {
  connectivity: IConnectivity
  foreground: IForeground | undefined
}

/**
 * An explicit option wins over the driver's platform port, which wins over the
 * built-in default: always online, and no foreground signal.
 */
function resolvePlatformPorts(db: IStoreLocator, options: IKizunaSyncOptions): TPlatformPorts {
  return {
    connectivity: options.connectivity ?? db.platformPorts?.connectivity ?? alwaysOnline,
    foreground: options.foreground ?? db.platformPorts?.foreground,
  }
}

type TEngineDepsSources = {
  config: TKizunaSyncConfig
  options: IKizunaSyncOptions
  uuid: () => string
  logger: ILogger
  pollIntervalMs: number
  ports: TPlatformPorts
}

/**
 * Host dependencies used by the engine. `pollIntervalMs` arrives resolved (the
 * config value wins over the option). The wakeup port is provided to the
 * engine only if realtime wakeups are enabled in the config.
 */
function toEngineDeps(sources: TEngineDepsSources): TEngineDeps {
  const { config, options, uuid, logger, pollIntervalMs, ports } = sources

  return {
    now: options.now,
    uuid,
    connectivity: ports.connectivity,
    wakeup: config.realtimeWakeups ? options.wakeup : undefined,
    foreground: ports.foreground,
    beforeNetwork: options.beforeNetwork,
    pollIntervalMs,
    shouldSyncAutomatically: options.shouldSyncAutomatically,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    fileStore: options.fileStore,
    transfer: options.transfer,
    logger,
    nativeHttpRemote: options.nativeHttpRemote,
    uniffiHandle: options.uniffiHandle,
  }
}

/**
 * The Node global, declared here because a consumer compiling this source may
 * carry no Node types. A runtime without one throws on the read below.
 */
declare const process: { env: { NODE_ENV?: string } }

/** `inspector` decides when it is set; otherwise the inspector is on only in a development or test build. */
function isInspectorOn(options: IKizunaSyncOptions): boolean {
  const nodeEnv = readNodeEnv()

  return options.inspector === true || (options.inspector !== false && (nodeEnv === 'development' || nodeEnv === 'test'))
}

/**
 * `process.env.NODE_ENV` as the bare member expression Vite, webpack and Metro
 * replace at build time. An unbundled browser has no `process`, so the read
 * throws there and answers `undefined`.
 */
function readNodeEnv(): string | undefined {
  try {
    return process.env.NODE_ENV
  } catch {
    return undefined
  }
}

// MARK: - Default id minting

const defaultUuid = (): string => {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined

  if (cryptoApi?.randomUUID !== undefined) {
    return cryptoApi.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0

    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}
