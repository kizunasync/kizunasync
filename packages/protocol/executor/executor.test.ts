// MARK: - Executor unit tests

/**
 * Driven against tiny scripted stubs built from a transcript's OWN golden
 * responses, never the reference implementation: these tests pin the
 * executor's dispatch semantics independently of any server-under-test.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readCorpusFile } from '../harness/load'
import type { TPullResponse, TPushResponse } from '../spec/wire-types'
import { runCorpus, runTranscript } from './executor'
import { SCENARIOS } from './scenarios'
import { EFencing } from './server-contract'
import type { IProtocolServer, TServerChange, TServerSeed } from './server-contract'

// MARK: - Corpus access

const ROOT = join(import.meta.dir, '..')

const PUSH_003 = readCorpusFile(ROOT, 'transcripts/push/003-replay-returns-recorded-verdicts.json').json
const PULL_001 = readCorpusFile(ROOT, 'transcripts/pull/001-bootstrap-empty.json').json
const FENCING_001_A = readCorpusFile(ROOT, 'transcripts/fencing/001-late-commit-delivered.json').json
const LIFECYCLE_006 = readCorpusFile(ROOT, 'transcripts/lifecycle/006-continuation-expires-when-its-start-is-reaped.json').json

// MARK: - Scripted stub

type TJsonObject = Record<string, unknown>

type TScriptedCall = { rpc: 'pull' | 'push'; response: unknown }

type TLogEntry =
  | { call: 'seed'; seed: TServerSeed }
  | { call: 'setStep'; n: number }
  | { call: 'applyServerChange'; change: TServerChange }
  | { call: 'commitTxn'; txn: string }
  | { call: 'pull' }
  | { call: 'push' }

const DUMMY_RESPONSES: Record<'pull' | 'push', unknown> = {
  pull: { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] },
  push: { verdicts: [] },
}

const asObject = (value: unknown): TJsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TJsonObject) : null

const transcriptSteps = (transcript: unknown): TJsonObject[] => {
  const steps = asObject(transcript)?.steps

  return Array.isArray(steps) ? steps.map((raw) => asObject(raw) ?? {}) : []
}

/**
 * Build the invocation script from the transcript's own goldens: rpc steps
 * replay their golden response; drop-ack targets get a dummy (the executor
 * must discard it); transport-error contributes nothing (never applied).
 */
const goldenScript = (transcript: unknown): TScriptedCall[] => {
  const script: TScriptedCall[] = []

  for (const step of transcriptSteps(transcript)) {
    if (step.kind === 'rpc' && (step.rpc === 'pull' || step.rpc === 'push')) {
      script.push({ rpc: step.rpc, response: step.response })
    }
    if (step.kind === 'fault' && step.fault === 'drop-ack' && (step.target === 'pull' || step.target === 'push')) {
      script.push({ rpc: step.target, response: DUMMY_RESPONSES[step.target] })
    }
  }
  return script
}

const makeScriptedStub = (script: TScriptedCall[]): { server: IProtocolServer; log: TLogEntry[] } => {
  const log: TLogEntry[] = []
  let position = 0
  const next = (rpc: 'pull' | 'push'): unknown => {
    const entry = script[position]

    position += 1

    if (entry === undefined || entry.rpc !== rpc) {
      throw new Error(`scripted stub: unexpected ${rpc} invocation at script position ${position - 1}`)
    }
    return entry.response
  }
  const server: IProtocolServer = {
    seed: (seed) => {
      log.push({ call: 'seed', seed })
    },
    setStep: (n) => {
      log.push({ call: 'setStep', n })
    },
    applyServerChange: (change) => {
      log.push({ call: 'applyServerChange', change })
    },
    commitTxn: (txn) => {
      log.push({ call: 'commitTxn', txn })
    },
    pull: () => {
      log.push({ call: 'pull' })

      return next('pull') as TPullResponse // scripted golden bytes
    },
    push: () => {
      log.push({ call: 'push' })

      return next('push') as TPushResponse // scripted golden bytes
    },
  }

  return { log, server }
}

// MARK: - Step dispatch

