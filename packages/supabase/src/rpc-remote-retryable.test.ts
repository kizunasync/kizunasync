// MARK: - createRpcRemote error classification

/**
 * The engine's dead-letter budget only drops a write the remote marks PERMANENT
 * (retryable:false). rpc-remote marks a Postgres data/constraint/syntax fault
 * (SQLSTATE class 22/23/42) permanent, plus exact code P0001 (Postgres's
 * default for an un-coded `raise exception` in a user trigger: still a
 * definitive rejection) and exact code 0A000 (the pack's own rejection of a
 * non-conforming client mutation: missing HLC, or an unknown table).
 * Everything else (network, auth, 5xx, schema-config, other P0xxx codes)
 * is retryable; the write is never dropped over a recoverable condition.
 */

import { describe, expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRpcRemote } from './rpc-remote'
import type { TPullRequest, TPushRequest } from '@kizunasync/core'

/**
 * The adapter arms a per-request deadline, so the fake must answer the same
 * awaitable-and-chainable builder supabase-js returns from .rpc().
 */
const answering = (result: { data: unknown; error: unknown }) => {
  const settled = Promise.resolve(result)

  return {
    abortSignal: () => settled,
    then: settled.then.bind(settled),
  }
}

const clientWith = (error: { message: string; code?: string }): SupabaseClient =>
  ({
    schema: () => ({ rpc: () => answering({ data: null, error }) }),
  }) as unknown as SupabaseClient

const REQ: TPushRequest = { batch: { atomic: false, mutations: [] }, last_mutation_id: null, schema_version: 1 }

const pushFailure = async (error: { message: string; code?: string }): Promise<unknown> => {
  try {
    await createRpcRemote(clientWith(error)).push(REQ)

    throw new Error('push should have thrown')
  } catch (e) {
    return e
  }
}

const pushRetryable = async (error: { message: string; code?: string }): Promise<boolean | undefined> =>
  (await pushFailure(error) as { retryable?: boolean }).retryable

const PULL_REQ: TPullRequest = { buckets: [{ params: {}, table: 'todos' }], cursor: '0', schema_version: 1 }

const pullFailure = async (error: { message: string; code?: string }): Promise<unknown> => {
  try {
    await createRpcRemote(clientWith(error)).pull(PULL_REQ)

    throw new Error('pull should have thrown')
  } catch (e) {
    return e
  }
}

describe('rpc-remote error classification', () => {
  test('a constraint violation (SQLSTATE 23xxx) is permanent', async () => {
    expect(await pushRetryable({ message: 'duplicate key', code: '23505' })).toBe(false)
  })

  test('a data exception (SQLSTATE 22xxx) is permanent', async () => {
    expect(await pushRetryable({ message: 'invalid input', code: '22P02' })).toBe(false)
  })

  test('an un-coded trigger raise (SQLSTATE P0001) is permanent', async () => {
    expect(await pushRetryable({ message: 'demo cap exceeded', code: 'P0001' })).toBe(false)
  })

  test('a non-conforming client mutation (SQLSTATE 0A000) is permanent', async () => {
    expect(await pushRetryable({ message: 'kizunasync: mutation has no hlc', code: '0A000' })).toBe(false)
  })

  test('a named PL/pgSQL condition (SQLSTATE P0002) is retryable', async () => {
    expect(await pushRetryable({ message: 'named condition', code: 'P0002' })).toBe(true)
  })

  test('a network/unknown error (no code) is retryable', async () => {
    expect(await pushRetryable({ message: 'fetch failed' })).toBe(true)
  })

  test('an expired JWT (PGRST301) is retryable', async () => {
    expect(await pushRetryable({ message: 'JWT expired', code: 'PGRST301' })).toBe(true)
  })

  test('insufficient_privilege (SQLSTATE 42501) is retryable', async () => {
    expect(await pushRetryable({ message: 'permission denied for function pull', code: '42501' })).toBe(
      true,
    )
  })

  test('HTTP 401 whose body also carries 42501 stays retryable', async () => {
    expect(await pushRetryable({ message: 'JWT expired', code: '42501' })).toBe(true)
  })

  test('a syntax error (SQLSTATE 42601) is still permanent', async () => {
    expect(await pushRetryable({ message: 'syntax error', code: '42601' })).toBe(false)
  })

  test('an undefined table (SQLSTATE 42P01) is still permanent', async () => {
    expect(await pushRetryable({ message: 'relation does not exist', code: '42P01' })).toBe(false)
  })

  test('a schema-not-exposed config error (PGRST106) is retryable', async () => {
    expect(await pushRetryable({ message: 'schema not found', code: 'PGRST106' })).toBe(true)
  })

  test('a pull-only push rejection (KZP01) is permanent', async () => {
    expect(await pushRetryable({ message: 'table is pull-only', code: 'KZP01' })).toBe(false)
  })

  test('an oversized batch rejection (KZP02) is permanent', async () => {
    expect(await pushRetryable({ message: 'batch exceeds max_batch_size', code: 'KZP02' })).toBe(false)
  })

  test('a require_atomic rejection (KZP03) is retryable', async () => {
    expect(await pushRetryable({ message: 'non-atomic push rejected', code: 'KZP03' })).toBe(true)
  })

  test('an unscoped pull of a bucketed table (KZL01) is permanent and keeps its SQLSTATE', async () => {
    const message =
      'kizunasync.pull(): table "todos" is bucketed on "user_id": the pull bucket must name that column'
    const failure = await pullFailure({ message, code: 'KZL01' })

    expect((failure as { retryable?: boolean }).retryable).toBe(false)
    expect((failure as { code?: string }).code).toBe('KZL01')
    expect((failure as Error).message).toBe(`kizunasync.pull failed: ${message}`)
  })

  test('the SQLSTATE rides on the failure, so the engine envelope keeps it', async () => {
    const failure = await pushFailure({ message: 'table is pull-only', code: 'KZP01' })

    expect((failure as { code?: string }).code).toBe('KZP01')
    expect((failure as Error).message).toBe('kizunasync.push failed: table is pull-only')
  })
})
