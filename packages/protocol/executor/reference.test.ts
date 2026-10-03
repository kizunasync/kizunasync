/**
 * Reference server tests.
 *
 * Two layers:
 *   1. Pinned corners: unit tests for the corpus-underdetermined behaviors
 *      (OD gates, verdict ordering rules, fencing
 *      mechanics, the logical clock).
 *   2. Golden-byte self-probe: a minimal step-runner driving the reference
 *      through every seeded transcript under the visibility horizon (the
 *      fencing mechanism D-visibility-horizon decided) and byte-comparing each rpc
 *      response against the golden slice via the harness canonicalizer
 *      (I-1/C-7: canonical-equality IS byte-equality). The full executor +
 *      conformance suite covers the same ground exhaustively; this probe validates the
 *      reference in parallel and is intentionally redundant with it.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { canonicalize } from '../harness/canonical'
import { loadCorpus } from '../harness/load'
import { MAX_PULL_BUCKETS } from '../spec/limits'
import type { TColumnValues, TPullRequest, TPullResponse, TPushRequest, TPushResponse, TVerdict } from '../spec/wire-types'
import { ESignalType } from '../spec/wire-types'
import { EFencing } from './server-contract'
import type { IProtocolServer, TFencing, THistoryOp, TServerSeed } from './server-contract'
import { makeReferenceServer } from './reference'
import { SCENARIOS } from './scenarios'
import type { TScenario } from './scenarios'

// MARK: - Pinned identifiers

const USER_A = '00000000-0000-4000-8000-a10000000001'
const USER_B = '00000000-0000-4000-8000-a10000000002'
const CLIENT = '00000000-0000-4000-8000-c10000000001'
const ACTOR = '00000000-0000-4000-8000-c10000000002'
const ROW_E1 = '00000000-0000-4000-8000-e10000000001'
const ROW_E2 = '00000000-0000-4000-8000-e10000000002'
const MUT_1 = '00000000-0000-4000-8000-f10000000001'
const MUT_2 = '00000000-0000-4000-8000-f10000000002'

// MARK: - Seed + request helpers

const makeSeed = (overrides: Partial<TServerSeed> = {}): TServerSeed => ({
  client_id: CLIENT,
  user_id: USER_A,
  min_schema_version: 1,
  tables: { todos: { bucket_column: 'owner_id' } },
  tombstone_ttl_days: 30,
  fencing: EFencing.visibilityHorizon,
  next_seq: '1',
  history: [],
  ...overrides,
})

const seededServer = (overrides: Partial<TServerSeed> = {}): IProtocolServer => {
  const server = makeReferenceServer()

  server.seed(makeSeed(overrides))

  return server
}

const pullRequest = (cursor: string, overrides: Partial<TPullRequest> = {}): TPullRequest => ({
  buckets: [{ params: { owner_id: USER_A }, table: 'todos' }],
  cursor,
  schema_version: 1,
  ...overrides,
})

/**
 * Non-atomic pushes always carry the verdicts arm (the bijection); narrow the
 * D-atomic-batch-abort response union for the per-mutation assertions below.
 */
const verdictsOf = (response: TPushResponse): TVerdict[] => {
  if (!('verdicts' in response)) {
    throw new Error('expected the per-mutation verdicts arm, got a batch outcome')
  }
  return response.verdicts
}

const pushOne = (
  server: IProtocolServer,
  mutation: TPushRequest['batch']['mutations'][number],
  schemaVersion = 1
): TVerdict => {
  const response = server.push({
    batch: { atomic: false, mutations: [mutation] },
    last_mutation_id: null,
    schema_version: schemaVersion,
  })
  const verdict = verdictsOf(response)[0]

  if (verdict === undefined) {
    throw new Error('push returned no verdict')
  }
  return verdict
}

const upsert = (server: IProtocolServer, pk: string, columns: TColumnValues, txn?: string): void => {
  server.applyServerChange({ actor: ACTOR, op: 'upsert', table: 'todos', pk, columns, txn })
}

// MARK: - Atomic batch semantics

describe('atomic batch revert', () => {
  test('atomic:true reverts entirely on the first rejection and names the offender', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'claimed by device-b' })
    server.setStep(2)
    // insert e2 would apply (seq 2), but the e1 precondition mismatches ⇒ abort
    const response = server.push({
      batch: {
        atomic: true,
        mutations: [
          { columns: { done: false, owner_id: USER_A, title: 'second task' }, mutation_id: MUT_1, op: 'insert', pk: ROW_E2, table: 'todos' },
          { columns: { title: 'claimed by device-a' }, mutation_id: MUT_2, op: 'update', pk: ROW_E1, precondition: { title: 'unclaimed' }, table: 'todos' },
        ],
      },
      last_mutation_id: null,
      schema_version: 1,
    })

    expect(response).toEqual({
      batch: {
        offender_mutation_id: MUT_2,
        outcome: 'aborted',
        reason: 'PRECONDITION',
        server_row: { done: false, owner_id: USER_A, title: 'claimed by device-b' },
      },
    })
    // The aborted batch applies nothing: the e2 insert reverts and the seq counter rewinds.
    server.setStep(3)
    const page = server.pull(pullRequest('0'))

    expect(page.cursor).toBe('1')
    expect(page.rows.map((row) => row.pk)).toEqual([ROW_E1])
  })

  test('atomic:true that fully applies returns the per-mutation verdicts (the bijection)', () => {
    const server = seededServer()

    server.setStep(1)
    const response = server.push({
      batch: {
        atomic: true,
        mutations: [
          { columns: { done: false, owner_id: USER_A, title: 'first' }, mutation_id: MUT_1, op: 'insert', pk: ROW_E1, table: 'todos' },
          { columns: { done: false, owner_id: USER_A, title: 'second' }, mutation_id: MUT_2, op: 'insert', pk: ROW_E2, table: 'todos' },
        ],
      },
      last_mutation_id: null,
      schema_version: 1,
    })

    expect(response).toEqual({
      verdicts: [
        { mutation_id: MUT_1, verdict: 'applied' },
        { mutation_id: MUT_2, verdict: 'applied' },
      ],
    })
    server.setStep(2)
    expect(server.pull(pullRequest('0')).rows.map((row) => row.seq)).toEqual(['1', '2'])
  })
})

// MARK: - Schema handshake