describe('runTranscript step dispatch', () => {
  test('golden replay passes with per-kind outcomes and a default seed', () => {
    const { server, log } = makeScriptedStub(goldenScript(PUSH_003))
    const result = runTranscript(server, PUSH_003, EFencing.visibilityHorizon)

    expect(result.status).toBe('pass')

    if (result.status === 'pass') {
      expect(result.case).toBe('push/003-replay-returns-recorded-verdicts')
      expect(result.fencing).toBe('visibility-horizon')
      expect(result.steps.map((step) => `${step.n}:${step.kind}:${step.ok}`)).toEqual([
        '1:local:true',
        '2:assert:true',
        '3:fault:true',
        '4:rpc:true',
        '5:assert:true',
        '6:rpc:true',
        '7:assert:true',
      ])
      expect(result.steps[0]?.detail).toBe('client-local')
      expect(result.steps[1]?.detail).toBe('client-obligation-skipped')
      expect(result.steps[2]?.detail).toBe('drop-ack: applied, response discarded')
    }
    const seeded = log[0]

    expect(seeded?.call).toBe('seed')

    if (seeded !== undefined && seeded.call === 'seed') {
      // Defaults: seqs dense from '1' (Decimal seq and cursor token), no elided history.
      expect(seeded.seed.fencing).toBe('visibility-horizon')
      expect(seeded.seed.next_seq).toBe('1')
      expect(seeded.seed.history).toEqual([])
      expect(seeded.seed.client_id).toBe('00000000-0000-4000-8000-c10000000001')
      expect(seeded.seed.user_id).toBe('00000000-0000-4000-8000-a10000000001')
      expect(seeded.seed.min_schema_version).toBe(1)
      expect(seeded.seed.tombstone_ttl_days).toBe(30)
      expect(seeded.seed.tables).toEqual({ todos: { bucket_column: 'owner_id' } })
    }
  })

  test('a diverging rpc response surfaces both canonical byte strings', () => {
    const wrong = { cursor: '1', has_more: false, rows: [], signal: null, tombstones: [] }
    const { server } = makeScriptedStub([{ rpc: 'pull', response: wrong }])
    const result = runTranscript(server, PULL_001, EFencing.visibilityHorizon)

    expect(result.status).toBe('fail')

    if (result.status === 'fail') {
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0]?.step).toBe(1)
      expect(result.failures[0]?.rpc).toBe('pull')
      expect(result.failures[0]?.expected).toContain('"cursor": "0"')
      expect(result.failures[0]?.actual).toContain('"cursor": "1"')
    }
  })

  test('a throw at an rpc step is a failure, never a crash', () => {
    const server = makeScriptedStub([]).server // empty script: the pull invocation throws
    const result = runTranscript(server, PULL_001, EFencing.visibilityHorizon)

    expect(result.status).toBe('fail')

    if (result.status === 'fail') {
      expect(result.failures[0]?.step).toBe(1)
      expect(result.failures[0]?.actual).toContain('unexpected pull invocation')
    }
  })
})

// MARK: - Fault semantics

describe('runTranscript fault semantics', () => {
  test('transport-error performs zero rpc invocations', () => {
    const { server, log } = makeScriptedStub(goldenScript(FENCING_001_A))
    const result = runTranscript(
      server,
      FENCING_001_A,
      EFencing.visibilityHorizon,
      SCENARIOS['fencing/001-late-commit-delivered']
    )

    expect(result.status).toBe('pass')
    // fencing/001 has pulls at steps 3 and 6 only: the step-5 transport-error never reaches the server ('the request was never applied', P:verdict-completeness-transforms-and-conflict-rejection).
    expect(log.filter((entry) => entry.call === 'pull')).toHaveLength(2)
    expect(log.filter((entry) => entry.call === 'push')).toHaveLength(0)
  })

  test('drop-ack invokes the target exactly once and discards the response', () => {
    const { server, log } = makeScriptedStub(goldenScript(PUSH_003))
    const result = runTranscript(server, PUSH_003, EFencing.visibilityHorizon)

    // The dummy drop-ack response was discarded, never byte-compared.
    expect(result.status).toBe('pass')
    // push/003: step 3 (dropped ack) + step 4 (retry) = exactly two pushes.
    expect(log.filter((entry) => entry.call === 'push')).toHaveLength(2)
    expect(log.filter((entry) => entry.call === 'pull')).toHaveLength(1)
  })
})

// MARK: - Scenario controls

