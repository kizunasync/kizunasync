import type { SupabaseClient } from '@supabase/supabase-js'
import { createRequestSignal, createSignedUrlDownload, createTransferTimeoutError, DEFAULT_TRANSFER_BYTES_TIMEOUT_MS, DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS, noopLogger, withDeadline, type ICreateSignedUrlDownloadOptions, type IFileStore, type ILogger, type ITransfer, type IUploadHandle, type IUploadTarget } from '@kizunasync/core'
import { SCHEMA } from '@kizunasync/core/constants'
import { sessionTimeoutError } from './session-errors'
import { SINGLE_SHOT_MAX_BYTES, storageErrorStatus, storageResponseStatus, tusEndpointFromSupabaseUrl, tusUpload, type TTusUploadResult } from './tus-client'

// MARK: - Supabase transfer adapter

/**
 * Uploads/downloads attachment bytes via Supabase Storage and records integrity
 * metadata via the kizunasync.attachment_confirm / _vacuum RPCs. Peers VERIFY a
 * download against the server-recorded sha256.
 *
 * Upload policy (matches the Supabase Storage docs):
 * - `≤ 6 MiB`: storage-js single-shot (or direct ArrayBuffer upload)
 * - `> 6 MiB`: TUS resumable at `/storage/v1/upload/resumable`, chunk size
 *   fixed at 6 MiB; fingerprint = TUS session URL, handed to `onSessionCreated`
 *   as soon as the session exists (before the first chunk) so the queue persists
 *   it before transfer. A later queue instance can reuse that URL when local
 *   state and the remote session remain available; physical kill behavior is
 *   platform- and driver-specific.
 *
 * Every network wait below is bounded by one of two deadlines. A hung
 * request must not hold the sync scheduler's in-flight slot forever. Control
 * requests (session lookup, TUS create/offset probe, createSignedUrl, confirm,
 * vacuum, remove, metadata) use {@link DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS};
 * requests that carry bytes (single-shot upload, each TUS chunk, download) use
 * {@link DEFAULT_TRANSFER_BYTES_TIMEOUT_MS}. A blown deadline rejects with
 * `ETransferError.timedOut` (or `AUTH_SESSION_TIMEOUT` for the session lookup)
 * and is retryable by the queue's existing rules.
 *
 * A Storage refusal carries the status it means as `.status`: most refusals
 * answer HTTP 400 and name the real status in the body.
 */

/**
 * Blob → ArrayBuffer that works on web AND React Native. RN's Blob has no usable
 * `arrayBuffer()` (and `FileReader.readAsArrayBuffer` is unsupported), so fall
 * back to `readAsDataURL` + base64 decode, which RN does support. Web keeps the
 * native fast path.
 */
const blobToArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.onload = () => {
      const result = String(reader.result)
      const binary = globalThis.atob(result.slice(result.indexOf(',') + 1))
      const bytes = new Uint8Array(binary.length)

      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      resolve(bytes.buffer)
    }
    reader.readAsDataURL(blob)
  })
}

type TClientInternals = {
  supabaseKey?: string
  supabaseUrl?: string
  rest?: { url?: string }
}

const clientInternals = (client: SupabaseClient): TClientInternals =>
  client as unknown as TClientInternals

/**
 * Injectable timer pair, forwarded from {@link createSupabaseTransfer} into
 * `resolveAccessToken`'s own deadline.
 */
