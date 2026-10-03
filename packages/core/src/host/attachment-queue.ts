// MARK: - Attachment upload/download queue

/**
 * The row column holds an attachment reference (the Storage object key). Bytes
 * live behind `IFileStore` and travel via `ITransfer`. Every byte touch and
 * the durable state (`IAttachmentStore`) go through a port, backed by the
 * Rust store across the NAPI or wasm bridge.
 *
 * `fromFile` imports a picked file into the content-addressed sandbox,
 * enqueues an upload, and writes the ref onto the row. `drive` runs after
 * `pushOnce` drains the outbox (the ref has already reached the server), then
 * uploads and confirms. `resolveDownload`
 * fetches and verifies a peer's bytes on first use. `vacuum` removes orphaned
 * objects from Storage and deletes the cached bytes of evicted ones. Per-ref
 * watch feeds `useAttachment`; a global engine event would re-render every
 * query per tick.
 */

import { EAttachmentState, EEngineErrorCode, TEngineError } from '../wire/types'
import type { TAttachmentState, TColumnValues, TEngineConfig, TEngineErrorCode, TLocalMutation } from '../wire/types'
import type { IFileStore } from '../ports/file-store'
import { ETransferError, type ITransfer, type IUploadHandle } from '../ports/transfer'
import { noopLogger, type ILogger } from '../util/logger'
import { extForMime } from '../util/mime'

// MARK: - Durable queue rows

/**
 * One row of `_kizunasync_attachments`, decoded. The Rust store is its only writer;
 * this queue reads it through `IAttachmentStore` and never touches the table.
 */
export type TAttachmentEntry = {
  ref: string
  uploadId: string
  table: string
  pk: string
  column: string
  bucket: string
  owner: string
  sha256: string | null
  contentType: string | null
  size: number | null
  localPath: string | null
  direction: 'upload' | 'download'
  state: TAttachmentState
  inFlight: boolean
  fingerprint: string | null
  progress: number
  attempts: number

  /**
   * The transfer budget is spent: no drive claims this row again until the app
   * calls `retry`. Written by the kernel, never by this queue.
   */
  permanent: boolean

  error: string | null

  /** The engine catalog code of the last recorded failure, null while the row records none. */
  errorCode: string | null

  createdAt: string
  updatedAt: string
}

/**
 * A new queue row. Optional fields are the ones a download learns only once the
 * bytes arrive.
 */
export type TAttachmentInsert = {
  ref: string
  uploadId: string
  table: string
  pk: string
  column: string
  bucket: string
  owner: string
  sha256?: string | null
  contentType?: string | null
  size?: number | null
  localPath?: string | null
  direction: 'upload' | 'download'
  state: TAttachmentState
  createdAt: string
}

/**
 * Mutable fields the queue patches as an entry advances. Any omitted field is
 * left untouched; updatedAt is always restamped.
 */
export type TAttachmentPatch = {
  state?: TAttachmentState
  progress?: number
  fingerprint?: string | null
  sha256?: string | null
  size?: number | null
  contentType?: string | null
  localPath?: string | null
  error?: string | null
  errorCode?: string | null
  attempts?: number
  inFlight?: boolean

  /** Stops the row for good: a client error no retry can change. */
  permanent?: boolean
}

// MARK: - Public surface

export type TFromFileArgs = {
  table: string
  column: string
  pk: string
  uri: string
  mediaType?: string
}

export type TFromFileResult = {
  ref: string
  sha256: string
  size: number
  mediaType: string | null
  localUri: string
}

export type TAttachmentStatus = {
  state: TAttachmentState
  progress: number
  localUri: string | null
  error: string | null

  /**
   * `state: 'failed'` with this set is the end of the line: the transfer budget
   * is spent and only `retry(ref)` puts the row back in the queue.
   */
  permanent: boolean

  /**
   * How many transfer attempts the row has consumed, so a UI can say how close
   * to the budget it is.
   */
  attempts: number

  /**
   * The engine catalog code of the last recorded failure (`TRANSFER`,
   * `STORE`, `ATTACHMENT_UNVERIFIED`, ...), null when the row records none.
   */
  errorCode?: string | null
}

