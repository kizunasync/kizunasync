// MARK: - Harness bites

/**
 * Six black-box mutations over IProtocolServer proxies, never reference
 * internals, each asserted to produce status:'fail' at a pinned step. A
 * positive control first proves the UNMUTATED reference passes the target
 * case under the same fencing mechanism (guards fail-for-the-wrong-reason); the
 * conformance suite is the global anti-vacuous-green guard. The import is
 * STATIC: a reference load failure fails this suite loudly instead of
 * draining M-1..M-6 into skips.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readCorpusFile } from '../harness/load'
import type { TPullResponse, TPushRequest, TPushResponse } from '../spec/wire-types'
import { runTranscript } from './executor'
import type { TCaseResult } from './executor'
import { makeReferenceServer } from './reference'
import { SCENARIOS } from './scenarios'
import { EFencing } from './server-contract'
import type { IProtocolServer } from './server-contract'

// MARK: - Helpers

const ROOT = join(import.meta.dir, '..')

type TJsonObject = Record<string, unknown>

const asObject = (value: unknown): TJsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TJsonObject) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const clone = (value: unknown): TJsonObject => JSON.parse(JSON.stringify(value)) as TJsonObject

// Delegating proxy mutating one rpc's responses (M-1..M-5).
const withResponseMutation = (
  server: IProtocolServer,
  rpc: 'pull' | 'push',
  mutate: (response: TJsonObject) => TJsonObject
): IProtocolServer => ({
  seed: (seed) => {
    server.seed(seed)
  },
  setStep: (n) => {
    server.setStep(n)
  },
  applyServerChange: (change) => {
    server.applyServerChange(change)
  },
  commitTxn: (txn) => {
    server.commitTxn(txn)
  },
  pull: (request) =>
    rpc === 'pull'
      ? (mutate(clone(server.pull(request))) as unknown as TPullResponse) // black-box JSON mutation
      : server.pull(request),
  push: (request) =>
    rpc === 'push'
      ? (mutate(clone(server.push(request))) as unknown as TPushResponse) // black-box JSON mutation
      : server.push(request),
})

/**
 * Delegating proxy rewriting push requests before delegation and responses
 * after (M-6); `call` is the 1-based push invocation index.
 */
const withPushRewrite = (
  server: IProtocolServer,
  rewriteRequest: (request: TJsonObject, call: number) => TJsonObject,
  rewriteResponse: (response: TJsonObject, call: number) => TJsonObject
): IProtocolServer => {
  let calls = 0

  return {
    seed: (seed) => {
      server.seed(seed)
    },
    setStep: (n) => {
      server.setStep(n)
    },
    applyServerChange: (change) => {
      server.applyServerChange(change)
    },
    commitTxn: (txn) => {
      server.commitTxn(txn)
    },
    pull: (request) => server.pull(request),
    push: (request) => {
      calls += 1
      const rewritten = rewriteRequest(clone(request), calls) as unknown as TPushRequest // black-box JSON rewrite

      return rewriteResponse(clone(server.push(rewritten)), calls) as unknown as TPushResponse // black-box JSON rewrite
    },
  }
}

const runCase = (server: IProtocolServer, file: string, id: string): TCaseResult =>
  runTranscript(server, readCorpusFile(ROOT, file).json, EFencing.visibilityHorizon, SCENARIOS[id])

const expectBite = (result: TCaseResult, step: number, rpc: 'pull' | 'push'): void => {
  expect(result.status).toBe('fail')

  if (result.status === 'fail') {
    expect(result.failures[0]?.step).toBe(step)
    expect(result.failures[0]?.rpc).toBe(rpc)
  }
}

// MARK: - Mutations M-1..M-6

