/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { validateAgainst } from '../harness/ajv-validate'
import identifiers from '../fixtures/identifiers.json'
import { ESignalType, type TPullRequest, type TPullResponse, type TPushRequest, type TPushResponse } from './wire-types'

// MARK: - The TS/Schema drift tripwire

/**
 * The JSON Schemas in ../schemas/ are the canonical machine artifact; the
 * types in ./wire-types.ts are a hand-written mirror. One pinned literal
 * example per message type is BOTH satisfies-checked against the TS type and
 * validated against the schema: if either side drifts, this file fails.
 */

// MARK: - Placeholder ids

const USER_A = '00000000-0000-4000-8000-a10000000001'
const ROW_1 = '00000000-0000-4000-8000-e10000000001'
const ROW_2 = '00000000-0000-4000-8000-e10000000002'
const MUTATION_1 = '00000000-0000-4000-8000-f10000000001'
const MUTATION_2 = '00000000-0000-4000-8000-f10000000002'
const CLIENT_1 = '00000000-0000-4000-8000-c10000000001'

// MARK: - Pinned examples

/** pull request [P:cursor-monotonicity-rebase-and-atomic-checkpoints; SQL:pull-request-shape]: one owner-equality bucket (owner-equality bucket), bootstrap cursor. */
const PULL_REQUEST = {
  buckets: [{ params: { owner_id: USER_A }, table: 'todos' }],
  cursor: '0',
  limit: 500,
  schema_version: 1,
} satisfies TPullRequest

/** pull response [P:cursor-monotonicity-rebase-and-atomic-checkpoints]: page with one row change and one tombstone. */
const PULL_RESPONSE = {
  cursor: '2',
  has_more: false,
  rows: [
    {
      pk: ROW_1,
      row: { done: false, id: ROW_1, owner_id: USER_A, title: 'offline ok' },
      seq: '1',
      table: 'todos',
    },
  ],
  signal: null,
  tombstones: [
    { deleted_at: '2026-01-01T00:00:01.000Z', pk: ROW_2, seq: '2', table: 'todos' },
  ],
} satisfies TPullResponse

/** pull response carrying a typed signal [P:cursor-monotonicity-rebase-and-atomic-checkpoints], seed shape (D-signal-excludes-page-data, I-8): empty page. */
const PULL_RESPONSE_SIGNAL = {
  cursor: '2',
  has_more: false,
  rows: [],
  signal: { type: ESignalType.CHECKPOINT_EXPIRED },
  tombstones: [],
} satisfies TPullResponse

/** push request [P:verdict-completeness-transforms-and-conflict-rejection; P:schema-version-signalling; SQL:push-request-shape]: non-atomic batch (D-atomic-batch-abort). */
const PUSH_REQUEST = {
  batch: {
    atomic: false,
    mutations: [
      {
        columns: { done: false, id: ROW_1, owner_id: USER_A, title: 'offline ok' },
        mutation_id: MUTATION_1,
        op: 'insert',
        pk: ROW_1,
        table: 'todos',
      },
      {
        columns: { done: true },
        mutation_id: MUTATION_2,
        op: 'update',
        pk: ROW_1,
        precondition: { done: false },
        table: 'todos',
      },
    ],
  },
  last_mutation_id: null,
  schema_version: 1,
} satisfies TPushRequest

/** push response fixture [P:mutations-and-column-masked-conflict-resolution; P:verdict-completeness-transforms-and-conflict-rejection]: one applied verdict, one rejected on PRECONDITION carrying a server_row. */
const PUSH_RESPONSE = {
  verdicts: [
    { mutation_id: MUTATION_1, verdict: 'applied' },
    {
      mutation_id: MUTATION_2,
      reason: 'PRECONDITION',
      server_row: { done: true, id: ROW_1, owner_id: USER_A, title: 'offline ok' },
      verdict: 'rejected',
    },
  ],
} satisfies TPushResponse

/** push response [P:verdict-completeness-transforms-and-conflict-rejection], atomic abort: single batch outcome naming the offender (D-atomic-batch-abort). */
const PUSH_RESPONSE_BATCH_ABORT = {
  batch: {
    offender_mutation_id: MUTATION_2,
    outcome: 'aborted',
    reason: 'PRECONDITION',
    server_row: { done: true, id: ROW_1, owner_id: USER_A, title: 'offline ok' },
  },
} satisfies TPushResponse

