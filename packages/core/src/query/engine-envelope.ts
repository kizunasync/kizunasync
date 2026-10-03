// MARK: - Engine call envelope

/**
 * Parser for the `{ ok: true, value } | { ok: false, error }` envelope every
 * Rust backend answers a call with, and the mapping that turns a failure back
 * into the same typed `TEngineError`s every bridge throws, so an app's `catch`
 * reads identically on every bridge. Every JSON text that crosses the engine
 * boundary is read through the guarded parse here (@../../../../CONVENTIONS.md):
 * text a guard refuses is the engine's own `JSON` failure, the code the kernel
 * answers an unreadable envelope with.
 */

import { EEngineErrorCode, TEngineError, type TEngineErrorCode } from '../wire/types'

// MARK: - Envelope shapes

type TCallError = {
  kind: string
  message: string
  code?: string
  table?: string
  retryable?: boolean
}

type TCallEnvelope = { ok: true; value: unknown } | { ok: false; error: TCallError }

// MARK: - Guarded parse

const UNREADABLE = 'the engine boundary received JSON it cannot read'

/** A JSON object: not `null`, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `raw` as a JSON value; text that is not JSON is the engine's `JSON` failure. */
export function parseEngineJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new TEngineError(EEngineErrorCode.JSON, UNREADABLE)
  }
}

/** `raw` as the shape `isShape` proves; any other text is the engine's `JSON` failure. */
export function readEngineJson<T>(raw: string, isShape: (value: unknown) => value is T): T {
  const parsed = parseEngineJson(raw)

  if (!isShape(parsed)) {
    throw new TEngineError(EEngineErrorCode.JSON, UNREADABLE)
  }
  return parsed
}

/** `field` is absent, or present with the type `typeof` names. */
export function isOptional(field: unknown, type: 'boolean' | 'number' | 'string'): boolean {
  return field === undefined || typeof field === type
}

/** The failure fields `toThrowable` reads. */
function isCallError(value: unknown): value is TCallError {
  return (
    isJsonObject(value) &&
    typeof value.kind === 'string' &&
    typeof value.message === 'string' &&
    isOptional(value.code, 'string') &&
    isOptional(value.table, 'string') &&
    isOptional(value.retryable, 'boolean')
  )
}

function isCallEnvelope(value: unknown): value is TCallEnvelope {
  if (!isJsonObject(value)) {
    return false
  }
  return value.ok === true ? 'value' in value : value.ok === false && isCallError(value.error)
}

// MARK: - Error mapping

const ENGINE_ERROR_CODES = new Set<string>(Object.values(EEngineErrorCode))

/** `code` when the engine error catalog names it, else null. */
export function asEngineErrorCode(code: string | undefined): TEngineErrorCode | null {
  return code !== undefined && ENGINE_ERROR_CODES.has(code) ? (code as TEngineErrorCode) : null
}

/**
 * A transport failure keeps the `retryable` flag the injected remote set. The
 * dead-letter budget in the Rust engine already consumed it, and a caller
 * (`sync-scheduler`, an app's catch) reads the same field on every bridge.
 *
 * It keeps `code` for the same reason: public boundaries expose stable
 * machine-readable codes and consumers never classify by free text. A code
 * that survives the outbound bridge has to survive the return trip.
 * `EngineError::Remote` carries the code the bridge sent and the RPC envelope
 * re-emits it; this restores the adapter's own value. The gated Supabase
 * remote's `AUTH_SESSION_MISSING` / `AUTH_SESSION_TIMEOUT` are the first
 * consumers.
 */
function transportError(error: TCallError): Error {
  const failure = new Error(error.message)

  ;(failure as { retryable?: boolean }).retryable = error.retryable !== false

  if (typeof error.code === 'string') {
    ;(failure as { code?: string }).code = error.code
  }
  return failure
}

/** The typed error for the catalog code a failure carries, or a bare `Error` when it carries none. */
function catalogError(error: TCallError): Error {
  const code = asEngineErrorCode(error.code)

  return code === null ? new Error(error.message) : new TEngineError(code, error.message)
}

export function toThrowable(error: TCallError): Error {
  switch (error.kind) {
    case 'protocol':
      return catalogError(error)
    case 'remote':
      return transportError(error)
    case 'constraint':
      return new TEngineError(EEngineErrorCode.LOCAL_CONSTRAINT, error.message)
    case 'unknown_table':
      return new TEngineError(EEngineErrorCode.UNKNOWN_TABLE, error.message, {
        table: error.table,
      })
    case 'bucket_unset':
      return new TEngineError(EEngineErrorCode.BUCKET_UNSET, error.message)
    // The wasm bridge answers a call made before create() with this kind, so the code has to survive the return trip: a caller may only classify on the code, never on the message text.
    case 'engine_unavailable':
      return new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, error.message)
    // The two ways a browser store refuses to open, kept apart because the answers differ: a pool another context holds is released eventually and the same open retried later can succeed, while a browser with no persistent VFS at all will refuse every retry.
    case 'store_busy':
      return new TEngineError(EEngineErrorCode.STORE_BUSY, error.message)
    case 'store_unavailable':
      return new TEngineError(EEngineErrorCode.STORE_UNAVAILABLE, error.message)
    case 'soft_delete_violation':
      return new TEngineError(EEngineErrorCode.SOFT_DELETE_VIOLATION, error.message, {
        table: error.table,
      })
    // The default branch types by catalog code, which is how the kinds with no case of their own arrive: `query` (a refused plan or filter-targeted write), `config` (a refused configuration) and the `internal` catch-all a store or transfer fault carries. Without it an app would receive a bare `Error` it could only classify by message text. A kind with no catalog code (`unknown_method`, a bridge bug) still falls through to one.
    default:
      return catalogError(error)
  }
}

// MARK: - Parser

/**
 * The typed failure a `{ ok: false, error }` envelope describes, or `null` when
 * `raw` is not that shape or describes a failure with no catalog code (a remote
 * fault carries the adapter's transport code, which is a different vocabulary).
 *
 * `@kizunasync/web`'s worker driver is the second caller: a failure that crossed a
 * `postMessage` as text has to become the same error a direct caller sees, and
 * one parser for one wire shape is what keeps the two from drifting apart.
 */
export function parseFailureEnvelope(raw: string): TEngineError | null {
  let envelope: TCallEnvelope

  try {
    envelope = readEngineJson(raw, isCallEnvelope)
  } catch {
    return null
  }
  if (envelope.ok) {
    return null
  }
  const failure = toThrowable(envelope.error)

  return failure instanceof TEngineError ? failure : null
}

/** The envelope's `value`, or the typed failure its `error` maps to; text that is no envelope is the `JSON` failure. */
export function parseCallEnvelope(raw: string): unknown {
  const envelope = readEngineJson(raw, isCallEnvelope)

  if (!envelope.ok) {
    throw toThrowable(envelope.error)
  }
  return envelope.value
}
