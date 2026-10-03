// MARK: - Minimal TUS client for Supabase Storage resumable uploads

/**
 * Implements the TUS protocol subset Supabase documents:
 * - endpoint: `{supabaseUrl}/storage/v1/upload/resumable`
 * - chunk size MUST be 6 MiB
 * - metadata: bucketName, objectName, contentType, cacheControl
 * - auth: Bearer access token; optional x-upsert
 *
 * No tus-js-client dependency: pure fetch so web, Node, and RN share one path.
 */

import { createRequestSignal, createTransferTimeoutError, ETransferError, type TTransferErrorCode } from '@kizunasync/core'

export const TUS_CHUNK_SIZE = 6 * 1024 * 1024
export const SINGLE_SHOT_MAX_BYTES = TUS_CHUNK_SIZE

export type TTusUploadOptions = {
  endpoint: string
  accessToken: string
  bucket: string
  objectName: string
  contentType: string

  /** Full object bytes (or a view of the file). */
  data: Uint8Array

  /** Resume from a prior TUS upload URL (fingerprint). */
  resumeUrl?: string

  upsert?: boolean
  cacheControl?: string
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void

  /**
   * Fired with the Location of a freshly created session, before the first
   * PATCH; the caller persists it so an interrupted upload can resume.
   */
  onSessionCreated?: (uploadUrl: string) => void

  signal?: AbortSignal

  /**
   * Deadline for the control requests (the offset probe and session create).
   * `<= 0` or omitted disables the deadline.
   */
  requestTimeoutMs?: number

  /**
   * Deadline for each 6 MiB PATCH chunk. `<= 0` or omitted disables the
   * deadline. Kept separate from {@link requestTimeoutMs}: a chunk carrying
   * bytes over a slow link legitimately takes far longer than a control
   * request.
   */
  bytesTimeoutMs?: number

  /**
   * Injectable timer pair (testability): defaults to the platform
   * setTimeout/clearTimeout. Threaded into every deadline this client arms.
   */
  setTimer?: (callback: () => void, delayMs: number) => unknown

  clearTimer?: (handle: unknown) => void
}

export type TTusUploadResult = {
  uploadUrl: string
  bytesUploaded: number
}

/**
 * Per-request signal options shared by `tusHeadOffset` and `tusPatchAll`,
 * built by {@link createRequestSignal}.
 */
interface ITusRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const b64 = (value: string): string => {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(unescape(encodeURIComponent(value)))
  }
  // Node / Bun without DOM btoa
  const buf = (globalThis as { Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } } })
    .Buffer

  if (buf !== undefined) {
    return buf.from(value, 'utf8').toString('base64')
  }
  throw new Error('no base64 encoder available for TUS metadata')
}

/**
 * A failure that carries the HTTP status the host answered, and the catalog
 * code when one names the condition: the queue classifies a refusal by them.
 */
const tusFailure = (message: string, status: number, code?: TTransferErrorCode): Error =>
  Object.assign(new Error(message), code === undefined ? { status } : { status, code })

// MARK: - The status Storage means

/** What a Storage refusal says about itself: the status it means and the name of the error. */
type TStorageRefusal = {
  statusCode: unknown
  code: unknown
  error: unknown
}

/** The fields of a refusal body or error object that name what Storage meant. */
function refusalOf(value: object): TStorageRefusal {
  return {
    statusCode: 'statusCode' in value ? value.statusCode : undefined,
    code: 'code' in value ? value.code : undefined,
    error: 'error' in value ? value.error : undefined,
  }
}

/**
 * The status Supabase Storage means by a refusal answered with `status`.
 * Storage answers most refusals with HTTP 400 and names the status in the
 * body's `statusCode`, so a 400 that carries one means that status. The error
 * names `NoSuchKey` and `InvalidJWT` mean 404 and 401 whatever the numbers say.
 */
function meantStatus(status: number, refusal: TStorageRefusal): number {
  const names = [refusal.code, refusal.error]

  if (names.includes('NoSuchKey')) {
    return 404
  }
  if (names.includes('InvalidJWT')) {
    return 401
  }
  const carried = Number(refusal.statusCode)

  return status === 400 && Number.isInteger(carried) && carried >= 400 && carried < 600 ? carried : status
}

/** The status Storage means by a response it refused with `body`. */
export function storageResponseStatus(status: number, body: string): number {
  let refusal: unknown

  try {
    refusal = JSON.parse(body)
  } catch {
    return status
  }
  return typeof refusal === 'object' && refusal !== null ? meantStatus(status, refusalOf(refusal)) : status
}