// MARK: - Schema validation

describe('wire-types: pinned examples validate against the canonical schemas', () => {
  test('pull request', () => {
    expect(validateAgainst('pull-request', PULL_REQUEST)).toEqual([])
  })

  test('pull response', () => {
    expect(validateAgainst('pull-response', PULL_RESPONSE)).toEqual([])
  })

  test('pull response with typed signal (seed shape, D-signal-excludes-page-data)', () => {
    expect(validateAgainst('pull-response', PULL_RESPONSE_SIGNAL)).toEqual([])
  })

  test('push request', () => {
    expect(validateAgainst('push-request', PUSH_REQUEST)).toEqual([])
  })

  test('push response', () => {
    expect(validateAgainst('push-response', PUSH_RESPONSE)).toEqual([])
  })

  test('push response: atomic abort (D-atomic-batch-abort batch outcome)', () => {
    expect(validateAgainst('push-response', PUSH_RESPONSE_BATCH_ABORT)).toEqual([])
  })
})

// MARK: - Closed-contract checks

describe('wire-types: the schemas reject what the spec forbids', () => {
  test('int64 policy: a JSON-number cursor is rejected (C-4; DR:cursor-and-sequence-decimal-string-grammar; D-cursor-opaque-token)', () => {
    const broken = { ...PULL_REQUEST, cursor: 0 }

    expect(validateAgainst('pull-request', broken)).not.toEqual([])
  })

  test('reason union is closed (D-rejection-reasons): an unknown literal is rejected', () => {
    const broken = {
      verdicts: [
        { mutation_id: MUTATION_2, reason: 'TIMEOUT', server_row: null, verdict: 'rejected' },
      ],
    }

    expect(validateAgainst('push-response', broken)).not.toEqual([])
  })

  test('unknown envelope keys are rejected (additionalProperties false)', () => {
    const broken = { ...PULL_RESPONSE, oplog: [] }

    expect(validateAgainst('pull-response', broken)).not.toEqual([])
  })

  test('client_id is declared, not tolerated: a uuid validates, a number and a bare label do not (D-client-identity)', () => {
    expect(validateAgainst('pull-request', { ...PULL_REQUEST, client_id: CLIENT_1 })).toEqual([])
    expect(validateAgainst('push-request', { ...PUSH_REQUEST, client_id: CLIENT_1 })).toEqual([])
    expect(validateAgainst('pull-request', { ...PULL_REQUEST, client_id: 1 })).not.toEqual([])
    expect(validateAgainst('push-request', { ...PUSH_REQUEST, client_id: 'device-a' })).not.toEqual([])
  })

  test('signal type names are the P:cursor-monotonicity-rebase-and-atomic-checkpoints closed set', () => {
    const broken = { ...PULL_RESPONSE_SIGNAL, signal: { type: 'SCHEMA_DRIFT' } }

    expect(validateAgainst('pull-response', broken)).not.toEqual([])
  })

  test('origin HLC accepts millisecond Z stamps and rejects second-precision or offsets', () => {
    const withHlc = (hlc: string) => ({
      ...PUSH_REQUEST,
      batch: {
        ...PUSH_REQUEST.batch,
        mutations: [{ ...PUSH_REQUEST.batch.mutations[0]!, hlc }],
      },
    })

    expect(
      validateAgainst(
        'push-request',
        withHlc(`2026-01-01T00:00:00.000Z|0|${CLIENT_1}`),
      ),
    ).toEqual([])
    expect(validateAgainst('push-request', withHlc(`2026-01-01T00:00:00Z|0|${CLIENT_1}`))).not.toEqual(
      [],
    )
    expect(
      validateAgainst('push-request', withHlc(`2026-01-01T00:00:00.000+00:00|0|${CLIENT_1}`)),
    ).not.toEqual([])
  })
})

// MARK: - Placeholder discipline

describe('wire-types: example ids are registered placeholders', () => {
  test('every example uuid exists in fixtures/identifiers.json', () => {
    const registry = identifiers as Record<string, { kind: string; label: string }>

    for (const id of [USER_A, CLIENT_1, ROW_1, ROW_2, MUTATION_1, MUTATION_2]) {
      expect(registry[id]).toBeDefined()
    }
  })
})