describe('push schema handshake', () => {
  test('stale push schema_version returns a typed RESET_REQUIRED signal', () => {
    const server = seededServer({ min_schema_version: 2 })
    const response = server.push({
      batch: {
        atomic: false,
        mutations: [{ columns: { owner_id: USER_A }, mutation_id: MUT_1, op: 'insert', pk: ROW_E1, table: 'todos' }],
      },
      last_mutation_id: null,
      schema_version: 1,
    })

    expect(response).toEqual({ signal: { type: ESignalType.RESET_REQUIRED } })
  })
})

// MARK: - Client identity

describe('client identity on the wire', () => {
  test('pull accepts client_id and answers the same bytes with or without it', () => {
    const anonymous = seededServer()
    const identified = seededServer()

    for (const server of [anonymous, identified]) {
      server.setStep(1)
      upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'offline ok' })
    }
    expect(identified.pull(pullRequest('0', { client_id: CLIENT }))).toEqual(
      anonymous.pull(pullRequest('0'))
    )
  })

  test('push accepts client_id and answers the same bytes with or without it', () => {
    const mutation = {
      columns: { done: false, owner_id: USER_A, title: 'offline ok' },
      mutation_id: MUT_1,
      op: 'insert' as const,
      pk: ROW_E1,
      table: 'todos',
    }
    const request = { batch: { atomic: false, mutations: [mutation] }, last_mutation_id: null, schema_version: 1 }

    expect(seededServer().push({ ...request, client_id: CLIENT })).toEqual(
      seededServer().push(request)
    )
  })
})

// MARK: - Push verdict ordering rules

describe('push verdicts', () => {
  test('a tombstoned pk answers DELETE_WINS when the subject received a row of its bucket, and RLS_DENIED when it never did', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_B, title: 'never ours' })
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'ours' })
    server.pull(pullRequest('0'))
    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E2 })
    // No owner is left to evaluate on a deleted row (tombstones/002, D-rejection-reasons), so the grant for the bucket it was deleted from decides (D-tombstone-delivery).
    const foreign = pushOne(server, { columns: { title: 'edit' }, mutation_id: MUT_1, op: 'update', pk: ROW_E1, table: 'todos' })
    const received = pushOne(server, { columns: { title: 'edit' }, mutation_id: MUT_2, op: 'update', pk: ROW_E2, table: 'todos' })

    expect(foreign).toEqual({ mutation_id: MUT_1, reason: 'RLS_DENIED', server_row: null, verdict: 'rejected' })
    expect(received).toEqual({ mutation_id: MUT_2, reason: 'DELETE_WINS', server_row: null, verdict: 'rejected' })
  })

  test('a delete earlier in the same push answers DELETE_WINS without a grant, and a later push RLS_DENIED', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'never pulled' })
    server.setStep(2)
    const sameBatch = verdictsOf(server.push({
      batch: {
        atomic: false,
        mutations: [
          { columns: {}, mutation_id: MUT_1, op: 'delete', pk: ROW_E1, table: 'todos' },
          { columns: { title: 'too late' }, mutation_id: MUT_2, op: 'update', pk: ROW_E1, table: 'todos' },
        ],
      },
      last_mutation_id: null,
      schema_version: 1,
    }))
    const later = pushOne(server, { columns: { title: 'later' }, mutation_id: '00000000-0000-4000-8000-f10000000003', op: 'update', pk: ROW_E1, table: 'todos' })

    expect(sameBatch.map((verdict) => ('reason' in verdict ? verdict.reason : verdict.verdict))).toEqual(['applied', 'DELETE_WINS'])
    expect('reason' in later ? later.reason : later.verdict).toBe('RLS_DENIED')
  })

  test('RLS rejection carries server_row null and never wedges the batch', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_B, title: 'theirs' })
    const response = server.push({
      batch: {
        atomic: false,
        mutations: [
          { columns: { title: 'stale edit' }, mutation_id: MUT_1, op: 'update', pk: ROW_E1, table: 'todos' },
          { columns: { done: false, owner_id: USER_A, title: 'mine' }, mutation_id: MUT_2, op: 'insert', pk: ROW_E2, table: 'todos' },
        ],
      },
      last_mutation_id: null,
      schema_version: 1,
    })

    expect(verdictsOf(response)).toEqual([
      { mutation_id: MUT_1, reason: 'RLS_DENIED', server_row: null, verdict: 'rejected' },
      { mutation_id: MUT_2, verdict: 'applied' },
    ])
  })

  test('precondition mismatch returns the full visible row (push/004 shape)', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'claimed by device-b' })
    const verdict = pushOne(server, {
      columns: { title: 'claimed by device-a' },
      mutation_id: MUT_1,
      op: 'update',
      pk: ROW_E1,
      precondition: { title: 'unclaimed' },
      table: 'todos',
    })

    expect(verdict).toEqual({
      mutation_id: MUT_1,
      reason: 'PRECONDITION',
      server_row: { done: false, owner_id: USER_A, title: 'claimed by device-b' },
      verdict: 'rejected',
    })
  })

  test('replayed mutation_id returns the recorded verdict without stamping a seq', () => {
    const server = seededServer()

    server.setStep(1)
    const mutation = { columns: { done: false, owner_id: USER_A, title: 'once' }, mutation_id: MUT_1, op: 'insert' as const, pk: ROW_E1, table: 'todos' }

    expect(pushOne(server, mutation)).toEqual({ mutation_id: MUT_1, verdict: 'applied' })
    server.setStep(2)
    expect(pushOne(server, mutation)).toEqual({ mutation_id: MUT_1, verdict: 'applied' })
    server.setStep(3)
    const page = server.pull(pullRequest('0'))

    // a double apply would have stamped seq '2' (push/003 step-6 proof)
    expect(page.cursor).toBe('1')
    expect(page.rows.map((row) => row.seq)).toEqual(['1'])
  })

  test('a replayed rejection keeps its kind and reason and renders the row as it stands now (D-verdict-ownership)', () => {
    const server = seededServer()
    const claim = { columns: { title: 'claimed by device-a' }, mutation_id: MUT_1, op: 'update' as const, pk: ROW_E1, precondition: { title: 'unclaimed' }, table: 'todos' }

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'claimed by device-b' })
    server.setStep(2)
    expect(pushOne(server, claim)).toMatchObject({ reason: 'PRECONDITION', server_row: { title: 'claimed by device-b' } })
    server.setStep(3)
    upsert(server, ROW_E1, { title: 'renamed by device-b' })
    server.setStep(4)

    expect(pushOne(server, claim)).toEqual({
      mutation_id: MUT_1,
      reason: 'PRECONDITION',
      server_row: { done: false, owner_id: USER_A, title: 'renamed by device-b' },
      verdict: 'rejected',
    })
  })

  test('a replayed transform renders the arbitrated total as it stands now and applies nothing again', () => {
    const server = seededServer()
    const increment = { columns: {}, mutation_id: MUT_1, op: 'update' as const, pk: ROW_E1, table: 'todos', transforms: { likes: { by: 2, op: 'increment' as const } } }

    server.setStep(1)
    upsert(server, ROW_E1, { likes: 0, owner_id: USER_A, title: 'counted' })
    server.setStep(2)
    expect(pushOne(server, increment)).toMatchObject({ server_row: { likes: 2 }, verdict: 'applied' })
    server.setStep(3)
    upsert(server, ROW_E1, { likes: 10 })
    server.setStep(4)

    expect(pushOne(server, increment)).toEqual({ mutation_id: MUT_1, server_row: { likes: 10, owner_id: USER_A, title: 'counted' }, verdict: 'applied' })
    expect(server.pull(pullRequest('0')).rows.map((row) => row.row.likes)).toEqual([10])
  })

  test('a replayed rejection renders no row once the subject can no longer see it', () => {
    const server = seededServer()
    const claim = { columns: { title: 'claimed by device-a' }, mutation_id: MUT_1, op: 'update' as const, pk: ROW_E1, precondition: { title: 'unclaimed' }, table: 'todos' }

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'claimed by device-b' })
    server.setStep(2)
    pushOne(server, claim)
    server.setStep(3)
    upsert(server, ROW_E1, { owner_id: USER_B })
    server.setStep(4)

    expect(pushOne(server, claim)).toEqual({ mutation_id: MUT_1, reason: 'PRECONDITION', server_row: null, verdict: 'rejected' })
  })

  test('a replayed transform carries no server_row when the subject cannot see the row at the replay', () => {
    const server = seededServer()
    const increment = { columns: {}, mutation_id: MUT_1, op: 'update' as const, pk: ROW_E1, table: 'todos', transforms: { likes: { by: 2, op: 'increment' as const } } }

    server.setStep(1)
    upsert(server, ROW_E1, { likes: 0, owner_id: USER_A, title: 'counted' })
    server.setStep(2)
    expect(pushOne(server, increment)).toMatchObject({ server_row: { likes: 2 }, verdict: 'applied' })
    server.setStep(3)
    upsert(server, ROW_E1, { owner_id: USER_B })
    server.setStep(4)

    const replayed = pushOne(server, increment)

    expect(replayed).toEqual({ mutation_id: MUT_1, verdict: 'applied' })
    expect('server_row' in replayed).toBe(false)
  })
})

