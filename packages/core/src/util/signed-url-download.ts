import { SIGNED_URL_TTL_SECONDS } from '../constants'
import type { IFileStore } from '../ports/file-store'
import { ETransferError, type ITransfer } from '../ports/transfer'
import { EEngineErrorCode } from '../wire/types'
import { createRequestSignal, createTransferTimeoutError, DEFAULT_TRANSFER_BYTES_TIMEOUT_MS, DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS, withDeadline } from './deadline'
import { noopLogger, type ILogger } from './logger'
import { sha256Hex } from './sha256'

// MARK: - createSignedUrlDownload

export interface ICreateSignedUrlDownloadOptions {
  /**
   * The Supabase client, typed by the one call made on it, so this package
   * depends on no supabase-js type.
   */
  client: {
    storage: {
      from(bucket: string): {
        createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: { status?: number | string; message: string } | null }>
      }
    }
  }

  fileStore: IFileStore
  logger?: ILogger

  /**
   * Deadline for the signed-URL request. `<= 0` disables it. Defaults to
   * {@link DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS}.
   */
  controlTimeoutMs?: number

  /**
   * Deadline for the request that carries the bytes. `<= 0` disables it.
   * Defaults to {@link DEFAULT_TRANSFER_BYTES_TIMEOUT_MS}.
   */
  bytesTimeoutMs?: number

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout. Threaded into both deadlines.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void

  /**
   * Fetches the signed URL under `signal`. Each runtime reads the body its own
   * way, which is why the caller supplies it: the answer only has to expose the
   * bytes as an `ArrayBuffer`.
   */
  fetchBytes: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>
}

/** The options with their defaults resolved, as every phase of one download reads them. */
type TDownloadSettings = ICreateSignedUrlDownloadOptions & {
  logger: ILogger
  controlTimeoutMs: number
  bytesTimeoutMs: number
}

/**
 * The `ITransfer['download']` of the Supabase transfer adapters. It reads the
 * bytes over a short-lived signed URL plus a fetch, never `storage.download()`:
 * the SDK's download builds a Blob from an ArrayBuffer, which React Native
 * forbids. A signed URL honors RLS for public and private buckets. The
 * signed-URL request runs under the control deadline and the fetch that carries
 * the bytes under the bytes deadline, with a real AbortSignal so a hung socket
 * is dropped, not merely left un-awaited. A blown deadline rejects with the
 * retryable `ETransferError.timedOut`. A refusal the host answered with a
 * numeric HTTP status carries it as `.status`. Bytes that miss the expected
 * SHA-256 reject with the `ATTACHMENT_HASH_MISMATCH` code before any write.
 */
export const createSignedUrlDownload = (options: ICreateSignedUrlDownloadOptions): ITransfer['download'] => {
  const {
    logger = noopLogger,
    controlTimeoutMs = DEFAULT_TRANSFER_CONTROL_TIMEOUT_MS,
    bytesTimeoutMs = DEFAULT_TRANSFER_BYTES_TIMEOUT_MS,
  } = options
  const settings: TDownloadSettings = { ...options, logger, controlTimeoutMs, bytesTimeoutMs }

  return async (target, toLocalPath, downloadOptions) => {
    const signedUrl = await signObjectUrl(settings, target)
    const buffer = await fetchSignedBytes(settings, signedUrl)

    settings.logger.debug('download bytes', { bytes: buffer.byteLength, path: target.path })

    if (downloadOptions?.sha256 !== undefined && sha256Hex(buffer) !== downloadOptions.sha256) {
      throw Object.assign(new Error(`attachment sha256 mismatch for ${target.path}`), {
        code: EEngineErrorCode.ATTACHMENT_HASH_MISMATCH,
      })
    }
    await settings.fileStore.writeAtomic(toLocalPath, buffer)
  }
}

// MARK: - Download phases

/** The object's signed URL, under the control deadline. */
async function signObjectUrl(settings: TDownloadSettings, target: { bucket: string; path: string }): Promise<string> {
  const { client, controlTimeoutMs } = settings
  const { data: signed, error } = await withDeadline(
    () => client.storage.from(target.bucket).createSignedUrl(target.path, SIGNED_URL_TTL_SECONDS),
    {
      timeoutMs: controlTimeoutMs,
      onTimeout: () => createTransferTimeoutError({ operation: 'sign', timeoutMs: controlTimeoutMs }),
      setTimer: settings.setTimer,
      clearTimer: settings.clearTimer,
    },
  )

  if (error !== null || signed === null) {
    throw signRefusal(error)
  }
  return signed.signedUrl
}

/** The sign request's failure as supabase-js reports it. */
type TSignError = { status?: number | string; message: string } | null

/**
 * The error a failed sign request throws, carrying the numeric HTTP status
 * when Storage answered one. Only a 404 means "the bytes are not there yet"
 * (re-queue, see ETransferError docs). `status` is a structured field on
 * supabase-js's StorageError, and 404 is the code the Storage error contract
 * documents for a missing bucket/object
 * (https://supabase.com/docs/guides/storage/debugging/error-codes); everything
 * else (401/403/5xx/network) is a real failure and must reach the queue's
 * failed-path, so it throws WITHOUT the notYetAvailable code.
 */
function signRefusal(error: TSignError): Error {
  const status = typeof error?.status === 'number' ? { status: error.status } : {}

  if (error?.status === 404) {
    return Object.assign(new Error(`attachment not available: ${error.message}`), {
      code: ETransferError.notYetAvailable,
      ...status,
    })
  }
  return Object.assign(
    new Error(`attachment sign failed (${error?.status ?? 'unknown'}): ${error?.message ?? 'missing'}`),
    status,
  )
}

/** The object's bytes, fetched over its signed URL under the bytes deadline. */
async function fetchSignedBytes(settings: TDownloadSettings, signedUrl: string): Promise<ArrayBuffer> {
  const { bytesTimeoutMs } = settings
  const { signal, timedOut, release } = createRequestSignal({
    timeoutMs: bytesTimeoutMs,
    setTimer: settings.setTimer,
    clearTimer: settings.clearTimer,
  })
  let response: Awaited<ReturnType<ICreateSignedUrlDownloadOptions['fetchBytes']>>

  try {
    response = await settings.fetchBytes(signedUrl, signal)
  } catch (cause) {
    if (timedOut()) {
      throw createTransferTimeoutError({ operation: 'download', timeoutMs: bytesTimeoutMs })
    }
    throw cause
  } finally {
    release()
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw Object.assign(new Error(`attachment fetch failed: ${response.status}`), {
        code: ETransferError.notYetAvailable,
        status: response.status,
      })
    }
    throw Object.assign(new Error(`attachment fetch failed: ${response.status}`), { status: response.status })
  }
  return response.arrayBuffer()
}
