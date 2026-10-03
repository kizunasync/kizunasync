/// <reference types="bun" />
/**
 * The outbound RPC boundary: the request text the engine hands the host remote
 * is proven to be the wire request before the remote sees it, and a request
 * that is not one is answered with the engine's `JSON` failure instead of
 * reaching the remote at all.
 */

import { describe, expect, test } from 'bun:test'
import { bridgeRemote, isPullRequest, isPushRequest } from './remote-bridge'
import { EEngineErrorCode, type TPullRequest, type TPushRequest } from '../wire/types'

const PULL: TPullRequest = {
  buckets: [{ table: 'todos', params: { user_id: 'u1' } }],
  cursor: '0',
  schema_version: 1,
  client_id: 'c1',
}

const PUSH: TPushRequest = {
  batch: {
    atomic: false,
    mutations: [{ mutation_id: 'm1', table: 'todos', pk: 'p1', op: 'insert', columns: { title: 'a' } }],
  },
  last_mutation_id: null,
  schema_version: 1,
}

/** Text the engine never sends: not JSON, and JSON that is no request. */
const MALFORMED: string[] = ['null', '{}', '{"ok":false}', 'not json']

type TRecordingCall<TRequest> = {
  call: (request: TRequest) => Promise<unknown>
  received: TRequest[]
}

const recordingCall = <TRequest>(answer: unknown): TRecordingCall<TRequest> => {
  const received: TRequest[] = []

  return {
    call: async (request) => {
      received.push(request)

      return answer
    },
    received,
  }
}

const JSON_REFUSAL = { ok: false, retryable: false, code: EEngineErrorCode.JSON }

describe('bridgeRemote: the request boundary', () => {
  test.each(MALFORMED)('a pull request of %p never reaches the remote and answers the JSON failure', async (raw) => {
    const remote = recordingCall<TPullRequest>({})
    const answer = JSON.parse(await bridgeRemote(remote.call, isPullRequest)(raw)) as Record<string, unknown>

    expect(answer).toMatchObject(JSON_REFUSAL)
    expect(typeof answer.message).toBe('string')
    expect(remote.received).toEqual([])
  })

  test.each(MALFORMED)('a push request of %p never reaches the remote and answers the JSON failure', async (raw) => {
    const remote = recordingCall<TPushRequest>({})
    const answer = JSON.parse(await bridgeRemote(remote.call, isPushRequest)(raw)) as Record<string, unknown>

    expect(answer).toMatchObject(JSON_REFUSAL)
    expect(remote.received).toEqual([])
  })

  test('a pull request reaches the remote as sent and its answer rides as data', async () => {
    const remote = recordingCall<TPullRequest>({ cursor: '1' })
    const answer = await bridgeRemote(remote.call, isPullRequest)(JSON.stringify(PULL))

    expect(remote.received).toEqual([PULL])
    expect(JSON.parse(answer)).toEqual({ ok: true, data: { cursor: '1' } })
  })

  test('a push request reaches the remote as sent and its answer rides as data', async () => {
    const remote = recordingCall<TPushRequest>({ verdicts: [] })
    const answer = await bridgeRemote(remote.call, isPushRequest)(JSON.stringify(PUSH))

    expect(remote.received).toEqual([PUSH])
    expect(JSON.parse(answer)).toEqual({ ok: true, data: { verdicts: [] } })
  })
})

describe('the wire request guards', () => {
  test('a pull request carries its buckets, cursor and schema version, and an optional limit and client id', () => {
    expect(isPullRequest(PULL)).toBe(true)
    expect(isPullRequest({ ...PULL, limit: 50 })).toBe(true)
    expect(isPullRequest({ buckets: [] })).toBe(false)
    expect(isPullRequest({ ...PULL, buckets: [null] })).toBe(false)
    expect(isPullRequest({ ...PULL, buckets: [{ table: 'todos', params: null }] })).toBe(false)
    expect(isPullRequest({ ...PULL, cursor: 0 })).toBe(false)
    expect(isPullRequest({ ...PULL, schema_version: '1' })).toBe(false)
    expect(isPullRequest({ ...PULL, limit: '50' })).toBe(false)
    expect(isPullRequest({ ...PULL, client_id: null })).toBe(false)
  })

  test('a push request carries its batch, last mutation id and schema version, and an optional client id', () => {
    expect(isPushRequest(PUSH)).toBe(true)
    expect(isPushRequest({ ...PUSH, last_mutation_id: 'm0', client_id: 'c1' })).toBe(true)
    expect(isPushRequest({ ...PUSH, batch: { mutations: [] } })).toBe(false)
    expect(isPushRequest({ ...PUSH, batch: { atomic: false, mutations: [{ mutation_id: 'm1' }] } })).toBe(false)
    expect(isPushRequest({ ...PUSH, last_mutation_id: undefined })).toBe(false)
    expect(isPushRequest({ ...PUSH, schema_version: null })).toBe(false)
    expect(isPushRequest({ ...PUSH, client_id: 7 })).toBe(false)
  })
})