/** The public attachment surface (kizunasync.attachments + useAttachment). */
export interface IAttachmentClient {
  /**
   * Import a picked file, enqueue its upload, and write the ref into the row
   * column as one local update. The row must exist. Returns the ref and an
   * immediate local preview URI.
   */
  fromFile(args: TFromFileArgs): Promise<TFromFileResult>

  /**
   * Lazily fetch + verify a ref's bytes on first use; returns a renderable URI
   * (or null while not yet available).
   */
  resolveDownload(ref: string): Promise<string | null>

  vacuum(): Promise<void>
  getStatus(ref: string): Promise<TAttachmentStatus | null>
  watch(ref: string, callback: (status: TAttachmentStatus) => void): () => void

  /**
   * Forgive the transfer budget on one reference: the row goes back to
   * `queued` with its attempts cleared, so the next drive takes it again. A
   * reference no row carries is a no-op.
   */
  retry(ref: string): Promise<void>

  /**
   * Stop the transfer now. An in-flight upload handle is aborted first, then
   * the row lands `failed` and retryable: cancelling says "not now", never
   * "never again".
   */
  cancel(ref: string): Promise<void>

  /**
   * Forget one reference outright: the queue row goes, and the sandbox bytes
   * it cached go with it unless another live row shares them. The Storage
   * object is not touched here; `vacuum()` is what removes those.
   */
  remove(ref: string): Promise<void>
}

export interface IAttachmentQueue extends IAttachmentClient {
  /**
   * Drain pending uploads. Called from sync() after the outbox is empty (the ref
   * is already on the server). Downloads are lazy: NOT driven here.
   */
  drive(): Promise<void>

  /** Delete sandbox bytes for the given paths: the reset wrapper's file wipe. */
  clearLocal(paths: string[]): Promise<void>
}

/**
 * The durable rows this queue reads and writes, the ONLY thing it needs from a
 * store. The shipped implementer is `createNapiAttachmentStore`
 * (packages/core/src/query/napi-attachment-store.ts), backed by the Rust store
 * over NAPI; a Map-backed fake in attachment-queue.test.ts satisfies the same
 * interface for unit tests. ONE queue moves the bytes regardless of which
 * implementer is wired in, and the Rust store stays the single writer of
 * `_kizunasync_attachments`. Two queues over one table would disagree about what is
 * in flight, the state a claim exists to prevent.
 */
export interface IAttachmentStore {
  getRow(table: string, pk: string): Promise<TColumnValues | null>
  hasTombstone(table: string, pk: string): Promise<boolean>
  enqueueAttachment(entry: TAttachmentInsert): Promise<void>
  getAttachment(ref: string): Promise<TAttachmentEntry | null>
  pendingAttachments(direction: 'upload' | 'download'): Promise<TAttachmentEntry[]>
  claimAttachment(ref: string, state: TAttachmentState, now: string): Promise<boolean>
  updateAttachment(ref: string, patch: TAttachmentPatch, now: string): Promise<void>
  markAttachmentOrphaned(ref: string, now: string): Promise<void>
  orphanedAttachments(): Promise<TAttachmentEntry[]>
  purgeAttachment(ref: string): Promise<void>

  /**
   * Back to `queued` with attempts cleared and `permanent` off, so the next
   * drive picks the transfer up again. `false` when no row carried the
   * reference.
   */
  retryAttachment(ref: string): Promise<boolean>

  /**
   * Release the claim and land `failed`, still retryable. `false` when no row
   * carried the reference.
   */
  cancelAttachment(ref: string): Promise<boolean>

  /**
   * Delete the row and answer the sandbox path it cached: the bytes the host
   * still has to delete (the store owns no file port). `null` when the row
   * carried none or did not exist.
   */
  removeAttachment(ref: string): Promise<string | null>

  /**
   * Crash recovery for an engine restarting over an existing DB. Required: a
   * store that cannot do it strands every transfer its process died on.
   */
  recoverInFlightAttachments(now: string): Promise<void>

  /**
   * Count of LIVE (non-orphaned) rows sharing localPath, excluding excludingRef.
   * Required: without it vacuum deletes content-addressed bytes a live row
   * still caches.
   */
  countLiveAttachmentsAtLocalPath(localPath: string, excludingRef?: string): Promise<number>
}