// MARK: - Fencing mechanics

describe('fencing mechanism', () => {
  test('REFINED horizon: delivers a committed seq above an in-flight seq, encoding the gap as a hole (D-visibility-horizon)', () => {
    const server = seededServer({ fencing: EFencing.visibilityHorizon })

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'held open' }, 't1') // stamps seq 1, uncommitted
    server.setStep(2)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'committed' }) // seq 2, committed
    server.setStep(3)
    // Refined horizon: seq 2 is committed/visible above the in-flight seq 1, so it is delivered NOW; the cursor encodes high-water 2 + the pending hole 1 ("2~1"), and has_more stays true while the hole is open.
    const fenced = server.pull(pullRequest('0'))

    expect(fenced.cursor).toBe('2~1')
    expect(fenced.has_more).toBe(true)
    expect(fenced.rows.map((row) => row.seq)).toEqual(['2'])
    expect(fenced.signal).toBeNull()
    expect(fenced.tombstones).toEqual([])
    // The next pull resumes from the composite cursor: seq 1 is still in-flight, nothing new commits, so it re-delivers nothing and the token is unchanged.
    const stillHeld = server.pull(pullRequest('2~1'))

    expect(stillHeld.cursor).toBe('2~1')
    expect(stillHeld.rows).toEqual([])
    // After t1 commits, pulling from the composite cursor delivers the hole (seq 1) and the cursor closes to the flat decimal "2".
    server.commitTxn('t1')
    server.setStep(4)
    const filled = server.pull(pullRequest('2~1'))

    expect(filled.cursor).toBe('2')
    expect(filled.has_more).toBe(false)
    expect(filled.rows.map((row) => row.seq)).toEqual(['1'])
  })

  test('REFINED horizon: a FULL continuation page carries the pending hole (not dropped)', () => {
    const ROW_E3 = '00000000-0000-4000-8000-e10000000003'
    const ROW_E4 = '00000000-0000-4000-8000-e10000000004'
    const server = seededServer({ fencing: EFencing.visibilityHorizon })

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'held open' }, 't1') // seq 1, in-flight ⇒ the hole
    server.setStep(2)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'committed a' }) // seq 2, committed
    server.setStep(3)
    upsert(server, ROW_E3, { done: false, owner_id: USER_A, title: 'committed b' }) // seq 3, committed
    server.setStep(4)
    upsert(server, ROW_E4, { done: false, owner_id: USER_A, title: 'committed c' }) // seq 4, committed
    server.setStep(5)
    // Three committed rows (seq 2, 3, 4) with limit 2 ⇒ a FULL keyset continuation page. The keyset cursor advances to last.seq = 3, but the in-flight hole (seq 1) is BELOW it and still open: the token must carry it ("0:3~1", the transfer started from the bootstrap) or the write is lost when it commits after the client persists the cursor.
    const page = server.pull(pullRequest('0', { limit: 2 }))

    expect(page.rows.map((row) => row.seq)).toEqual(['2', '3'])
    expect(page.has_more).toBe(true)
    expect(page.cursor).toBe('0:3~1')
    // Commit the hole: a pull from the persisted continuation cursor delivers seq 1. A bare "3" cursor strands the hole forever.
    server.commitTxn('t1')
    server.setStep(6)
    const filled = server.pull(pullRequest(page.cursor))

    expect(filled.rows.map((row) => row.seq)).toEqual(['1', '4'])
  })

  test('REFINED horizon: an exact fit is the final page, and has_more stays true while its cursor carries a hole', () => {
    const ROW_E3 = '00000000-0000-4000-8000-e10000000003'
    const server = seededServer({ fencing: EFencing.visibilityHorizon })

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'held open' }, 't1') // seq 1, in-flight ⇒ the hole
    server.setStep(2)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'committed a' }) // seq 2, committed
    server.setStep(3)
    upsert(server, ROW_E3, { done: false, owner_id: USER_A, title: 'committed b' }) // seq 3, committed
    server.setStep(4)
    // Two committed rows with limit 2 fit one page, so it carries the refined response cursor; the open hole alone keeps the checkpoint open.
    const page = server.pull(pullRequest('0', { limit: 2 }))

    expect(page.rows.map((row) => row.seq)).toEqual(['2', '3'])
    expect(page.has_more).toBe(true)
    expect(page.cursor).toBe('3~1')
    server.commitTxn('t1')
    server.setStep(5)
    const filled = server.pull(pullRequest(page.cursor, { limit: 2 }))

    expect(filled.rows.map((row) => row.seq)).toEqual(['1'])
    expect(filled.has_more).toBe(false)
    expect(filled.cursor).toBe('3')
  })

  test('refined horizon: the no-hole case yields a flat decimal cursor', () => {
    const server = seededServer({ fencing: EFencing.visibilityHorizon })

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'first' }) // seq 1, committed
    server.setStep(2)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'second' }) // seq 2, committed
    server.setStep(3)
    // With no transaction in flight there are no holes, so the cursor is the bare decimal "2" and the boundary closes, byte-identical to the flat token the SQL pack emits.
    const page = server.pull(pullRequest('0'))

    expect(page.cursor).toBe('2')
    expect(page.has_more).toBe(false)
    expect(page.rows.map((row) => row.seq)).toEqual(['1', '2'])
    expect(page.signal).toBeNull()
    expect(page.tombstones).toEqual([])
  })

})