type TAccessTokenDeadline = {
  timeoutMs: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const resolveAccessToken = async (client: SupabaseClient, deadline: TAccessTokenDeadline): Promise<string> => {
  const { data, error } = await withDeadline(() => client.auth.getSession(), {
    timeoutMs: deadline.timeoutMs,
    onTimeout: () => sessionTimeoutError(deadline.timeoutMs),
    setTimer: deadline.setTimer,
    clearTimer: deadline.clearTimer,
  })

  if (error !== null) {
    throw new Error(`auth session failed: ${error.message}`)
  }
  const token = data.session?.access_token

  if (token === undefined || token === '') {
    // Fall back to the anon key for public-bucket demo paths when signed out.
    const key = clientInternals(client).supabaseKey

    if (typeof key === 'string' && key.length > 0) {
      return key
    }
    throw new Error('no auth session for storage upload')
  }
  return token
}

const resolveSupabaseUrl = (client: SupabaseClient): string => {
  const internals = clientInternals(client)
  const url = internals.supabaseUrl

  if (typeof url === 'string' && url.length > 0) {
    return url
  }
  // supabase-js v2 stores rest URL on the client internals in some builds
  const rest = internals.rest?.url

  if (typeof rest === 'string' && rest.length > 0) {
    return rest.replace(/\/rest\/v1\/?$/, '')
  }
  throw new Error('cannot resolve supabase URL for TUS endpoint')
}

export function createSupabaseTransfer(options: {
  client: SupabaseClient
  fileStore: IFileStore
  logger?: ILogger

  /** Override single-shot threshold (tests). Default: 6 MiB. */
  singleShotMaxBytes?: number

  /** Override TUS endpoint (tests). */
  tusEndpoint?: string

  /**
   * Deadline for short control requests (session lookup, TUS create/offset
   * probe, createSignedUrl, confirm, vacuum, remove, metadata). `<= 0`
   * disables the deadline. Defaults to
   * {@link DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS}.
   */
  controlTimeoutMs?: number

  /**
   * Deadline for requests that carry bytes (single-shot upload, each TUS
   * chunk, download). `<= 0` disables the deadline. Defaults to
   * {@link DEFAULT_TRANSFER_BYTES_TIMEOUT_MS}.
   */
  bytesTimeoutMs?: number

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout. Threaded into every deadline this adapter arms.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void
}): ITransfer {
  const {
    client,
    fileStore,
    logger = noopLogger,
    singleShotMaxBytes = SINGLE_SHOT_MAX_BYTES,
    controlTimeoutMs = DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS,
    bytesTimeoutMs = DEFAULT_TRANSFER_BYTES_TIMEOUT_MS,
    setTimer,
    clearTimer,
  } = options
  const context: ITransferContext = {
    client,
    kizunasync: openKizunaSyncSchema(client),
    fileStore,
    logger,
    singleShotMaxBytes,
    controlTimeoutMs,
    bytesTimeoutMs,
    setTimer,
    clearTimer,
    tusEndpoint: () => options.tusEndpoint,
  }

  return {
    createUpload: (localPath, target, uploadOptions) => startUpload(context, { localPath, target, uploadOptions }),
    download: createSignedUrlDownload({
      client: withMeantStatuses(client),
      fileStore,
      logger,
      controlTimeoutMs,
      bytesTimeoutMs,
      setTimer,
      clearTimer,
      fetchBytes: fetchBlobBytes,
    }),
    confirm: (target, meta, table) => confirmUpload(context, { target, meta, table }),
    metadata: (target) => readMetadata(context, target),
    remove: (target) => removeObject(context, target),
  }
}

// MARK: - Adapter state

/** The `kizunasync` schema client every RPC below goes through. */
function openKizunaSyncSchema(client: SupabaseClient) {
  // The untyped demo client can't prove 'kizunasync' is a known schema; the cast keeps the call generic while still going through .schema(...).rpc/.from.
  return client.schema(SCHEMA as never)
}

/** The adapter's resolved options, read by every operation below. */
interface ITransferContext {
  client: SupabaseClient
  kizunasync: ReturnType<typeof openKizunaSyncSchema>
  fileStore: IFileStore
  logger: ILogger
  singleShotMaxBytes: number
  controlTimeoutMs: number
  bytesTimeoutMs: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void

  /** The endpoint override, read each time a TUS upload starts rather than once at construction. */
  tusEndpoint: () => string | undefined
}

/** One Storage object, as `confirm`, `metadata` and `remove` address it. */
type TObjectTarget = Parameters<ITransfer['remove']>[0]

/** A failure that carries the HTTP status the host answered, the field the queue classifies a refusal by. */
function refusal(message: string, status: number | undefined): Error {
  return status === undefined ? new Error(message) : Object.assign(new Error(message), { status })
}

// MARK: - Upload

type TUploadRequest = {
  localPath: string
  target: IUploadTarget
  uploadOptions: Parameters<ITransfer['createUpload']>[2]
}

/** One upload's abort switch, shared by its handle and the request that moves its bytes. */
interface IUploadAbort {
  aborted: boolean
  controller: AbortController
}

async function startUpload(context: ITransferContext, request: TUploadRequest): Promise<IUploadHandle> {
  const { localPath, target } = request
  const buffer = await context.fileStore.read(localPath)
  const bytes = new Uint8Array(buffer)

  context.logger.debug('upload bytes', { bytes: bytes.byteLength, path: target.path })

  const abort: IUploadAbort = { aborted: false, controller: new AbortController() }

  // Dual-path: single-shot under threshold; TUS resumable above (Supabase default).
  if (bytes.byteLength <= context.singleShotMaxBytes) {
    return createSingleShotHandle(context, { target, buffer, abort })
  }
  return createTusHandle(context, { target, uploadOptions: request.uploadOptions, bytes, abort })
}

type TSingleShotUpload = {
  target: IUploadTarget
  buffer: ArrayBuffer
  abort: IUploadAbort
}

function createSingleShotHandle(context: ITransferContext, upload: TSingleShotUpload): IUploadHandle {
  const { target, buffer, abort } = upload
  const done = (async () => {
    if (abort.aborted) {
      throw new Error('upload aborted')
    }
    // storage-js's FileOptions exposes no signal/abort, so this deadline only bounds how long the wait lasts: a timed-out request may still land on the server. Harmless: the queue's retry re-uploads with `upsert: true`.
    const { error } = await withDeadline(
      () =>
        context.client.storage
          .from(target.bucket)
          .upload(target.path, buffer, { contentType: target.contentType, upsert: true }),
      {
        timeoutMs: context.bytesTimeoutMs,
        onTimeout: () => createTransferTimeoutError({ operation: 'upload', timeoutMs: context.bytesTimeoutMs }),
        setTimer: context.setTimer,
        clearTimer: context.clearTimer,
      },
    )

    if (error !== null) {
      throw refusal(`attachment upload failed: ${error.message}`, storageErrorStatus(error))
    }
  })()

  // Same late-await window as the TUS path below: mark it handled, keep it rejecting.
  void done.catch(() => undefined)

  return {
    resumable: false,
    fingerprint: '',
    progress: (async function* () {
      yield 100
    })(),
    done,
    abort: async () => {
      abort.aborted = true
      abort.controller.abort()
    },
  }
}

type TTusUpload = {
  target: IUploadTarget
  uploadOptions: TUploadRequest['uploadOptions']
  bytes: Uint8Array
  abort: IUploadAbort
}

function createTusHandle(context: ITransferContext, upload: TTusUpload): IUploadHandle {
  const { uploadOptions, abort } = upload
  // TUS resumable path: build handle first so async work can update fingerprint.
  const feed = createProgressFeed()
  // The live session URL, announced once tusCreate returns its Location. Null until then; a listener registered afterwards is fired on the spot, so the queue can never miss the token by registering late.
  let sessionUrl: string | null = null
  let sessionListener: ((fingerprint: string) => void) | null = null
  const handle: IUploadHandle = {
    resumable: true,
    fingerprint: uploadOptions.resumeFingerprint ?? '',
    progress: feed.progress,
    done: Promise.resolve(),
    abort: async () => {
      abort.aborted = true
      abort.controller.abort()
    },
    onSessionCreated: (listener) => {
      sessionListener = listener

      if (sessionUrl !== null) {
        listener(sessionUrl)
      }
    },
  }
  const publishSession = (uploadUrl: string): void => {
    sessionUrl = uploadUrl
    handle.fingerprint = uploadUrl
    sessionListener?.(uploadUrl)
  }
  const done = (async () => {
    try {
      const result = await uploadOverTus(context, { ...upload, feed, publishSession })

      feed.notify(100)
      // A resumed upload creates no session, so this is where its URL lands.
      handle.fingerprint = result.uploadUrl
    } finally {
      feed.settle()
    }
  })()

  // The consumer drains `progress` before awaiting `done`, so a fast failure would be reported as an unhandled rejection while it is still iterating. This observer only marks it handled; `handle.done` still rejects.
  void done.catch(() => undefined)
  handle.done = done

  return handle
}

type TTusRun = TTusUpload & {
  feed: IProgressFeed
  publishSession: (uploadUrl: string) => void
}

async function uploadOverTus(context: ITransferContext, run: TTusRun): Promise<TTusUploadResult> {
  const { target, feed } = run
  const accessToken = await resolveAccessToken(context.client, {
    timeoutMs: context.controlTimeoutMs,
    setTimer: context.setTimer,
    clearTimer: context.clearTimer,
  })
  const endpoint = context.tusEndpoint() ?? tusEndpointFromSupabaseUrl(resolveSupabaseUrl(context.client))

  return tusUpload({
    endpoint,
    accessToken,
    bucket: target.bucket,
    objectName: target.path,
    contentType: target.contentType,
    data: run.bytes,
    resumeUrl: run.uploadOptions.resumeFingerprint,
    upsert: true,
    signal: run.abort.controller.signal,
    requestTimeoutMs: context.controlTimeoutMs,
    bytesTimeoutMs: context.bytesTimeoutMs,
    setTimer: context.setTimer,
    clearTimer: context.clearTimer,
    onProgress: (uploaded, total) => {
      feed.notify(Math.min(100, Math.floor((uploaded / total) * 100)))
    },
    onSessionCreated: run.publishSession,
  })
}

/** The TUS path's progress iterable and the two calls that drive it. */
interface IProgressFeed {
  progress: AsyncIterable<number>
  notify: (percent: number) => void
  settle: () => void
}

function createProgressFeed(): IProgressFeed {
  let progressValue = 0
  let settled = false
  const progressWaiters: Array<() => void> = []
  const wakeProgress = (): void => {
    for (const wake of progressWaiters) {
      wake()
    }
    progressWaiters.length = 0
  }

  return {
    progress: (async function* () {
      let last = 0

      while (last < 100) {
        if (progressValue > last) {
          last = progressValue
          yield last
        } else if (settled) {
          return
        } else {
          await new Promise<void>((resolve) => {
            progressWaiters.push(resolve)
          })
        }
      }
    })(),
    notify: (percent) => {
      progressValue = percent
      wakeProgress()
    },
    // The terminal outcome, whatever it is: the generator above waits on a promise nothing else resolves, so a failed or aborted upload would leave the consumer iterating forever and never reach `done`'s rejection.
    settle: () => {
      settled = true
      wakeProgress()
    },
  }
}

// MARK: - Download

/** The download's byte fetch: a plain fetch whose body goes through {@link blobToArrayBuffer}, which also works on React Native. A refusal reports the status Storage means. */
async function fetchBlobBytes(url: string, signal: AbortSignal): ReturnType<ICreateSignedUrlDownloadOptions['fetchBytes']> {
  const response = await fetch(url, { signal })
  const status = response.ok ? response.status : storageResponseStatus(response.status, await response.text().catch(() => ''))

  return {
    ok: response.ok,
    status,
    arrayBuffer: async () => blobToArrayBuffer(await response.blob()),
  }
}

/** The client the signed-URL download signs through, whose sign refusals report the status Storage means. */
function withMeantStatuses(client: SupabaseClient): ICreateSignedUrlDownloadOptions['client'] {
  return {
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path, expiresIn) => {
          const signed = await client.storage.from(bucket).createSignedUrl(path, expiresIn)

          return signed.error === null
            ? signed
            : { data: null, error: { message: signed.error.message, status: storageErrorStatus(signed.error) } }
        },
      }),
    },
  }
}