type TAttachmentQueueDeps = {
  store: IAttachmentStore
  config: TEngineConfig
  fileStore: IFileStore
  transfer: ITransfer

  /** The engine's local write, which `fromFile` puts the ref onto the row with. */
  apply: (mutation: TLocalMutation) => Promise<void>

  now: () => string
  uuid: () => string
  logger?: ILogger
}

// MARK: - Helpers

/**
 * A uuid in its hyphenated form: the only shape an import accepts for the owner
 * and primary key it builds `owner/pk/upload.ext` from, since any other text
 * could add path segments to the Storage key.
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A SHA-256 digest in the lowercase hex every host records: the only name a downloaded file takes. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const isSha256 = (value: string | null | undefined): value is string =>
  typeof value === 'string' && SHA256_PATTERN.test(value)

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined

/** The HTTP status an adapter attached to a failure the host answered (see ITransfer). */
const errorStatus = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined

/** The status that refuses the session rather than the object. */
const HTTP_UNAUTHORIZED = 401

/** The status that refuses this user's access to the object, which a later push can grant. */
const HTTP_FORBIDDEN = 403

/**
 * The client errors a retry can change, the way tus-js-client classifies them:
 * the session, a policy that can clear once the row is pushed, a conflict and
 * a lock. Every other 4xx stops the transfer for good.
 */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN, 409, 423])

const CATALOG_CODES: ReadonlySet<string> = new Set(Object.values(EEngineErrorCode))

function isCatalogCode(code: string | undefined): code is TEngineErrorCode {
  return code !== undefined && CATALOG_CODES.has(code)
}

/** The catalog code a failure records: the one it carries, else `TRANSFER`. */
function failureCode(error: unknown): TEngineErrorCode {
  const code = errorCode(error)

  return isCatalogCode(code) ? code : EEngineErrorCode.TRANSFER
}

/** Whether the host refused the transfer with a client error no retry can change. */
function endsForGood(error: unknown): boolean {
  const status = errorStatus(error)

  return status !== undefined && status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status)
}

/**
 * How many transfer attempts a reference gets when the config names no
 * `attachmentAttempts`: the Rust engine's own default, which the kernel
 * enforces at the claim.
 */
export const DEFAULT_ATTACHMENT_ATTEMPTS = 5

// MARK: - Factory

/**
 * What every phase below reads: the injected ports, the per-reference
 * bookkeeping, and the chain that orders the queue's store writes.
 */
type TQueueState = {
  store: IAttachmentStore
  config: TEngineConfig
  fileStore: IFileStore
  transfer: ITransfer
  apply: (mutation: TLocalMutation) => Promise<void>
  now: () => string
  uuid: () => string
  logger: ILogger
  watchers: Map<string, Set<(status: TAttachmentStatus) => void>>

  /**
   * The upload handles a drive currently holds, keyed by reference. `cancel`
   * needs the handle itself: the kernel row can be marked from anywhere, but
   * only the object that owns the socket can stop the bytes. An entry lives
   * exactly as long as the transfer it belongs to.
   */
  inFlightUploads: Map<string, IUploadHandle>

  /**
   * References whose current transfer `cancel` aborted, so the drive that is
   * unwinding can tell the app's own stop from a real failure.
   */
  cancelling: Set<string>

  pendingWrite: Promise<void>
}

