import type { SupabaseClient } from '@supabase/supabase-js'
import type { IProtocolRemote, TColumnValues, TPullRequest, TPullResponse, TPushRequest, TPushResponse } from '@kizunasync/core'
import { SCHEMA } from '@kizunasync/core/constants'

// MARK: - Kizuna RPC remote

/**
 * Thin adapter for the REAL wire protocol: the fenced kizunasync.pull /
 * kizunasync.push RPCs the SQL pack installs (migration 0001, schema
 * `kizunasync`). Forwards the engine's request envelope to the server, which
 * answers the whole fenced transaction.
 *
 * Wire request shapes already mirror the SQL argument names 1:1
 * (TPullRequest → pull(buckets, cursor, schema_version, limit, client_id);
 * TPushRequest → push(batch, last_mutation_id, schema_version, client_id)).
 * Bodies pass through unchanged. An argument the request leaves unset is
 * undefined here; supabase-js omits it from the body, and the SQL default
 * applies. supabase-js targets the non-public schema via .schema('kizunasync');
 * the demos use an untyped client so the call site stays generic.
 */

/**
 * Hard per-request deadline. Matches the scheduler's MAX_BACKOFF_MS ceiling, so
 * a wedged socket costs at most one retry window instead of parking the
 * in-flight slot forever.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export interface IRpcRemoteOptions {
  /**
   * Device-only columns the server has no slot for (e.g. local_image_uri).
   * Stripped from every mutation's columns before push: the server's
   * _apply_upsert would fail on an unknown column. Pull is unaffected: server
   * rows never carry local-only columns.
   */
  localOnlyColumns?: readonly string[]

  /**
   * Milliseconds a single pull/push may take before the request is aborted and
   * the attempt fails retryably. `0` disables the deadline (tests that drive a
   * request by hand). Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  requestTimeoutMs?: number
}

type TRpcResult = { data: unknown; error: { message: string; code?: string } | null }

/**
 * The slice of the supabase-js `.rpc()` builder this adapter drives: awaitable
 * on its own, and chainable with `.abortSignal()` to bind the underlying fetch
 * to an AbortController.
 */
type TRpcBuilder = PromiseLike<TRpcResult> & { abortSignal: (signal: AbortSignal) => PromiseLike<TRpcResult> }

/**
 * Tag an RPC failure retryable/permanent so the engine's dead-letter budget only
 * drops a write the server DEFINITIVELY rejects. Permanent (retryable:false) =
 * a Postgres data/constraint/syntax fault (SQLSTATE class 22/23/42) surfaced by
 * the RPC, or exact code P0001: an un-coded `raise exception` in a user trigger
 * is Postgres's own default and still a definitive server rejection; it must
 * dead-letter, not retry forever. Exact code 0A000 is the same: the pack
 * raises it for a non-conforming client (a mutation missing its HLC, or a table
 * with no sync config). A replay can only fail again on that exact code, not
 * on the whole 0A class. Other P0xxx codes (e.g. P0002, a named PL/pgSQL condition)
 * stay retryable: only the bare default is treated as permanent. The pack's own
 * push-policy codes KZP01 (a mutation against a pull-only table) and KZP02 (a
 * batch over max_batch_size) are definitive rejections of the request as sent;
 * they dead-letter too. KZP03 (require_atomic) stays retryable: ordinary writes
 * are non-atomic, so a permanent KZP03 would empty the outbox. KZL01 is the
 * pull-policy code for a bucketed table pulled without its bucket column,
 * definitive because a replay of the same request fails the same way.
 * SQLSTATE 42501
 * (insufficient_privilege) is carved out of class 42: on pull/push the pack
 * turns row RLS into a 200 `RLS_DENIED` verdict. An HTTP 42501 is GRANT
 * EXECUTE / role `anon` / a missing JWT, environmental, not a row refusal.
 * Everything else (network loss, 5xx, an expired JWT, a schema-not-exposed
 * config error) is transient/environmental and must keep the write queued;
 * it stays retryable.
 */
const POLICY_CODES: readonly string[] = ['KZP01', 'KZP02', 'KZL01']

function remoteError(prefix: string, error: { message: string; code?: string }): Error {
  const err = new Error(`${prefix}: ${error.message}`)
  const code = error.code ?? ''
  const classPermanent = code !== '42501' && /^(?:22|23|42)/.test(code)
  const permanent =
    classPermanent || code === 'P0001' || code === '0A000' || POLICY_CODES.includes(code)

  ;(err as { retryable?: boolean }).retryable = !permanent
  ;(err as { code?: string }).code = error.code

  return err
}

/**
 * A blown deadline is a transport failure, not a rejected write: it carries no
 * SQLSTATE, so it takes the same retryable path as a dropped connection and the
 * batch stays queued for the next attempt.
 */
function deadlineError(prefix: string, timeoutMs: number): Error {
  return remoteError(prefix, { message: `request timed out after ${timeoutMs}ms` })
}

function unwrap(prefix: string, result: TRpcResult): unknown {
  if (result.error !== null) {
    throw remoteError(prefix, result.error)
  }
  return result.data
}

export function createRpcRemote(client: SupabaseClient, options: IRpcRemoteOptions = {}): IProtocolRemote {
  const localOnly = new Set(options.localOnlyColumns ?? [])

  const stripLocalColumns = (columns: TColumnValues): TColumnValues => {
    if (localOnly.size === 0) {
      return columns
    }
    const out: TColumnValues = {}

    for (const [key, value] of Object.entries(columns)) {
      if (!localOnly.has(key)) {
        out[key] = value
      }
    }
    return out
  }

  // The untyped demo client cannot prove 'kizunasync' is a known schema at compile time; the cast keeps the call generic while still going through the real .schema(...).rpc(...) path supabase-js exposes.
  const kizunasync = (client as SupabaseClient).schema(SCHEMA as never)

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  // Runs one RPC under a hard deadline. supabase-js has no timeout of its own, so without the AbortController a half-open socket keeps the scheduler's in-flight slot until the OS gives up. AbortController + setTimeout rather than AbortSignal.timeout: React Native/Hermes lacks the latter.
  const callRpc = async (prefix: string, build: () => TRpcBuilder): Promise<unknown> => {
    if (timeoutMs <= 0) {
      return unwrap(prefix, await build())
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      return unwrap(prefix, await build().abortSignal(controller.signal))
    } catch (cause) {
      // An abort surfaces either as a rejection or as a PostgREST error object, depending on the fetch implementation; the signal settles both.
      throw controller.signal.aborted ? deadlineError(prefix, timeoutMs) : cause
    } finally {
      clearTimeout(timer)
    }
  }

  const pull = async (request: TPullRequest): Promise<TPullResponse> => {
    const data = await callRpc('kizunasync.pull failed', () =>
      kizunasync.rpc('pull', {
        buckets: request.buckets,
        cursor: request.cursor,
        schema_version: request.schema_version,
        limit: request.limit,
        client_id: request.client_id,
      }),
    )

    return data as TPullResponse
  }

  const push = async (request: TPushRequest): Promise<TPushResponse> => {
    const batch = {
      ...request.batch,
      mutations: request.batch.mutations.map((mutation) => ({
        ...mutation,
        columns: stripLocalColumns(mutation.columns),
      })),
    }
    const data = await callRpc('kizunasync.push failed', () =>
      kizunasync.rpc('push', {
        batch,
        last_mutation_id: request.last_mutation_id,
        schema_version: request.schema_version,
        client_id: request.client_id,
      }),
    )

    return data as TPushResponse
  }

  return { pull, push }
}
