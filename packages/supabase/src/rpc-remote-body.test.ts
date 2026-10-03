/// <reference types="bun" />
// MARK: - createRpcRemote body arguments

/**
 * The adapter names the SQL arguments one by one rather than spreading the
 * request, so every key the wire gained has to be added here too. A key the
 * request leaves unset stays `undefined`, which supabase-js omits from the body,
 * so the SQL default applies instead of an explicit null.
 */

import { describe, expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TPullRequest, TPushRequest } from '@kizunasync/core'
import { createRpcRemote } from './rpc-remote'

/** UUID placeholder grammar, kind code c1. */
const CLIENT_ID = '00000000-0000-4000-8000-c10000000001'

const EMPTY_PULL = { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }

const PULL: TPullRequest = { buckets: [], cursor: '0', schema_version: 1 }
const PUSH: TPushRequest = {
  batch: { atomic: false, mutations: [] },
  last_mutation_id: null,
  schema_version: 1,
}

interface IRecordingClient {
  client: SupabaseClient
  bodies: Record<string, unknown>[]
}

/**
 * The adapter arms a per-request deadline, so the fake answers the same
 * awaitable-and-chainable builder supabase-js returns from .rpc().
 */
const recordingClient = (): IRecordingClient => {
  const bodies: Record<string, unknown>[] = []
  const client = {
    schema: () => ({
      rpc: (fn: string, args: Record<string, unknown>) => {
        bodies.push(args)
        const settled = Promise.resolve({
          data: fn === 'pull' ? EMPTY_PULL : { verdicts: [] },
          error: null,
        })

        return { abortSignal: () => settled, then: settled.then.bind(settled) }
      },
    }),
  } as unknown as SupabaseClient

  return { client, bodies }
}

/**
 * supabase-js drops an undefined argument when it serializes the body, so the
 * keys that survive are what PostgREST resolves the overload from.
 */
const sent = (body: Record<string, unknown>): string[] =>
  Object.keys(body)
    .filter((key) => body[key] !== undefined)
    .sort()

describe('the RPC body carries the SQL argument names', () => {
  test('pull sends client_id when the engine holds one', async () => {
    const { client, bodies } = recordingClient()

    await createRpcRemote(client).pull({ ...PULL, client_id: CLIENT_ID })
    expect(bodies[0]?.client_id).toBe(CLIENT_ID)
    expect(sent(bodies[0] ?? {})).toEqual(['buckets', 'client_id', 'cursor', 'schema_version'])
  })

  test('push sends client_id when the engine holds one', async () => {
    const { client, bodies } = recordingClient()

    await createRpcRemote(client).push({ ...PUSH, client_id: CLIENT_ID })
    expect(bodies[0]?.client_id).toBe(CLIENT_ID)
    expect(sent(bodies[0] ?? {})).toEqual([
      'batch',
      'client_id',
      'last_mutation_id',
      'schema_version',
    ])
  })

  test('an absent client_id leaves the key out of both bodies', async () => {
    const { client, bodies } = recordingClient()
    const remote = createRpcRemote(client)

    await remote.pull(PULL)
    await remote.push(PUSH)
    expect(sent(bodies[0] ?? {})).toEqual(['buckets', 'cursor', 'schema_version'])
    expect(sent(bodies[1] ?? {})).toEqual(['batch', 'last_mutation_id', 'schema_version'])
  })
})