export const createAttachmentQueue = (deps: TAttachmentQueueDeps): IAttachmentQueue => {
  const { store, config, fileStore, transfer, apply, now, uuid, logger = noopLogger } = deps
  const state: TQueueState = {
    store,
    config,
    fileStore,
    transfer,
    apply,
    now,
    uuid,
    logger,
    watchers: new Map(),
    inFlightUploads: new Map(),
    cancelling: new Set(),
    // Crash recovery: a process that died mid-transfer leaves a row `in_flight = 1` forever invisible to the candidate SELECT. Fired once, synchronously, at construction, before the queue takes its first call. Opens `pendingWrite`, the chain that orders store writes this queue issues without awaiting them ahead of later calls. The NAPI bridge sends every call from its own tokio task, so arrival order at the engine is the scheduler's, not the caller's. Every entry point awaits the chain before its first store call. A failed write is logged and never propagates: the contract both document.
    pendingWrite: store
      .recoverInFlightAttachments(now())
      .catch((error: unknown) => {
        logger.error('attachment crash recovery failed', { error: errorMessage(error) })
      }),
  }

  return {
    fromFile: (args) => fromFile(state, args),
    drive: () => drive(state),
    resolveDownload: (ref) => resolveDownload(state, ref),
    vacuum: () => vacuum(state),
    getStatus: (ref) => getStatus(state, ref),
    watch: (ref, callback) => {
      let subscribers = state.watchers.get(ref)

      if (subscribers === undefined) {
        subscribers = new Set()
        state.watchers.set(ref, subscribers)
      }
      subscribers.add(callback)

      return () => {
        const current = state.watchers.get(ref)

        if (current === undefined) {
          return
        }
        current.delete(callback)

        if (current.size === 0) {
          state.watchers.delete(ref)
        }
      }
    },
    clearLocal: (paths) => clearLocal(state, paths),
    retry: (ref) => retry(state, ref),
    cancel: (ref) => cancel(state, ref),
    remove: (ref) => remove(state, ref),
  }
}

// MARK: - Status

async function getStatus(state: TQueueState, ref: string): Promise<TAttachmentStatus | null> {
  await state.pendingWrite
  const entry = await state.store.getAttachment(ref)

  if (entry === null) {
    return null
  }
  const localUri = entry.localPath !== null ? await state.fileStore.toUri(entry.localPath) : null

  return {
    state: entry.state,
    progress: entry.progress,
    localUri,
    error: entry.error,
    permanent: entry.permanent,
    attempts: entry.attempts,
    errorCode: entry.errorCode,
  }
}

function notify(state: TQueueState, ref: string): void {
  const subscribers = state.watchers.get(ref)

  if (subscribers === undefined || subscribers.size === 0) {
    return
  }
  void getStatus(state, ref)
    .then((status) => {
      if (status === null) {
        return
      }
      for (const callback of subscribers) {
        callback(status)
      }
    })
    .catch((error: unknown) => {
      state.logger.error('attachment status read failed', { ref, error: errorMessage(error) })
    })
}

// MARK: - fromFile

function resolveSpec(
  config: TEngineConfig,
  args: Pick<TFromFileArgs, 'table' | 'column'>,
): { storageBucket: string; ownerColumn: string } {
  const spec = config.tables[args.table]?.attachments?.[args.column]

  if (spec === undefined) {
    throw new Error(`attachment column "${args.column}" is not configured on table "${args.table}"`)
  }
  return spec
}

async function fromFile(state: TQueueState, args: TFromFileArgs): Promise<TFromFileResult> {
  const { store, fileStore, now, uuid, logger } = state
  const spec = resolveSpec(state.config, args)

  await state.pendingWrite
  const row = await store.getRow(args.table, args.pk)

  if (row === null) {
    throw new TEngineError(
      EEngineErrorCode.ATTACHMENT_ROW_GONE,
      `${args.table}/${args.pk} (insert the row before picking a file)`,
    )
  }
  const owner = row[spec.ownerColumn]

  if (typeof owner !== 'string' || owner === '') {
    throw new TEngineError(
      EEngineErrorCode.ATTACHMENT_OWNER_MISSING,
      `${args.table}.${spec.ownerColumn} is not a string`,
    )
  }
  if (!UUID_PATTERN.test(owner) || !UUID_PATTERN.test(args.pk)) {
    throw new TEngineError(
      EEngineErrorCode.LOCAL_CONSTRAINT,
      `an attachment reference needs a uuid owner and primary key, not "${owner}" and "${args.pk}"`,
    )
  }
  const imported = await fileStore.importFromUri(args.uri)

  logger.debug('fromFile imported', { size: imported.size, type: imported.contentType })
  const contentType = args.mediaType ?? imported.contentType
  const uploadId = uuid()
  const ref = `${owner}/${args.pk}/${uploadId}.${extForMime(contentType)}`

  await store.enqueueAttachment({
    ref,
    uploadId,
    table: args.table,
    pk: args.pk,
    column: args.column,
    bucket: spec.storageBucket,
    owner,
    sha256: imported.sha256,
    contentType,
    size: imported.size,
    localPath: imported.path,
    direction: 'upload',
    state: 'queued',
    createdAt: now(),
  })
  await writeReference(state, { args, ref })
  const localUri = await fileStore.toUri(imported.path)

  notify(state, ref)

  return { ref, sha256: imported.sha256, size: imported.size, mediaType: contentType, localUri }
}