describe('harness bites: every mutated server draws blood', () => {
  const make = makeReferenceServer

  test('M-1 pull cursor off-by-one bites (pull/001, step 1): I-3/D-cursor-opaque-token', () => {
    const file = 'transcripts/pull/001-bootstrap-empty.json'
    const id = 'pull/001-bootstrap-empty'

    expect(runCase(make(), file, id).status).toBe('pass') // positive control
    const mutated = withResponseMutation(make(), 'pull', (response) => ({
      ...response,
      cursor: String(BigInt(String(response.cursor)) + 1n),
    }))

    expectBite(runCase(mutated, file, id), 1, 'pull')
  })

  test('M-2 omitted push verdict bites (push/002, step 7): I-5 bijection', () => {
    const file = 'transcripts/push/002-rls-denied-not-a-wedge.json'
    const id = 'push/002-rls-denied-not-a-wedge'

    expect(runCase(make(), file, id).status).toBe('pass') // positive control
    const mutated = withResponseMutation(make(), 'push', (response) => ({
      ...response,
      verdicts: asArray(response.verdicts).slice(0, -1),
    }))

    expectBite(runCase(mutated, file, id), 7, 'push')
  })

  test('M-3 undelivered tombstone bites (tombstones/001, step 5): P:mutations-and-column-masked-conflict-resolution/P:cursor-monotonicity-rebase-and-atomic-checkpoints', () => {
    const file = 'transcripts/tombstones/001-delete-propagates.json'
    const id = 'tombstones/001-delete-propagates'

    expect(runCase(make(), file, id).status).toBe('pass') // positive control
    const mutated = withResponseMutation(make(), 'pull', (response) => ({
      ...response,
      tombstones: [],
    }))

    expectBite(runCase(mutated, file, id), 5, 'pull')
  })

  test('M-4 swallowed signal bites (lifecycle/001, step 1): P:cursor-monotonicity-rebase-and-atomic-checkpoints/I-8', () => {
    const file = 'transcripts/lifecycle/001-checkpoint-expired-rehydrate.json'
    const id = 'lifecycle/001-checkpoint-expired-rehydrate'

    expect(runCase(make(), file, id).status).toBe('pass') // positive control
    const mutated = withResponseMutation(make(), 'pull', (response) => ({
      ...response,
      signal: null,
    }))

    expectBite(runCase(mutated, file, id), 1, 'pull')
  })

  test('M-5 inverted boundary bites (pull/002, step 4): D-page-cap-and-checkpoint-boundary', () => {
    const file = 'transcripts/pull/002-keyset-pagination.json'
    const id = 'pull/002-keyset-pagination'

    expect(runCase(make(), file, id).status).toBe('pass') // positive control
    const mutated = withResponseMutation(make(), 'pull', (response) => ({
      ...response,
      has_more: response.has_more !== true,
    }))

    expectBite(runCase(mutated, file, id), 4, 'pull')
  })

  test('M-6 dedup bypass is caught DOWNSTREAM by the byte oracle (push/003, step 6): P:session-guarantees-and-exactly-once-effect/D-dedup-storage-model', () => {
    const file = 'transcripts/push/003-replay-returns-recorded-verdicts.json'
    const id = 'push/003-replay-returns-recorded-verdicts'
    const originalId = '00000000-0000-4000-8000-f10000000004'
    const freshId = '00000000-0000-4000-8000-f19999999999'

    expect(runCase(make(), file, id).status).toBe('pass') // positive control
    const mutated = withPushRewrite(
      make(),
      (request, call) => {
        if (call !== 2) {
          return request
        }
        // The retry presents fresh mutation ids: dedup is bypassed, the server double-applies (stamping seq '2').
        const batch = asObject(request.batch) ?? {}
        const mutations = asArray(batch.mutations).map((mutation) => ({
          ...(asObject(mutation) ?? {}),
          mutation_id: freshId,
        }))

        return { ...request, batch: { ...batch, mutations } }
      },
      (response, call) => {
        if (call !== 2) {
          return response
        }
        // Restore the original id so the push response bytes look right: only the step-6 pull (seq '2' ≠ golden '1') can catch the double effect.
        const verdicts = asArray(response.verdicts).map((verdict) => ({
          ...(asObject(verdict) ?? {}),
          mutation_id: originalId,
        }))

        return { ...response, verdicts }
      }
    )

    expectBite(runCase(mutated, file, id), 6, 'pull')
  })
})
