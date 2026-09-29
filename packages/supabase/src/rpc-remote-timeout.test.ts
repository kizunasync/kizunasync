// MARK: - createRpcRemote per-request deadline

/**
 * supabase-js issues a bare fetch with no timeout of its own, so a half-open
 * socket can hang forever and hold the scheduler's single in-flight slot:
 * the loop only rearms once an attempt SETTLES. The adapter therefore binds every
 * pull/push to an AbortController armed with a hard deadline, and reports a blown
 * deadline down the same retryable path as any other transport failure, so the
 * batch stays queued.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TPullRequest, TPushRequest } from '@kizunasync/core'
import { createRpcRemote, DEFAULT_REQUEST_TIMEOUT_MS } from './rpc-remote'

type TRpcResult = { data: unknown; error: { message: string; code?: string } | null }

const PULL: TPullRequest = { buckets: [], cursor: '0', schema_version: 1 }
const PUSH: TPushRequest = { batch: { atomic: false, mutations: [] }, last_mutation_id: null, schema_version: 1 }

const EMPTY_PULL: TRpcResult = {
  data: { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] },
  error: null,
}

// MARK: - Fake supabase-js

interface ISpyClient {
  client: SupabaseClient

  /**
   * One entry per issued RPC: the signal it was bound to, or null when the
   * adapter awaited the builder without chaining .abortSignal().
   */
  signals: (AbortSignal | null)[]
}

/**
 * Answers the awaitable-and-chainable builder supabase-js returns from .rpc(),
 * recording how the request was issued. `settle` decides when (and how) the
 * request completes; a test can hang a request until its deadline blows.
 */
const spyClient = (settle: (signal: AbortSignal | null) => PromiseLike<TRpcResult>): ISpyClient => {
  const signals: (AbortSignal | null)[] = []
  const client = {
    schema: () => ({
      rpc: () => ({
        abortSignal: (signal: AbortSignal) => {
          signals.push(signal)

          return settle(signal)
        },
        then: (onFulfilled?: (value: TRpcResult) => unknown, onRejected?: (reason: unknown) => unknown) => {
          signals.push(null)

          return Promise.resolve(settle(null)).then(onFulfilled, onRejected)
        },
      }),
    }),
  } as unknown as SupabaseClient

  return { client, signals }
}

/**
 * Never answers on its own; only the abort ends the request, exactly as a
 * fetch on a dead socket does.
 */
const hangUntilAborted = (signal: AbortSignal | null): Promise<TRpcResult> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new Error('The operation was aborted.'))
    })
  })

/**
 * The other shape an abort can take: PostgREST swallows the fetch rejection and
 * answers a codeless error object instead.
 */
const failWhenAborted = (signal: AbortSignal | null): Promise<TRpcResult> =>
  new Promise((resolve) => {
    signal?.addEventListener('abort', () => {
      resolve({ data: null, error: { message: 'FetchError: The operation was aborted.', code: '' } })
    })
  })

const answer = (result: TRpcResult) => (): Promise<TRpcResult> => Promise.resolve(result)

const caught = async (run: () => Promise<unknown>): Promise<Error & { retryable?: boolean }> => {
  try {
    await run()
  } catch (cause) {
    return cause as Error & { retryable?: boolean }
  }
  throw new Error('the request should have failed')
}

/**
 * Delays of timers armed while the body ran: the real setTimeout still runs,
 * so the deadline it schedules is the one under test.
 */
const timerDelays = async (run: () => Promise<unknown>): Promise<unknown[]> => {
  const armed = spyOn(globalThis, 'setTimeout')

  try {
    await run()

    // mockRestore() also resets the recording, so read it while the spy lives.
    return armed.mock.calls.map((call) => call[1])
  } finally {
    armed.mockRestore()
  }
}

// MARK: - Tests