// MARK: - Logical clock and lifecycle

describe('logical clock and reaping', () => {
  test('deleted_at derives from setStep (Logical timestamp grammar)', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'doomed' })
    server.pull(pullRequest('0'))
    server.setStep(7)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
    server.setStep(8)
    const page = server.pull(pullRequest('1'))

    expect(page.tombstones).toEqual([{ deleted_at: '2026-01-01T00:00:07.000Z', pk: ROW_E1, seq: '2', table: 'todos' }])
  })

  test('reap: CHECKPOINT_EXPIRED for 0 < cursor < reap_horizon, never for cursor 0', () => {
    const history: THistoryOp[] = [
      { op: 'upsert', table: 'todos', pk: ROW_E1, columns: { done: false, owner_id: USER_A, title: 'pre' } },
      { op: 'delete', table: 'todos', pk: ROW_E1 },
      { op: 'reap' },
      { op: 'upsert', table: 'todos', pk: ROW_E2, columns: { done: false, owner_id: USER_A, title: 'offline insert' } },
    ]
    const server = seededServer({ history })

    server.setStep(1)
    const expired = server.pull(pullRequest('1'))

    expect(expired).toEqual({ cursor: '1', has_more: false, rows: [], signal: { type: ESignalType.CHECKPOINT_EXPIRED }, tombstones: [] })
    // the token is invalidated, not advanced, and bootstrap is exempt
    const bootstrap = server.pull(pullRequest('0'))

    expect(bootstrap.signal).toBeNull()
    expect(bootstrap.cursor).toBe('3')
    expect(bootstrap.rows.map((row) => row.pk)).toEqual([ROW_E2])
    // a cursor at the horizon already applied the reaped delete: no signal
    expect(server.pull(pullRequest('2')).signal).toBeNull()
  })

  test('reap: expiry checks the start a continuation token carries, never its position (D-cursor-opaque-token)', () => {
    const history: THistoryOp[] = [
      { op: 'upsert', table: 'todos', pk: ROW_E1, columns: { done: false, owner_id: USER_A, title: 'pre' } },
      { op: 'delete', table: 'todos', pk: ROW_E1 },
      { op: 'reap' },
      { op: 'upsert', table: 'todos', pk: ROW_E2, columns: { done: false, owner_id: USER_A, title: 'offline insert' } },
    ]
    const server = seededServer({ history })

    server.setStep(1)
    // A transfer from the bootstrap runs to completion even though its position 1 is below the reap horizon 2.
    const fromBootstrap = server.pull(pullRequest('0:1'))

    expect(fromBootstrap.signal).toBeNull()
    expect(fromBootstrap.cursor).toBe('3')
    expect(fromBootstrap.rows.map((row) => row.pk)).toEqual([ROW_E2])
    // A transfer from checkpoint 1 expires once the horizon passes it, whatever its position, and the signal echoes the token.
    expect(server.pull(pullRequest('1:3'))).toEqual({ cursor: '1:3', has_more: false, rows: [], signal: { type: ESignalType.CHECKPOINT_EXPIRED }, tombstones: [] })
    // A transfer from a checkpoint at the horizon is still whole.
    expect(server.pull(pullRequest('2:3')).signal).toBeNull()
  })

  test('a reap change raises the horizon to the highest reaped seq and expires the transfers it passes', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'doomed' }) // seq 1
    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 }) // seq 2
    server.setStep(3)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'kept' }) // seq 3
    expect(server.pull(pullRequest('1:2')).signal).toBeNull()
    server.applyServerChange({ op: 'reap' })
    expect(server.pull(pullRequest('1:2')).signal).toEqual({ type: ESignalType.CHECKPOINT_EXPIRED })
    // The horizon is 2, the highest reaped seq, so a checkpoint at it stays whole.
    expect(server.pull(pullRequest('2')).signal).toBeNull()
  })

  test('continuation pages from a checkpoint carry that checkpoint as their start, and the final page carries none', () => {
    const ROW_E3 = '00000000-0000-4000-8000-e10000000003'
    const ROW_E4 = '00000000-0000-4000-8000-e10000000004'
    const server = seededServer()

    for (const [index, pk] of [ROW_E1, ROW_E2, ROW_E3, ROW_E4].entries()) {
      server.setStep(index + 1)
      upsert(server, pk, { done: false, owner_id: USER_A, title: `row ${index + 1}` })
    }
    server.setStep(5)
    const first = server.pull(pullRequest('1', { limit: 1 }))
    const second = server.pull(pullRequest(first.cursor, { limit: 1 }))
    const third = server.pull(pullRequest(second.cursor, { limit: 1 }))

    expect([first, second, third].map((page) => [page.cursor, page.has_more])).toEqual([['1:2', true], ['1:3', true], ['4', false]])
  })

  test('RESET_REQUIRED gates everything and echoes the cursor (lifecycle/002)', () => {
    const server = seededServer({ min_schema_version: 2 })
    const page = server.pull(pullRequest('0'))

    expect(page).toEqual({ cursor: '0', has_more: false, rows: [], signal: { type: ESignalType.RESET_REQUIRED }, tombstones: [] })
  })
})

