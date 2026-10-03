// MARK: - Remote bridge

/**
 * Where a Rust engine's outbound RPC becomes a call on the injected
 * `IProtocolRemote`. Every backend (NAPI, UniFFI, wasm) opens an engine with
 * the `(requestJson) => Promise<string>` callbacks this builds.
 *
 * The request is proven to be the wire request, then passed through untouched.
 * The Rust request structs are the wire shape: `last_mutation_id` is always
 * present, `client_id` rides whenever the engine holds one (D-client-identity),
 * and `limit` rides only when the config set one. Reshaping the bytes here would
 * hide later drift; the byte-exact conformance lane is what proves the shape.
 * The remaining job is wrapping the remote's answer into the envelope Rust
 * parses.
 */

import { isJsonObject, isOptional, readEngineJson } from './engine-envelope'
import { EOp, type TPullRequest, type TPushRequest } from '../wire/types'

/**
 * The bridge NEVER rejects. A rejected promise would cross the FFI as an
 * opaque string and lose `retryable`, the bit that decides whether a queued
 * write is retried forever or dropped by the dead-letter budget.
 *
 * A string `code` rides along for the same reason `transportError` restores
 * it: the remote's stable codes are the only thing a caller may classify on,
 * and the bridge must not drop them. The Rust envelope parser reads it into
 * `EngineError::Remote`. When the failure carried no code, the key is omitted
 * (not sent as null) so that field stays `None`. A request `isRequest` refuses
 * never reaches the remote: it is answered with the engine's `JSON` failure.
 */
export function bridgeRemote<TRequest>(
  call: (request: TRequest) => Promise<unknown>,
  isRequest: (value: unknown) => value is TRequest,
): (requestJson: string) => Promise<string> {
  return async (requestJson: string): Promise<string> => {
    try {
      const data = await call(readEngineJson(requestJson, isRequest))

      return JSON.stringify({ ok: true, data })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isObject = typeof error === 'object' && error !== null
      const retryable = isObject ? (error as { retryable?: unknown }).retryable !== false : true
      const code = isObject ? (error as { code?: unknown }).code : undefined

      return JSON.stringify(
        typeof code === 'string'
          ? { ok: false, message, retryable, code }
          : { ok: false, message, retryable },
      )
    }
  }
}

// MARK: - Request guards

const OPS = new Set<unknown>(Object.values(EOp))

function isBucket(value: unknown): boolean {
  return isJsonObject(value) && typeof value.table === 'string' && isJsonObject(value.params)
}

function isMutation(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    typeof value.mutation_id === 'string' &&
    typeof value.table === 'string' &&
    typeof value.pk === 'string' &&
    OPS.has(value.op) &&
    isJsonObject(value.columns)
  )
}

/** The required fields of a pull request and the optional ones a remote reads. */
export function isPullRequest(value: unknown): value is TPullRequest {
  return (
    isJsonObject(value) &&
    Array.isArray(value.buckets) &&
    value.buckets.every(isBucket) &&
    typeof value.cursor === 'string' &&
    typeof value.schema_version === 'number' &&
    isOptional(value.limit, 'number') &&
    isOptional(value.client_id, 'string')
  )
}

function isBatch(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    typeof value.atomic === 'boolean' &&
    Array.isArray(value.mutations) &&
    value.mutations.every(isMutation)
  )
}

/** The required fields of a push request and the optional one a remote reads. */
export function isPushRequest(value: unknown): value is TPushRequest {
  return (
    isJsonObject(value) &&
    isBatch(value.batch) &&
    (value.last_mutation_id === null || typeof value.last_mutation_id === 'string') &&
    typeof value.schema_version === 'number' &&
    isOptional(value.client_id, 'string')
  )
}