/**
 * Puts `ref` onto the row as one local update of its column, the write the
 * native clients' fromFile makes. The enqueue comes first, so a failed write
 * would leave a job whose ref no row will ever carry: the job is evicted,
 * which lets the vacuum delete its bytes without asking Storage, and the
 * caller sees the write's own failure.
 */
async function writeReference(state: TQueueState, write: { args: TFromFileArgs; ref: string }): Promise<void> {
  const { args, ref } = write

  try {
    await state.apply({ table: args.table, pk: args.pk, op: 'update', columns: { [args.column]: ref } })
  } catch (error) {
    await state.store
      .updateAttachment(ref, { state: EAttachmentState.evicted, inFlight: false, error: null, errorCode: null }, state.now())
      .catch((evictionError: unknown) => {
        state.logger.error('attachment eviction failed', { ref, error: errorMessage(evictionError) })
      })

    throw error
  }
}

// MARK: - drive

/**
 * Drive uploads only: a sync NEVER downloads bytes (lazy downloads, fetched on
 * first use by resolveDownload). The pull-apply only SCHEDULES download entries
 * (metadata, no bytes); they sit 'queued' until something views them.
 */
async function drive(state: TQueueState): Promise<void> {
  await state.pendingWrite
  const pending = await state.store.pendingAttachments('upload')

  state.logger.debug('drive: pending uploads', { count: pending.length })

  for (const entry of pending) {
    await driveUpload(state, entry)
  }
}

async function driveUpload(state: TQueueState, entry: TAttachmentEntry): Promise<void> {
  const { store, now, logger } = state

  // The kernel refuses the claim on a permanent row too. Same rule, cheaper half: a budget-stopped reference never costs a round trip, and `drive` does not have to read the answer to know.
  if (entry.permanent) {
    return
  }
  if (!(await store.claimAttachment(entry.ref, 'uploading', now()))) {
    await notifyBudgetStop(state, entry.ref)

    return
  }
  try {
    const sandbox = await guardUpload(state, entry)

    if (sandbox !== null) {
      await transferUpload(state, { entry, ...sandbox })
    }
  } catch (error) {
    logger.error('upload failed', { ref: entry.ref, error: errorMessage(error) })
    await state.pendingWrite
    await store.updateAttachment(entry.ref, uploadFailurePatch(state, entry, error), now())
    notify(state, entry.ref)
  } finally {
    state.inFlightUploads.delete(entry.ref)
    state.cancelling.delete(entry.ref)
  }
}

/**
 * The row a failed upload leaves. An expired or refused tus session restarts
 * from zero, so its stale fingerprint is dropped. An abort the app asked for
 * is not a failed attempt: charging it would let a user who cancels often
 * spend the transfer budget and reach the permanent state through a control
 * that says "not now", and `cancel` has already written the row. A 401
 * refuses the session, not the object, so the claim goes back to `queued`
 * uncharged, the rule the Rust queue follows.
 */
function uploadFailurePatch(state: TQueueState, entry: TAttachmentEntry, error: unknown): TAttachmentPatch {
  const fingerprint = errorCode(error) === ETransferError.expired ? null : undefined

  if (state.cancelling.has(entry.ref)) {
    return { state: 'failed', inFlight: false, error: null, errorCode: null, fingerprint }
  }
  if (errorStatus(error) === HTTP_UNAUTHORIZED) {
    return { state: 'queued', inFlight: false, error: null, errorCode: null, fingerprint }
  }
  return { ...failurePatch(entry, error), fingerprint }
}

/**
 * The row a failed download leaves. A 401 releases the claim uncharged, as
 * an upload's does. A Storage 404 keeps the row retryable, because the peer's
 * bytes may still be on their way, but it costs an attempt like any other
 * failure: an object that never lands would otherwise be re-fetched forever,
 * and the budget is the only thing that ends it.
 */