// MARK: - Golden-byte self-probe

// Minimal transcript shape for the probe (full validation is the harness's job)
type TProbeStep = {
  kind: string
  n: number
  rpc?: 'pull' | 'push'
  request?: unknown
  response?: unknown
  fault?: string
  target?: 'pull' | 'push'
  actor?: string
  op?: 'upsert' | 'delete' | 'reap'
  table?: string
  pk?: string
  columns?: TColumnValues
  hlc?: string
}
type TProbeTranscript = {
  case: string
  fencing: string
  context: {
    client_id: string
    user_id: string
    server: { min_schema_version: number; tables: Record<string, { bucket_column: string; conflict_mode?: 'arrival' | 'hlc' }>; tombstone_ttl_days: number; max_pull_scan?: number }
  }
  steps: TProbeStep[]
}

const runProbe = (transcript: TProbeTranscript, fencing: TFencing): string[] => {
  const failures: string[] = []
  const scenario: TScenario = SCENARIOS[transcript.case] ?? {}
  const held = scenario.held_txns ?? []
  const server: IProtocolServer = makeReferenceServer()

  server.seed({
    client_id: transcript.context.client_id,
    user_id: transcript.context.user_id,
    min_schema_version: transcript.context.server.min_schema_version,
    tables: transcript.context.server.tables,
    tombstone_ttl_days: transcript.context.server.tombstone_ttl_days,
    max_pull_scan: transcript.context.server.max_pull_scan,
    fencing,
    next_seq: scenario.next_seq ?? '1',
    history: scenario.history ?? [],
  })

  for (const step of transcript.steps) {
    server.setStep(step.n)

    if (step.kind === 'server' && step.op === 'reap') {
      server.applyServerChange({ op: 'reap' })
    } else if (step.kind === 'server') {
      server.applyServerChange({
        actor: step.actor ?? '',
        op: step.op === 'delete' ? 'delete' : 'upsert',
        table: step.table ?? '',
        pk: step.pk ?? '',
        columns: step.columns,
        hlc: step.hlc,
        txn: held.find((txn) => txn.step === step.n)?.txn,
      })
    } else if (step.kind === 'rpc') {
      const actual: unknown = step.rpc === 'pull' ? server.pull(step.request as TPullRequest) : server.push(step.request as TPushRequest)
      const expected = canonicalize(step.response)
      const got = canonicalize(actual)

      if (got !== expected) {
        failures.push(`step ${step.n} (${step.rpc ?? 'rpc'}): response diverges from the golden bytes\nexpected ${expected}actual ${got}`)
      }
    } else if (step.kind === 'fault' && step.fault === 'drop-ack') {
      // the server applied, the ack was lost (push/003 step 3)
      if (step.target === 'pull') {
        void server.pull(step.request as TPullRequest)
      } else {
        void server.push(step.request as TPushRequest)
      }
    }
    // transport-error: never applied, no invocation. local/assert: client-side.
    for (const txn of held) {
      if (txn.commit_after_step === step.n) {
        server.commitTxn(txn.txn)
      }
    }
  }
  return failures
}

describe('bucket-scoped tombstones', () => {
  test('empty params on a bucketed table are refused (the pull policy the pack raises KZL01 for)', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'tenant-a row' })
    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
    expect(() => server.pull(pullRequest('0', { buckets: [{ params: {}, table: 'todos' }] }))).toThrow(
      'pull: table "todos" is bucketed on "owner_id": the pull bucket must name that column (fail loud)',
    )
  })

  test('an unbucketed table accepts empty params, and its table-scoped tombstone waits for a grant', () => {
    const server = seededServer({ tables: { todos: { bucket_column: '' } } })

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'shared row' })
    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
    const page = server.pull(pullRequest('0', { buckets: [{ params: {}, table: 'todos' }] }))

    // The oracle's RLS analog compares the bucket column with the subject, so no row of an unbucketed table reaches it and it earns no grant; the live SQL lane covers the granted case.
    expect(page.tombstones).toEqual([])
    expect(page.cursor).toBe('2')
  })

  test('an inflight bucket move then delete leaves the old bucket the move-out tombstone, and the new bucket, which never delivered the row, nothing', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'a' })
    server.pull(pullRequest('0'))
    server.setStep(2)
    upsert(server, ROW_E1, { done: false, owner_id: USER_B, title: 'b' }, 'txn-1')
    server.setStep(3)
    server.applyServerChange({
      actor: ACTOR,
      op: 'delete',
      table: 'todos',
      pk: ROW_E1,
      txn: 'txn-1',
    })
    server.commitTxn('txn-1')
    const alice = server.pull(pullRequest('0'))
    const bob = server.pull(
      pullRequest('0', { buckets: [{ params: { owner_id: USER_B }, table: 'todos' }] }),
    )

    expect(alice.tombstones.map(({ pk, seq }) => ({ pk, seq }))).toEqual([{ pk: ROW_E1, seq: '2' }])
    expect(bob.tombstones).toEqual([])
  })
})

describe('golden-byte self-probe (reference vs corpus transcripts)', () => {
  const corpus = loadCorpus(join(import.meta.dir, '..'))

  for (const [path, entry] of corpus.transcripts) {
    const transcript = entry.json as TProbeTranscript
    // Every transcript runs under the visibility horizon (D-visibility-horizon); shared bytes do not read the fencing value (I-4, P:keyset-pagination-and-delivery-bound).
    const fencing = EFencing.visibilityHorizon

    test(`${path} [${fencing}]`, () => {
      expect(runProbe(transcript, fencing)).toEqual([])
    })
  }
})

// MARK: - Pull pagination corner