/**
 * The status Storage means by an error storage-js reports, which keeps the
 * HTTP status in `status`, the body's `statusCode` in `statusCode`, and the
 * error name in `code`. Undefined when the error carries no numeric status.
 */
export function storageErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error) || typeof error.status !== 'number') {
    return undefined
  }
  return meantStatus(error.status, refusalOf(error))
}

const parseUploadOffset = (header: string | null, context: string): number => {
  if (header === null || header === '') {
    throw new Error(`tus ${context} missing Upload-Offset`)
  }
  const value = Number(header)

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`tus ${context} has a non-numeric Upload-Offset (${header})`)
  }
  return value
}

const encodeMetadata = (meta: Record<string, string>): string =>
  Object.entries(meta)
    .map(([k, v]) => `${k} ${b64(v)}`)
    .join(',')

const authHeaders = (token: string, upsert: boolean): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Tus-Resumable': '1.0.0',
  }

  if (upsert) {
    headers['x-upsert'] = 'true'
  }
  return headers
}

/** What a HEAD on a session URL reports: the bytes it holds and the length it was created with, `null` when it declares none. */
type TSessionProbe = {
  offset: number
  length: number | null
}

/** The HEAD on a session URL, under the control deadline: an offset probe carries no bytes. */
async function sendHead(uploadUrl: string, accessToken: string, requestOptions: ITusRequestOptions): Promise<Response> {
  const { signal: parentSignal, timeoutMs = 0, setTimer, clearTimer } = requestOptions
  const { signal, timedOut, release } = createRequestSignal({ timeoutMs, parentSignal, setTimer, clearTimer })

  try {
    return await fetch(uploadUrl, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Tus-Resumable': '1.0.0',
      },
      signal,
    })
  } catch (error) {
    if (timedOut()) {
      throw createTransferTimeoutError({ operation: 'upload', timeoutMs, detail: 'HEAD offset probe' })
    }
    throw error
  } finally {
    release()
  }
}

/**
 * HEAD a session URL. A 404/410 means the session is gone and any other
 * client error refuses it: both carry `ETransferError.expired`, so the caller
 * drops the session. A server error carries its status only.
 */
async function probeSession(uploadUrl: string, accessToken: string, requestOptions: ITusRequestOptions): Promise<TSessionProbe> {
  const response = await sendHead(uploadUrl, accessToken, requestOptions)

  if (response.status === 404 || response.status === 410) {
    throw tusFailure(`tus upload expired or missing (${response.status})`, response.status, ETransferError.expired)
  }
  if (response.status >= 400 && response.status < 500) {
    throw tusFailure(`tus HEAD refused: ${response.status}`, response.status, ETransferError.expired)
  }
  if (!response.ok) {
    throw tusFailure(`tus HEAD failed: ${response.status}`, response.status)
  }
  const length = Number(response.headers.get('Upload-Length') ?? Number.NaN)

  return {
    offset: parseUploadOffset(response.headers.get('Upload-Offset'), 'HEAD'),
    length: Number.isSafeInteger(length) && length >= 0 ? length : null,
  }
}

/** HEAD upload URL → current offset (resume). */
export const tusHeadOffset = async (
  uploadUrl: string,
  accessToken: string,
  requestOptions: ITusRequestOptions = {},
): Promise<number> => (await probeSession(uploadUrl, accessToken, requestOptions)).offset

/**
 * Create a new TUS upload; returns the Location URL. Control deadline: the
 * create request carries metadata only, no bytes.
 */
const tusCreate = async (
  options: Omit<TTusUploadOptions, 'data' | 'resumeUrl' | 'onProgress' | 'bytesTimeoutMs'> & { size: number },
): Promise<string> => {
  const metadata = encodeMetadata({
    bucketName: options.bucket,
    objectName: options.objectName,
    contentType: options.contentType,
    cacheControl: options.cacheControl ?? '3600',
  })
  const timeoutMs = options.requestTimeoutMs ?? 0
  const { signal, timedOut, release } = createRequestSignal({
    timeoutMs,
    parentSignal: options.signal,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  })
  let response: Response

  try {
    response = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders(options.accessToken, options.upsert !== false),
        'Upload-Length': String(options.size),
        'Upload-Metadata': metadata,
        'Content-Type': 'application/offset+octet-stream',
      },
      signal,
    })
  } catch (error) {
    if (timedOut()) {
      throw createTransferTimeoutError({ operation: 'upload', timeoutMs, detail: 'POST create' })
    }
    throw error
  } finally {
    release()
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')

    throw tusFailure(`tus create failed: ${response.status} ${body}`, storageResponseStatus(response.status, body))
  }
  const location = response.headers.get('Location')

  if (location === null || location === '') {
    throw new Error('tus create missing Location header')
  }
  return resolveTusLocation(options.endpoint, location)
}