function downloadFailurePatch(entry: TAttachmentEntry, error: unknown): TAttachmentPatch {
  if (errorStatus(error) === HTTP_UNAUTHORIZED) {
    return { state: 'queued', inFlight: false, error: null, errorCode: null }
  }
  if (errorCode(error) === ETransferError.notYetAvailable) {
    return {
      state: 'queued',
      inFlight: false,
      attempts: entry.attempts + 1,
      errorCode: EEngineErrorCode.ATTACHMENT_NOT_YET_AVAILABLE,
    }
  }
  return failurePatch(entry, error)
}

/**
 * A charged failure, recorded with its message and catalog code. A client
 * error no retry can change stops the row for good; any other failure is
 * retried within the attachment budget.
 */
function failurePatch(entry: TAttachmentEntry, error: unknown): TAttachmentPatch {
  const patch: TAttachmentPatch = {
    state: 'failed',
    inFlight: false,
    error: errorMessage(error),
    errorCode: failureCode(error),
    attempts: entry.attempts + 1,
  }

  return endsForGood(error) ? { ...patch, permanent: true } : patch
}

/**
 * The sandbox bytes of a claimed upload that is still worth sending, or null
 * once the row has been settled here instead (released or failed).
 *
 * A row that is gone, tombstoned, or carries another ref is no evidence that
 * the server dropped the object: the delete or the replace may still be this
 * device's queued write, and the caller's apply() may not have written this
 * ref yet (fromFile() enqueues first). The claim is released and the object
 * left alone; only the kernel's pull hands an object to the vacuum.
 */
async function guardUpload(
  state: TQueueState,
  entry: TAttachmentEntry,
): Promise<{ localPath: string; sha256: string } | null> {
  const { store, now } = state
  const row = await store.getRow(entry.table, entry.pk)
  const tombstoned = await store.hasTombstone(entry.table, entry.pk)

  if (row === null || tombstoned || row[entry.column] !== entry.ref) {
    await store.updateAttachment(entry.ref, { state: 'queued', inFlight: false }, now())
    notify(state, entry.ref)

    return null
  }
  if (entry.localPath === null || entry.sha256 === null) {
    await store.updateAttachment(
      entry.ref,
      { state: 'failed', inFlight: false, error: 'missing sandbox bytes', errorCode: EEngineErrorCode.STORE },
      now(),
    )
    notify(state, entry.ref)

    return null
  }
  return { localPath: entry.localPath, sha256: entry.sha256 }
}

type TReadyUpload = {
  entry: TAttachmentEntry
  localPath: string
  sha256: string
}

async function transferUpload(state: TQueueState, upload: TReadyUpload): Promise<void> {
  const { store, transfer, now, logger } = state
  const { entry, localPath, sha256 } = upload
  const handle = await transfer.createUpload(
    localPath,
    {
      bucket: entry.bucket,
      path: entry.ref,
      contentType: entry.contentType ?? 'application/octet-stream',
    },
    { resumeFingerprint: entry.fingerprint ?? undefined, sha256 },
  )

  state.inFlightUploads.set(entry.ref, handle)
  // Persist the resume token the moment the adapter has one: a session announced after `done` resolves is worthless, since only an upload that DIDN'T finish needs it. Empty is not a token: writing '' would look like a session to the retry, which would then resume from a byte that has no server-side offset. Fire-and-forget by contract (the announcement is synchronous, mid-transfer): a failed write only costs a restart from zero, so it is logged, not propagated. It joins `pendingWrite`, so the terminal write of this transfer cannot land before it and leave a stale fingerprint on a row this upload already finished with.
  handle.onSessionCreated?.((fingerprint) => {
    if (fingerprint === '') {
      return
    }
    state.pendingWrite = state.pendingWrite
      .then(() => store.updateAttachment(entry.ref, { fingerprint }, now()))
      .catch((error: unknown) => {
        logger.error('attachment fingerprint persist failed', {
          ref: entry.ref,
          error: errorMessage(error),
        })
      })
  })

  if (handle.resumable && handle.fingerprint !== '' && handle.fingerprint !== entry.fingerprint) {
    await store.updateAttachment(entry.ref, { fingerprint: handle.fingerprint }, now())
  }
  for await (const progress of handle.progress) {
    await store.updateAttachment(entry.ref, { progress }, now())
    notify(state, entry.ref)
  }
  await handle.done
  await transfer.confirm(
    { bucket: entry.bucket, path: entry.ref },
    {
      sha256,
      size: entry.size ?? 0,
      contentType: entry.contentType ?? 'application/octet-stream',
    },
    entry.table,
  )
  // Keep the sandbox file as the local cache (no re-download on this device); vacuum / a cache cap reclaims it later.
  await state.pendingWrite
  await store.updateAttachment(
    entry.ref,
    { state: 'synced', progress: 100, inFlight: false, error: null, errorCode: null },
    now(),
  )
  logger.debug('upload ok', { ref: entry.ref })
  notify(state, entry.ref)
}