// MARK: - Integrity RPCs

type TControlRequest<T> = {
  /** Names the request in the timeout message. */
  operation: string

  run: (signal: AbortSignal) => PromiseLike<T>
}

/**
 * Runs one abortable control request under the control deadline. Only a
 * request the deadline itself aborted becomes the retryable timeout; any other
 * failure passes through unchanged.
 */
async function underControlDeadline<T>(context: ITransferContext, request: TControlRequest<T>): Promise<T> {
  const { signal, timedOut, release } = createRequestSignal({
    timeoutMs: context.controlTimeoutMs,
    setTimer: context.setTimer,
    clearTimer: context.clearTimer,
  })

  try {
    return await request.run(signal)
  } catch (cause) {
    if (timedOut()) {
      throw createTransferTimeoutError({ operation: request.operation, timeoutMs: context.controlTimeoutMs })
    }
    throw cause
  } finally {
    release()
  }
}

type TConfirmation = {
  target: TObjectTarget
  meta: Parameters<ITransfer['confirm']>[1]
  table: string
}

async function confirmUpload(context: ITransferContext, confirmation: TConfirmation): Promise<void> {
  const { target, meta, table } = confirmation

  await underControlDeadline(context, {
    operation: 'confirm',
    run: async (signal) => {
      const { error, status } = await context.kizunasync
        .rpc('attachment_confirm', {
          p_bucket: target.bucket,
          p_path: target.path,
          p_sha256: meta.sha256,
          p_size: meta.size,
          p_media_type: meta.contentType,
          p_table: table,
        })
        .abortSignal(signal)

      if (error !== null) {
        throw refusal(`attachment_confirm failed: ${error.message}`, status)
      }
    },
  })
}