/**
 * Resolve a TUS `Location` against the create endpoint and refuse a different
 * origin. Absolute Locations follow the JWT on later PATCH; a cross-origin
 * Location would exfiltrate the user token and file bytes.
 */
export const resolveTusLocation = (endpoint: string, location: string): string => {
  let base: URL
  let resolved: URL

  try {
    base = new URL(endpoint)
    resolved =
      location.startsWith('https://') || location.startsWith('http://')
        ? new URL(location)
        : new URL(location, base.origin)
  } catch {
    throw new Error(`tus create bad Location: ${location}`)
  }
  if (resolved.protocol !== base.protocol || resolved.host !== base.host) {
    throw new Error(
      `tus create Location origin mismatch: ${resolved.origin} is not ${base.origin}`,
    )
  }
  return resolved.href
}

type TTusPatchAllOptions = {
  uploadUrl: string
  accessToken: string
  data: Uint8Array
  startOffset: number
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void
  requestOptions?: ITusRequestOptions
}

/**
 * PATCH successive 6 MiB chunks until complete. Bytes deadline per chunk; a
 * timed-out chunk keeps the session URL (the caller resumes on the next
 * attempt). The 409-conflict offset re-probe reuses the same per-call
 * deadline: it is one more request this call makes, not a fresh one.
 */
export const tusPatchAll = async (options: TTusPatchAllOptions): Promise<number> => {
  const { uploadUrl, accessToken, data, startOffset, onProgress, requestOptions = {} } = options
  const { signal: parentSignal, timeoutMs = 0, setTimer, clearTimer } = requestOptions
  let offset = startOffset
  const total = data.byteLength

  while (offset < total) {
    const response = await patchChunk({
      uploadUrl,
      accessToken,
      data,
      offset,
      deadline: { signal: parentSignal, timeoutMs, setTimer, clearTimer },
    })

    if (response.status === 409) {
      const resumed = await reprobeOffset({ uploadUrl, accessToken, total, deadline: { signal: parentSignal, timeoutMs, setTimer, clearTimer } })

      if (!(resumed > offset)) {
        throw new Error(
          `tus PATCH 409 did not advance offset (stuck at ${offset}, server ${resumed})`,
        )
      }
      offset = resumed
      continue
    }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '')

      throw tusFailure(
        `tus PATCH failed at offset ${offset}: ${response.status} ${errBody}`,
        storageResponseStatus(response.status, errBody),
      )
    }
    const advanced = parseUploadOffset(response.headers.get('Upload-Offset'), 'PATCH')

    if (!(advanced > offset)) {
      throw new Error(`tus PATCH did not advance offset (stuck at ${offset})`)
    }
    offset = advanced
    onProgress?.(offset, total)
  }
  return offset
}

/** A conflict re-probe of the session a PATCH is writing, which holds `total` bytes. */
type TReprobe = {
  uploadUrl: string
  accessToken: string
  total: number
  deadline: ITusRequestOptions
}

/** The server's offset after a 409. A session that declares another length than the object's cannot take its bytes, so it is dropped like an expired one. */
async function reprobeOffset(reprobe: TReprobe): Promise<number> {
  const probe = await probeSession(reprobe.uploadUrl, reprobe.accessToken, reprobe.deadline)

  if (probe.length !== reprobe.total) {
    throw Object.assign(new Error(`tus session declares ${probe.length ?? 'no'} bytes, not ${reprobe.total}`), {
      code: ETransferError.expired,
    })
  }
  return probe.offset
}

/** One PATCH of the chunk that starts at `offset`, with the per-chunk bytes deadline already resolved. */
type TChunkPatch = {
  uploadUrl: string
  accessToken: string
  data: Uint8Array
  offset: number
  deadline: ITusRequestOptions & { timeoutMs: number }
}

async function patchChunk(patch: TChunkPatch): Promise<Response> {
  const { uploadUrl, accessToken, data, offset } = patch
  const { signal: parentSignal, timeoutMs, setTimer, clearTimer } = patch.deadline
  const end = Math.min(offset + TUS_CHUNK_SIZE, data.byteLength)
  const chunk = data.subarray(offset, end)
  // Own the bytes in a fresh Uint8Array so fetch BodyInit is portable (DOM/RN/Node).
  const bodyBytes = new Uint8Array(chunk.byteLength)

  bodyBytes.set(chunk)
  const { signal, timedOut, release } = createRequestSignal({ timeoutMs, parentSignal, setTimer, clearTimer })

  try {
    return await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        ...authHeaders(accessToken, false),
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
        'Content-Length': String(bodyBytes.byteLength),
      },
      // Cast: TS lib.dom BodyInit is stricter than runtime (accepts Uint8Array).
      body: bodyBytes as unknown as BodyInit,
      signal,
    })
  } catch (error) {
    if (timedOut()) {
      throw createTransferTimeoutError({ operation: 'upload', timeoutMs, detail: `PATCH at offset ${offset}` })
    }
    throw error
  } finally {
    release()
  }
}