describe('rpc-remote request deadline', () => {
  test('pull binds the request to an abort signal', async () => {
    const supabase = spyClient(answer(EMPTY_PULL))

    await createRpcRemote(supabase.client).pull(PULL)
    expect(supabase.signals).toHaveLength(1)
    expect(supabase.signals[0]).toBeInstanceOf(AbortSignal)
    expect(supabase.signals[0]?.aborted).toBe(false)
  })

  test('push binds the request to an abort signal', async () => {
    const supabase = spyClient(answer({ data: { verdicts: [] }, error: null }))

    await createRpcRemote(supabase.client).push(PUSH)
    expect(supabase.signals[0]).toBeInstanceOf(AbortSignal)
  })

  test('every request gets its own controller', async () => {
    const supabase = spyClient(answer(EMPTY_PULL))
    const remote = createRpcRemote(supabase.client)

    await remote.pull(PULL)
    await remote.pull(PULL)
    expect(supabase.signals[0]).not.toBe(supabase.signals[1])
  })

  test('a request that never answers is aborted at the deadline and fails retryably', async () => {
    const supabase = spyClient(hangUntilAborted)
    const remote = createRpcRemote(supabase.client, { requestTimeoutMs: 5 })
    const error = await caught(() => remote.pull(PULL))

    expect(error.retryable).toBe(true)
    expect(error.message).toBe('kizunasync.pull failed: request timed out after 5ms')
    expect(supabase.signals[0]?.aborted).toBe(true)
  })

  test('a push that blows its deadline stays retryable, so the batch is never dead-lettered', async () => {
    const supabase = spyClient(hangUntilAborted)
    const error = await caught(() => createRpcRemote(supabase.client, { requestTimeoutMs: 5 }).push(PUSH))

    expect(error.retryable).toBe(true)
    expect(error.message).toBe('kizunasync.push failed: request timed out after 5ms')
  })

  test('an abort reported as a PostgREST error object is still a deadline', async () => {
    const supabase = spyClient(failWhenAborted)
    const error = await caught(() => createRpcRemote(supabase.client, { requestTimeoutMs: 5 }).pull(PULL))

    expect(error.retryable).toBe(true)
    expect(error.message).toBe('kizunasync.pull failed: request timed out after 5ms')
  })

  test('a server error that is not a deadline keeps its own classification', async () => {
    const supabase = spyClient(answer({ data: null, error: { message: 'duplicate key', code: '23505' } }))
    const error = await caught(() => createRpcRemote(supabase.client, { requestTimeoutMs: 5 }).push(PUSH))

    expect(error.retryable).toBe(false)
    expect(error.message).toBe('kizunasync.push failed: duplicate key')
  })

  test('the default deadline is the scheduler backoff ceiling', async () => {
    const supabase = spyClient(answer(EMPTY_PULL))
    const delays = await timerDelays(() => createRpcRemote(supabase.client).pull(PULL))

    expect(delays).toContain(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  test('a custom requestTimeoutMs arms the timer with exactly that delay', async () => {
    const supabase = spyClient(answer(EMPTY_PULL))
    const delays = await timerDelays(() => createRpcRemote(supabase.client, { requestTimeoutMs: 250 }).pull(PULL))

    expect(delays).toContain(250)
    expect(delays).not.toContain(DEFAULT_REQUEST_TIMEOUT_MS)
  })

  test('requestTimeoutMs 0 arms no timer and attaches no signal', async () => {
    const supabase = spyClient(answer(EMPTY_PULL))
    const delays = await timerDelays(() => createRpcRemote(supabase.client, { requestTimeoutMs: 0 }).pull(PULL))

    expect(delays).toEqual([])
    expect(supabase.signals).toEqual([null])
  })

  test('requestTimeoutMs 0 still classifies a server error', async () => {
    const supabase = spyClient(answer({ data: null, error: { message: 'JWT expired', code: 'PGRST301' } }))
    const error = await caught(() => createRpcRemote(supabase.client, { requestTimeoutMs: 0 }).pull(PULL))

    expect(error.retryable).toBe(true)
    expect(error.message).toBe('kizunasync.pull failed: JWT expired')
  })

  test('the deadline timer is cleared once the request settles', async () => {
    const supabase = spyClient(answer(EMPTY_PULL))
    const cleared = spyOn(globalThis, 'clearTimeout')

    try {
      await createRpcRemote(supabase.client).pull(PULL)
      expect(cleared).toHaveBeenCalled()
    } finally {
      cleared.mockRestore()
    }
  })

  test('the deadline timer is cleared when the request fails', async () => {
    const supabase = spyClient(answer({ data: null, error: { message: 'boom' } }))
    const cleared = spyOn(globalThis, 'clearTimeout')

    try {
      await caught(() => createRpcRemote(supabase.client).pull(PULL))
      expect(cleared).toHaveBeenCalled()
    } finally {
      cleared.mockRestore()
    }
  })
})