describe('runTranscript scenario controls', () => {
  test('held txn stamps at its step and commits exactly after commit_after_step', () => {
    const { server, log } = makeScriptedStub(goldenScript(FENCING_001_A))

    runTranscript(server, FENCING_001_A, EFencing.visibilityHorizon, SCENARIOS['fencing/001-late-commit-delivered'])
    const trace = log.map((entry) => {
      if (entry.call === 'setStep') {
        return `setStep:${entry.n}`
      }
      if (entry.call === 'commitTxn') {
        return `commitTxn:${entry.txn}`
      }
      if (entry.call === 'applyServerChange') {
        return `applyServerChange:${entry.change.op === 'reap' ? 'reap' : (entry.change.txn ?? '-')}`
      }
      return entry.call
    })

    expect(trace).toEqual([
      'seed',
      'setStep:1',
      'applyServerChange:t1',
      'setStep:2',
      'applyServerChange:-',
      'setStep:3',
      'pull',
      'setStep:4',
      'setStep:5',
      'commitTxn:t1',
      'setStep:6',
      'pull',
      'setStep:7',
    ])
    const seeded = log[0]

    if (seeded !== undefined && seeded.call === 'seed') {
      expect(seeded.seed.next_seq).toBe('5') // elided history: fencing seq gaps by design (Decimal seq and cursor token)
    }
  })

  test('a reap server step reaches the server as a reap change, never an upsert', () => {
    const { server, log } = makeScriptedStub(goldenScript(LIFECYCLE_006))
    const result = runTranscript(server, LIFECYCLE_006, EFencing.visibilityHorizon)
    const changes = log.flatMap((entry) => (entry.call === 'applyServerChange' ? [entry.change] : []))

    expect(result.status).toBe('pass')
    expect(changes.map((change) => change.op)).toEqual(['upsert', 'upsert', 'delete', 'upsert', 'reap'])
    expect(changes.at(-1)).toEqual({ op: 'reap' })
  })

})

// MARK: - Corpus runner

const makeRecordingFactory = (): { makeServer: () => IProtocolServer; seeds: TServerSeed[] } => {
  const seeds: TServerSeed[] = []
  const makeServer = (): IProtocolServer => {
    let seeded = 0

    return {
      seed: (seed) => {
        seeded += 1

        if (seeded > 1) {
          throw new Error('runCorpus must build a fresh server per run')
        }
        seeds.push(seed)
      },
      setStep: () => {},
      applyServerChange: () => {},
      commitTxn: () => {},
      pull: () => DUMMY_RESPONSES.pull as TPullResponse, // dummy: structure-only test
      push: () => DUMMY_RESPONSES.push as TPushResponse, // dummy: structure-only test
    }
  }
  return { makeServer, seeds }
}

describe('runCorpus manifest dispatch', () => {
  test('every case runs once against its transcript file', () => {
    const { makeServer, seeds } = makeRecordingFactory()
    const results = runCorpus(ROOT, makeServer)

    expect(results).toHaveLength(48)
    const executed = results.filter((result) => result.status !== 'skipped-blocked')

    expect(executed).toHaveLength(47)
    expect(seeds).toHaveLength(47)
    const byCase = new Map<string, string[]>()

    executed.forEach((result, index) => {
      byCase.set(result.case, [...(byCase.get(result.case) ?? []), result.fencing])
      // The seeded fencing always matches the fencing the run was driven as.
      expect(seeds[index]?.fencing).toBe(result.fencing)
    })
    expect(byCase.size).toBe(47)

    for (const [id, fencings] of byCase) {
      const expected = id.startsWith('fencing/') ? 'visibility-horizon' : 'shared'

      expect(fencings).toEqual([expected])
    }
    expect(byCase.get('pull/001-bootstrap-empty')).toEqual(['shared'])
    expect(byCase.get('fencing/001-late-commit-delivered')).toEqual(['visibility-horizon'])
  })

  test('blocked manifest entries surface skipped-blocked with the decision reason', () => {
    const { makeServer } = makeRecordingFactory()
    const results = runCorpus(ROOT, makeServer)
    const blocked = new Map<string, { blocked_on: string[]; reason: string }>()

    for (const result of results) {
      if (result.status === 'skipped-blocked') {
        blocked.set(result.case, { blocked_on: result.blocked_on, reason: result.reason })
      }
    }
    expect([...blocked.keys()].sort()).toEqual(['wakeup/002-wakeup-payload'])
    expect(blocked.get('wakeup/002-wakeup-payload')?.blocked_on).toEqual(['D-wakeup-channel'])
    expect(blocked.get('wakeup/002-wakeup-payload')?.reason).toContain('D-wakeup-channel')
  })

  test('the blocked entry is the only skip', () => {
    const { makeServer } = makeRecordingFactory()
    const results = runCorpus(ROOT, makeServer)
    const skipped = results.filter((result) => result.status !== 'pass' && result.status !== 'fail')

    expect(skipped.map((result) => result.case)).toEqual(['wakeup/002-wakeup-payload'])
  })
})