describe('keyset pagination', () => {
  test('a continuation page carries the first limit entries under the keyset cursor; the final page closes the boundary', () => {
    const server = seededServer()

    for (const [index, pk] of [ROW_E1, ROW_E2, '00000000-0000-4000-8000-e10000000003'].entries()) {
      server.setStep(index + 1)
      upsert(server, pk, { done: false, owner_id: USER_A, title: `row ${index + 1}` })
    }
    server.setStep(4)
    const first = server.pull(pullRequest('0', { limit: 2 }))

    expect(first.has_more).toBe(true)
    expect(first.cursor).toBe('0:2')
    expect(first.rows.map((row) => row.seq)).toEqual(['1', '2'])
    expect(first.tombstones).toEqual([])
    server.setStep(5)
    const second = server.pull(pullRequest(first.cursor, { limit: 2 }))

    expect(second.has_more).toBe(false)
    expect(second.cursor).toBe('3')
    expect(second.rows.map((row) => row.seq)).toEqual(['3'])
  })

  test('a tombstone that leads the stream rides the continuation page with the first row', () => {
    const ROW_E3 = '00000000-0000-4000-8000-e10000000003'
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'doomed' }) // seq 1
    server.pull(pullRequest('0'))
    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 }) // seq 2: the tombstone leads the stream
    server.setStep(3)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'row two' }) // seq 3
    server.setStep(4)
    upsert(server, ROW_E3, { done: false, owner_id: USER_A, title: 'row three' }) // seq 4
    server.setStep(5)
    const first = server.pull(pullRequest('0', { limit: 2 }))

    expect(first.tombstones.map((tombstone) => tombstone.seq)).toEqual(['2'])
    expect(first.rows.map((row) => row.seq)).toEqual(['3'])
    expect(first.has_more).toBe(true)
    expect(first.cursor).toBe('0:3')
    const second = server.pull(pullRequest(first.cursor, { limit: 2 }))

    expect(second.tombstones).toEqual([])
    expect(second.rows.map((row) => row.seq)).toEqual(['4'])
    expect(second.has_more).toBe(false)
    expect(second.cursor).toBe('4')
  })

  test('an exact fit closes the checkpoint in one page', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'row one' }) // seq 1
    server.setStep(2)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'row two' }) // seq 2
    server.setStep(3)
    const page = server.pull(pullRequest('0', { limit: 2 }))

    expect(page.rows.map((row) => row.seq)).toEqual(['1', '2'])
    expect(page.has_more).toBe(false)
    expect(page.cursor).toBe('2')
  })

  test('limit 1 drains a mixed stream one entry per page, in stream order', () => {
    const ROW_E3 = '00000000-0000-4000-8000-e10000000003'
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'row one' }) // seq 1
    server.setStep(2)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'row two' }) // seq 2
    server.pull(pullRequest('0'))
    server.setStep(3)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 }) // seq 3
    server.setStep(4)
    upsert(server, ROW_E3, { done: false, owner_id: USER_A, title: 'row three' }) // seq 4
    server.setStep(5)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E2 }) // seq 5
    server.setStep(6)
    const first = server.pull(pullRequest('0', { limit: 1 }))
    const second = server.pull(pullRequest(first.cursor, { limit: 1 }))
    const third = server.pull(pullRequest(second.cursor, { limit: 1 }))
    const pages = [first, second, third].map((page) => ({
      cursor: page.cursor,
      has_more: page.has_more,
      rows: page.rows.map((row) => row.seq),
      tombstones: page.tombstones.map((tombstone) => tombstone.seq),
    }))

    expect(pages).toEqual([
      { cursor: '0:3', has_more: true, rows: [], tombstones: ['3'] },
      { cursor: '0:4', has_more: true, rows: ['4'], tombstones: [] },
      { cursor: '5', has_more: false, rows: [], tombstones: ['5'] },
    ])
  })
})

/** The SQLSTATE and message a refused pull throws, or null when the pull answers. */
const pullRefusal = (server: IProtocolServer, request: TPullRequest): { code: unknown; message: string } | null => {
  try {
    server.pull(request)
  } catch (error) {
    return { code: error instanceof Error && 'code' in error ? error.code : undefined, message: error instanceof Error ? error.message : String(error) }
  }
  return null
}

describe('page limit', () => {
  test('a limit below 1 is refused with SQLSTATE 22023 before any gate runs, like the pack', () => {
    // A stale schema would answer RESET_REQUIRED and an unscoped bucket would raise the pull policy, so only a refusal that runs first surfaces here.
    const server = seededServer({ min_schema_version: 2 })

    for (const limit of [0, -1]) {
      expect(pullRefusal(server, pullRequest('0', { buckets: [{ params: {}, table: 'todos' }], limit })), `limit ${limit}`).toEqual({
        code: '22023',
        message: 'kizunasync.pull(): limit must be at least 1',
      })
    }
  })

  test('a null limit pages at the default of 500', () => {
    const server = seededServer()

    for (let index = 1; index <= 501; index += 1) {
      upsert(server, `00000000-0000-4000-8000-e1${String(index).padStart(10, '0')}`, { done: false, owner_id: USER_A, title: `row ${index}` })
    }
    // The wire type has no null limit, but the pack reads one as its default, so the oracle must too.
    const page = server.pull({ ...pullRequest('0'), limit: null } as unknown as TPullRequest)

    expect({ has_more: page.has_more, entries: page.rows.length + page.tombstones.length }).toEqual({ has_more: true, entries: 500 })
  })
})

// MARK: - Bucket move-out

const rowPk = (index: number): string => `00000000-0000-4000-8000-e1${String(index).padStart(10, '0')}`
const summarize = (page: TPullResponse): { cursor: string; has_more: boolean; rows: string[]; tombstones: string[] } => ({
  cursor: page.cursor,
  has_more: page.has_more,
  rows: page.rows.map((row) => `${row.pk}@${row.seq}`),
  tombstones: page.tombstones.map((tombstone) => `${tombstone.pk}@${tombstone.seq}`),
})