/**
 * The kernel stops a row whose budget is spent at the claim itself, flipping
 * `permanent` where no transfer runs to report it: a refused claim that left
 * the row permanent is news for its watchers.
 */
async function notifyBudgetStop(state: TQueueState, ref: string): Promise<void> {
  const refused = await state.store.getAttachment(ref)

  if (refused?.permanent === true) {
    notify(state, ref)
  }
}

async function driveDownload(state: TQueueState, entry: TAttachmentEntry): Promise<void> {
  const { store, transfer, now, logger } = state

  if (entry.permanent) {
    return
  }
  if (!(await store.claimAttachment(entry.ref, 'downloading', now()))) {
    await notifyBudgetStop(state, entry.ref)

    return
  }
  try {
    const meta = await transfer.metadata({ bucket: entry.bucket, path: entry.ref })
    // The server's hash, else the one this device kept: a peer's ref never names the file, and bytes nothing can verify are refused.
    const expectedSha = [meta?.sha256, entry.sha256].find(isSha256)

    if (expectedSha === undefined) {
      throw new TEngineError(EEngineErrorCode.ATTACHMENT_UNVERIFIED, `${entry.ref} has no known SHA-256`)
    }
    const sandboxPath = `downloads/${expectedSha}`

    await transfer.download({ bucket: entry.bucket, path: entry.ref }, sandboxPath, {
      sha256: expectedSha,
    })
    await store.updateAttachment(
      entry.ref,
      { state: 'synced', localPath: sandboxPath, sha256: expectedSha, inFlight: false, error: null, errorCode: null },
      now(),
    )
    logger.debug('download ok', { ref: entry.ref, path: sandboxPath })
    notify(state, entry.ref)
  } catch (error) {
    logger.error('download failed', { ref: entry.ref, error: errorMessage(error) })
    await store.updateAttachment(entry.ref, downloadFailurePatch(entry, error), now())
    notify(state, entry.ref)
  }
}

// MARK: - resolveDownload

async function resolveDownload(state: TQueueState, ref: string): Promise<string | null> {
  const { store, fileStore } = state

  await state.pendingWrite
  const entry = await store.getAttachment(ref)

  if (entry === null) {
    // No locator on this device: the pull-apply schedules a download entry for any peer ref it sees, so a missing entry means the ref never arrived.
    return null
  }
  if (entry.localPath !== null) {
    return fileStore.toUri(entry.localPath)
  }
  if (entry.direction === 'download' && (entry.state === 'queued' || entry.state === 'failed')) {
    await driveDownload(state, entry)
    const refreshed = await store.getAttachment(ref)

    if (refreshed !== null && refreshed.localPath !== null) {
      return fileStore.toUri(refreshed.localPath)
    }
  }
  return null
}

// MARK: - vacuum

async function vacuum(state: TQueueState): Promise<void> {
  await state.pendingWrite

  for (const entry of await state.store.orphanedAttachments()) {
    if (entry.state === EAttachmentState.evicted) {
      await evictLocally(state, entry)
      continue
    }
    await vacuumOrphan(state, entry)
  }
}

/**
 * Removes an orphan's Storage object, then its sandbox bytes and its row. A
 * removal Storage refuses with 401 or 403, or one still failing once the
 * attachment budget is spent, ends as a local eviction. Any other failure is
 * recorded for the next vacuum: purging now would leak the remote object with
 * no way to retry.
 */