/**
 * Full upload with optional resume URL. Returns the durable TUS URL (fingerprint).
 */
export const tusUpload = async (options: TTusUploadOptions): Promise<TTusUploadResult> => {
  const size = options.data.byteLength
  const { setTimer, clearTimer, signal: parentSignal } = options
  const control: ITusRequestOptions = {
    signal: parentSignal,
    timeoutMs: options.requestTimeoutMs ?? 0,
    setTimer,
    clearTimer,
  }
  const bytes: ITusRequestOptions = {
    signal: parentSignal,
    timeoutMs: options.bytesTimeoutMs ?? 0,
    setTimer,
    clearTimer,
  }
  const { resumeUrl } = options
  let session: TTusSession | null = null

  if (resumeUrl !== undefined && resumeUrl.length > 0) {
    session = await resumeSession(options, { resumeUrl, control })
  }
  if (session === null) {
    session = await createSession(options, { size, control })
  }
  const bytesUploaded = await tusPatchAll({
    uploadUrl: session.uploadUrl,
    accessToken: options.accessToken,
    data: options.data,
    startOffset: session.offset,
    onProgress: options.onProgress,
    requestOptions: bytes,
  })

  return { uploadUrl: session.uploadUrl, bytesUploaded }
}

/** The session an upload writes into, and the offset its bytes start from. */
type TTusSession = {
  uploadUrl: string
  offset: number
}

/** A session a previous attempt persisted, and the control deadline its offset probe runs under. */
type TTusResume = {
  resumeUrl: string
  control: ITusRequestOptions
}

/**
 * The server's offset for a persisted session, or null when the upload starts
 * over on a fresh session: the URL sits off the endpoint's origin (it is never
 * probed, since the probe would carry the user's token there), the server no
 * longer has it (404/410), or it declares another length than these bytes.
 * Any other probe failure propagates.
 */
async function resumeSession(options: TTusUploadOptions, resume: TTusResume): Promise<TTusSession | null> {
  const uploadUrl = resolveOnEndpointOrigin(options.endpoint, resume.resumeUrl)

  if (uploadUrl === null) {
    return null
  }
  try {
    const probe = await probeSession(uploadUrl, options.accessToken, resume.control)

    return probe.length === options.data.byteLength ? { uploadUrl, offset: probe.offset } : null
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined

    if (status === 404 || status === 410) {
      return null
    }
    throw error
  }
}

/** `resumeUrl` resolved against the endpoint, or null when it does not parse or sits on another origin. */
function resolveOnEndpointOrigin(endpoint: string, resumeUrl: string): string | null {
  try {
    return resolveTusLocation(endpoint, resumeUrl)
  } catch {
    return null
  }
}

/** The byte count and the control deadline a new session is created with. */
type TTusCreate = {
  size: number
  control: ITusRequestOptions
}

/** A fresh session, announced through `onSessionCreated` before the first PATCH. */
async function createSession(options: TTusUploadOptions, create: TTusCreate): Promise<TTusSession> {
  const { control } = create
  const uploadUrl = await tusCreate({
    endpoint: options.endpoint,
    accessToken: options.accessToken,
    bucket: options.bucket,
    objectName: options.objectName,
    contentType: options.contentType,
    size: create.size,
    upsert: options.upsert,
    cacheControl: options.cacheControl,
    signal: control.signal,
    requestTimeoutMs: control.timeoutMs,
    setTimer: control.setTimer,
    clearTimer: control.clearTimer,
  })

  options.onSessionCreated?.(uploadUrl)

  return { uploadUrl, offset: 0 }
}

/** The Supabase Storage resumable-upload endpoint for a project URL, preferring the `<ref>.storage.supabase.co` host on `*.supabase.co`. */
export const tusEndpointFromSupabaseUrl = (supabaseUrl: string): string => {
  const base = supabaseUrl.replace(/\/$/, '')

  try {
    const u = new URL(base)
    const host = u.hostname

    if (host.endsWith('.supabase.co') && !host.includes('.storage.')) {
      const ref = host.replace('.supabase.co', '')

      return `https://${ref}.storage.supabase.co/storage/v1/upload/resumable`
    }
  } catch {
    // fall through
  }
  return `${base}/storage/v1/upload/resumable`
}