describe('bucket move-out (D-bucket-move-out)', () => {
  test('a write that moves a row to another bucket stamps the old bucket a tombstone first, and only a pull of that bucket receives it', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'moving' })
    server.pull(pullRequest('0'))
    server.setStep(2)
    upsert(server, ROW_E1, { owner_id: USER_B })

    expect(summarize(server.pull(pullRequest('0')))).toEqual({ cursor: '3', has_more: false, rows: [], tombstones: [`${ROW_E1}@2`] })
    expect(summarize(server.pull(pullRequest('0', { buckets: [{ params: { owner_id: USER_B }, table: 'todos' }] })))).toEqual({
      cursor: '3',
      has_more: false,
      rows: [],
      tombstones: [],
    })
  })

  test('a move-out is no delete: a push to the moved row is decided like any other', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'moving' })
    server.setStep(2)
    upsert(server, ROW_E1, { owner_id: USER_B })
    server.setStep(3)
    const away = pushOne(server, { columns: { title: 'mine?' }, mutation_id: MUT_1, op: 'update', pk: ROW_E1, table: 'todos' })

    server.setStep(4)
    upsert(server, ROW_E1, { owner_id: USER_A })
    server.setStep(5)
    const home = pushOne(server, { columns: { title: 'mine again' }, mutation_id: MUT_2, op: 'update', pk: ROW_E1, table: 'todos' })

    expect({ verdict: away.verdict, reason: 'reason' in away ? away.reason : null }).toEqual({ verdict: 'rejected', reason: 'RLS_DENIED' })
    expect(home.verdict).toBe('applied')
  })

  test('a move-out and a later delete keep one tombstone each, and the delete wins only for a member who received the row where it was deleted', () => {
    // The oracle holds one subject, so each bucket's member replays the same history on a server of its own, pulling its own bucket after every change.
    const replay = (subject: string): { tombstones: string[]; reason: string | null } => {
      const server = seededServer({ user_id: subject })
      const own = pullRequest('0', { buckets: [{ params: { owner_id: subject }, table: 'todos' }] })

      server.setStep(1)
      upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'moving' })
      server.pull(own)
      server.setStep(2)
      upsert(server, ROW_E1, { owner_id: USER_B })
      server.pull(own)
      server.setStep(3)
      server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
      server.setStep(4)
      const verdict = pushOne(server, { columns: { title: 'too late' }, mutation_id: MUT_1, op: 'update', pk: ROW_E1, table: 'todos' })

      return { tombstones: summarize(server.pull(own)).tombstones, reason: 'reason' in verdict ? verdict.reason : null }
    }

    expect(replay(USER_A)).toEqual({ tombstones: [`${ROW_E1}@2`], reason: 'RLS_DENIED' })
    expect(replay(USER_B)).toEqual({ tombstones: [`${ROW_E1}@4`], reason: 'DELETE_WINS' })
  })
})

// MARK: - Tombstone delivery

describe('tombstone delivery (D-tombstone-delivery)', () => {
  test('a pull carries the tombstones of a bucket value only after one of its pulls delivered a live row of it', () => {
    const server = seededServer()

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'gone before any pull' })
    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
    const first = server.pull(pullRequest('0'))

    server.setStep(3)
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'seen' })
    const second = server.pull(pullRequest(first.cursor))

    server.setStep(4)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E2 })

    expect([summarize(first), summarize(second), summarize(server.pull(pullRequest(second.cursor)))]).toEqual([
      { cursor: '2', has_more: false, rows: [], tombstones: [] },
      { cursor: '3', has_more: false, rows: [`${ROW_E2}@3`], tombstones: [] },
      { cursor: '4', has_more: false, rows: [], tombstones: [`${ROW_E2}@4`] },
    ])
  })

  test('a bucket that names extra params receives deletes, since tombstones match the bucket column alone', () => {
    const server = seededServer()
    const openBucket = [{ params: { owner_id: USER_A, title: 'open' }, table: 'todos' }]

    server.setStep(1)
    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'open' })
    const first = server.pull(pullRequest('0', { buckets: openBucket }))

    server.setStep(2)
    server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })

    expect(summarize(first).rows).toEqual([`${ROW_E1}@1`])
    expect(summarize(server.pull(pullRequest(first.cursor, { buckets: openBucket }))).tombstones).toEqual([`${ROW_E1}@2`])
  })

  test('a recreated row the subject can see rides as a row and withholds its tombstone, and one it cannot see leaves the tombstone', () => {
    const recreate = (owner: string): { rows: string[]; tombstones: string[] } => {
      const server = seededServer()

      server.setStep(1)
      upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'first life' })
      const first = server.pull(pullRequest('0'))

      server.setStep(2)
      server.applyServerChange({ actor: ACTOR, op: 'delete', table: 'todos', pk: ROW_E1 })
      server.setStep(3)
      upsert(server, ROW_E1, { done: false, owner_id: owner, title: 'second life' })
      const { rows, tombstones } = summarize(server.pull(pullRequest(first.cursor)))

      return { rows, tombstones }
    }

    expect(recreate(USER_A)).toEqual({ rows: [`${ROW_E1}@3`], tombstones: [] })
    expect(recreate(USER_B)).toEqual({ rows: [], tombstones: [`${ROW_E1}@2`] })
  })
})

// MARK: - Scan cap

describe('pull scan cap (D-page-cap-and-checkpoint-boundary)', () => {
  const keptBucket = [{ params: { owner_id: USER_A, title: 'kept' }, table: 'todos' }]

  test('a page stops after max_pull_scan candidates, withheld rows included, and continues from the last one it examined', () => {
    const server = seededServer({ max_pull_scan: 2 })

    for (const [index, title] of ['skip', 'skip', 'kept'].entries()) {
      server.setStep(index + 1)
      upsert(server, rowPk(index + 1), { done: false, owner_id: USER_A, title })
    }
    const first = server.pull(pullRequest('0', { buckets: keptBucket, limit: 10 }))
    const second = server.pull(pullRequest(first.cursor, { buckets: keptBucket, limit: 10 }))

    expect([summarize(first), summarize(second)]).toEqual([
      { cursor: '0:2', has_more: true, rows: [], tombstones: [] },
      { cursor: '3', has_more: false, rows: [`${rowPk(3)}@3`], tombstones: [] },
    ])
  })

  test('a stream that ends exactly at the cap closes the checkpoint', () => {
    const server = seededServer({ max_pull_scan: 2 })

    upsert(server, ROW_E1, { done: false, owner_id: USER_A, title: 'one' })
    upsert(server, ROW_E2, { done: false, owner_id: USER_A, title: 'two' })

    expect(summarize(server.pull(pullRequest('0')))).toEqual({ cursor: '2', has_more: false, rows: [`${ROW_E1}@1`, `${ROW_E2}@2`], tombstones: [] })
  })

  test('another bucket value never counts against the cap: a bucketed pull reads only the entries labeled with a value it requests', () => {
    const server = seededServer({ max_pull_scan: 1 })

    for (let index = 1; index <= 3; index += 1) {
      upsert(server, rowPk(index), { done: false, owner_id: USER_B, title: `theirs ${index}` })
    }
    upsert(server, rowPk(4), { done: false, owner_id: USER_A, title: 'mine' })

    expect(summarize(server.pull(pullRequest('0')))).toEqual({ cursor: '4', has_more: false, rows: [`${rowPk(4)}@4`], tombstones: [] })
  })

  test(`a pull that names more than ${MAX_PULL_BUCKETS} bucket entries is refused with SQLSTATE 22023, like the pack`, () => {
    const server = seededServer()
    const buckets = (count: number): TPullRequest['buckets'] => Array.from({ length: count }, () => ({ params: { owner_id: USER_A }, table: 'todos' }))

    expect(pullRefusal(server, pullRequest('0', { buckets: buckets(MAX_PULL_BUCKETS + 1) }))).toEqual({
      code: '22023',
      message: `kizunasync.pull(): a pull names at most ${MAX_PULL_BUCKETS} bucket entries`,
    })
    expect(pullRefusal(server, pullRequest('0', { buckets: buckets(MAX_PULL_BUCKETS) }))).toBeNull()
  })
})