async function vacuumOrphan(state: TQueueState, entry: TAttachmentEntry): Promise<void> {
  const { store, transfer, now } = state

  try {
    await transfer.remove({ bucket: entry.bucket, path: entry.ref })
  } catch (error) {
    if (givesUpOnRemoval(state, entry, error)) {
      await evictLocally(state, entry)

      return
    }
    await store.updateAttachment(
      entry.ref,
      { attempts: entry.attempts + 1, error: errorMessage(error), errorCode: failureCode(error) },
      now(),
    )

    return
  }
  await releaseOrphanBytes(state, entry)
  await store.purgeAttachment(entry.ref)
}

/** Whether a failed removal ends here: Storage refused this session or its access, or the attempt just made spent the budget. */
function givesUpOnRemoval(state: TQueueState, entry: TAttachmentEntry, error: unknown): boolean {
  const status = errorStatus(error)
  const budget = state.config.attachmentAttempts ?? DEFAULT_ATTACHMENT_ATTEMPTS

  return status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN || entry.attempts + 1 >= budget
}

/**
 * Leaves `entry` evicted with no local bytes: the cached file is deleted
 * unless a live row shares it, its path is forgotten, and the row keeps the
 * hash that verifies the object again. Storage is never asked.
 */
async function evictLocally(state: TQueueState, entry: TAttachmentEntry): Promise<void> {
  await releaseOrphanBytes(state, entry)
  await state.store.updateAttachment(
    entry.ref,
    { state: EAttachmentState.evicted, inFlight: false, localPath: null, error: null, errorCode: null },
    state.now(),
  )
}

/** Deletes the sandbox bytes a row the vacuum owns cached, unless a live row still shares them. */
async function releaseOrphanBytes(state: TQueueState, entry: TAttachmentEntry): Promise<void> {
  if (entry.localPath === null) {
    return
  }
  // Content addressing means another LIVE row can share this exact sandbox path (identical bytes), never delete bytes it still needs.
  const shared =
    (await state.store.countLiveAttachmentsAtLocalPath(entry.localPath, entry.ref)) > 0

  if (!shared) {
    try {
      await state.fileStore.delete(entry.localPath)
    } catch {
      // best-effort: a missing sandbox file is fine.
    }
  }
}

// MARK: - The app's own controls

async function retry(state: TQueueState, ref: string): Promise<void> {
  await state.pendingWrite
  await state.store.retryAttachment(ref)
  notify(state, ref)
}

async function cancel(state: TQueueState, ref: string): Promise<void> {
  const handle = state.inFlightUploads.get(ref)

  if (handle !== undefined) {
    state.cancelling.add(ref)

    try {
      await handle.abort()
    } catch (error) {
      // An adapter that cannot stop the socket must not stop the row from being marked: the kernel write below is what the app asked for, and the transfer settles into the same `failed` state either way.
      state.logger.error('attachment abort failed', { ref, error: errorMessage(error) })
    }
  }
  await state.pendingWrite
  await state.store.cancelAttachment(ref)
  notify(state, ref)
}

async function remove(state: TQueueState, ref: string): Promise<void> {
  const { store, fileStore } = state

  await state.pendingWrite
  const localPath = await store.removeAttachment(ref)

  if (localPath === null) {
    notify(state, ref)

    return
  }
  // Same shared-bytes rule as vacuum: content addressing means another live row can cache these exact bytes, and the row that asked to be forgotten is already gone, so there is no ref of its own to exclude.
  if ((await store.countLiveAttachmentsAtLocalPath(localPath)) === 0) {
    try {
      await fileStore.delete(localPath)
    } catch {
      // best-effort: a missing sandbox file is fine.
    }
  }
  notify(state, ref)
}

// MARK: - clearLocal

async function clearLocal(state: TQueueState, paths: string[]): Promise<void> {
  const { store, fileStore } = state

  await state.pendingWrite

  for (const path of paths) {
    // store.reset() has already wiped every attachment row by the time this runs, but a fresh fromFile() racing the reset can re-import the SAME content-addressed path into a brand-new live row before we get here; same shared-bytes rule as vacuum, no ref of our own to exclude.
    const shared = (await store.countLiveAttachmentsAtLocalPath(path)) > 0

    if (shared) {
      continue
    }
    try {
      await fileStore.delete(path)
    } catch {
      // best-effort during reset.
    }
  }
}