/**
 * The integrity metadata a peer verifies its download against, read through
 * `kizunasync.attachment_metadata`, not the table. The table carries every
 * project's objects and grants no SELECT to a client role; the definer RPC
 * answers only for an object the caller owns or whose owning row the caller
 * can read through RLS.
 */
async function readMetadata(context: ITransferContext, target: TObjectTarget): Promise<{ sha256: string } | null> {
  const result = await underControlDeadline(context, {
    operation: 'metadata lookup',
    run: (signal) =>
      context.kizunasync
        .rpc('attachment_metadata', {
          p_bucket_id: target.bucket,
          p_object_path: target.path,
        })
        .abortSignal(signal)
        .maybeSingle(),
  })
  const data: unknown = result.data
  const error: { message: string } | null = result.error

  if (error !== null) {
    throw refusal(`attachment metadata lookup failed: ${error.message}`, result.status)
  }
  if (data === null) {
    return null
  }
  const sha = (data as { sha256: string | null }).sha256

  return sha === null ? null : { sha256: sha }
}

async function removeObject(context: ITransferContext, target: TObjectTarget): Promise<void> {
  const { error: storageError } = await withDeadline(
    () => context.client.storage.from(target.bucket).remove([target.path]),
    {
      timeoutMs: context.controlTimeoutMs,
      onTimeout: () => createTransferTimeoutError({ operation: 'remove', timeoutMs: context.controlTimeoutMs }),
      setTimer: context.setTimer,
      clearTimer: context.clearTimer,
    },
  )

  if (storageError !== null) {
    throw refusal(`attachment storage remove failed: ${storageError.message}`, storageErrorStatus(storageError))
  }
  await underControlDeadline(context, {
    operation: 'vacuum',
    run: async (signal) => {
      const { error: vacuumError, status } = await context.kizunasync
        .rpc('attachment_vacuum', {
          p_bucket: target.bucket,
          p_path: target.path,
        })
        .abortSignal(signal)

      if (vacuumError !== null) {
        throw refusal(`attachment_vacuum failed: ${vacuumError.message}`, status)
      }
    },
  })
}