// MARK: - Row keys (D-row-key)

describe('row keys (D-row-key)', () => {
  const SEATS = { seats: { bucket_column: 'owner_id', key_columns: ['hall', 'seat'] } }
  const NOTICES = { notices: { bucket_column: 'owner_id', key_columns: ['id'] } }
  const seatPk = (hall: string, seat: string): string => `[${JSON.stringify(hall)}, ${JSON.stringify(seat)}]`
  const seatsServer = (): IProtocolServer => seededServer({ tables: { ...SEATS } })

  const refusalOf = (server: IProtocolServer, pk: unknown): { code?: unknown; message: string } | null => {
    try {
      server.push({
        batch: { atomic: false, mutations: [{ columns: { holder: 'ada' }, mutation_id: MUT_1, op: 'update', pk: pk as string, table: 'seats' }] },
        last_mutation_id: null,
        schema_version: 1,
      })

      return null
    } catch (error) {
      return { code: (error as { code?: unknown }).code, message: error instanceof Error ? error.message : String(error) }
    }
  }

  test('an insert applies when its key columns spell the pk, as numbers or as strings', () => {
    const server = seatsServer()

    server.setStep(1)
    const numbers = pushOne(server, { columns: { hall: 1, holder: 'ada', owner_id: USER_A, seat: 12 }, mutation_id: MUT_1, op: 'insert', pk: seatPk('1', '12'), table: 'seats' })
    const strings = pushOne(server, { columns: { hall: '1', holder: 'grace', owner_id: USER_A, seat: '13' }, mutation_id: MUT_2, op: 'insert', pk: seatPk('1', '13'), table: 'seats' })

    expect([numbers.verdict, strings.verdict]).toEqual(['applied', 'applied'])
    server.setStep(2)
    expect(server.pull(pullRequest('0', { buckets: [{ params: { owner_id: USER_A }, table: 'seats' }] })).rows.map((row) => row.pk)).toEqual([
      seatPk('1', '12'),
      seatPk('1', '13'),
    ])
  })

  test('an insert whose key column disagrees with the pk is CONSTRAINT and leaves no row', () => {
    const server = seatsServer()

    server.setStep(1)
    const verdict = pushOne(server, { columns: { hall: 1, holder: 'linus', owner_id: USER_A, seat: 14 }, mutation_id: MUT_1, op: 'insert', pk: seatPk('1', '13'), table: 'seats' })

    expect(verdict).toEqual({ mutation_id: MUT_1, reason: 'CONSTRAINT', server_row: null, verdict: 'rejected' })
    server.setStep(2)
    expect(server.pull(pullRequest('0', { buckets: [{ params: { owner_id: USER_A }, table: 'seats' }] })).rows).toEqual([])
  })

  test('an update that names a key column, as a column or a transform, is COLUMN_DENIED with the row the subject sees', () => {
    const server = seatsServer()
    const pk = seatPk('1', '12')

    server.setStep(1)
    pushOne(server, { columns: { hall: 1, holder: 'ada', owner_id: USER_A, seat: 12 }, mutation_id: MUT_1, op: 'insert', pk, table: 'seats' })
    server.setStep(2)
    const column = pushOne(server, { columns: { holder: 'grace', seat: 15 }, mutation_id: MUT_2, op: 'update', pk, table: 'seats' })
    const transform = pushOne(server, { columns: {}, mutation_id: '00000000-0000-4000-8000-f10000000003', op: 'update', pk, table: 'seats', transforms: { seat: { by: 1, op: 'increment' } } })
    const row = { hall: 1, holder: 'ada', owner_id: USER_A, seat: 12 }

    expect(column).toEqual({ mutation_id: MUT_2, reason: 'COLUMN_DENIED', server_row: row, verdict: 'rejected' })
    expect(transform).toEqual({ mutation_id: '00000000-0000-4000-8000-f10000000003', reason: 'COLUMN_DENIED', server_row: row, verdict: 'rejected' })
  })

  test('a pk that is not the key shape refuses the push with 22023 before any mutation', () => {
    const server = seatsServer()

    expect(refusalOf(server, '')?.code).toBe('22023')
    expect(refusalOf(server, '["1"]')?.code).toBe('22023')
    expect(refusalOf(server, '[1, "12"]')?.code).toBe('22023')
    expect(refusalOf(server, '1,12')?.code).toBe('22023')
    expect(refusalOf(server, seatPk('1', '12'))).toBeNull()
  })

  test('an integer-keyed row travels under its decimal pk, in seq order rather than pk order', () => {
    const server = seededServer({ tables: { ...NOTICES } })

    for (const [step, id] of [[1, 7], [2, 10], [3, 9]] as const) {
      server.setStep(step)
      server.applyServerChange({ actor: ACTOR, columns: { body: `notice ${id}`, id, owner_id: USER_A }, op: 'upsert', pk: String(id), table: 'notices' })
    }
    server.setStep(4)
    const page = server.pull(pullRequest('0', { buckets: [{ params: { owner_id: USER_A }, table: 'notices' }] }))

    expect(page.rows.map((row) => [row.seq, row.pk])).toEqual([
      ['1', '7'],
      ['2', '10'],
      ['3', '9'],
    ])
  })
})
