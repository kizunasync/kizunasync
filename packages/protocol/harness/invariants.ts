/**
 * Cross-case invariants I-3..I-12.
 *
 * Structural invariants over parsed transcripts and the manifest. This module
 * validates shape and cross-file discipline; executable behavior lives in the
 * TypeScript reference executor and the Rust client conformance runner.
 *
 * I-1 (canonical bytes) lives in canonical.ts; I-2 (schema validity) is
 * wired in validate.test.ts. Registry-dependent halves of I-6/I-7 are the
 * extra exports at the bottom (fixtures and the decision registry are separate
 * files, loaded by validate.test.ts).
 */

import { compareUtf8 } from './canonical'
import type { TValidationIssue } from './ajv-validate'
import { CURSOR_TOKEN, parseCursorToken } from '../spec/cursor-token'
import type { TCursorToken } from '../spec/cursor-token'
import { DEFAULT_PAGE_LIMIT } from '../spec/limits'

// MARK: - Types

type TJsonObject = Record<string, unknown>

type TCorpusEntry = { raw: string; json: unknown }

// MARK: - Closed unions

const E_FENCING = ['visibility-horizon', 'shared'] as const
const E_STATUS = ['decided', 'normative', 'open-decision', 'proposed'] as const
const E_PRIORITY = ['P0', 'P1', 'P2'] as const
const E_STEP_KIND = ['assert', 'fault', 'local', 'rpc', 'server'] as const

// MARK: - Placeholder grammars

const GENERIC_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const PLACEHOLDER_UUID = /^00000000-0000-4000-8000-(a1|c1|e1|f1)\d{10}$/
const PLACEHOLDER_KIND_BY_CODE = {
  a1: 'user',
  c1: 'client',
  e1: 'row',
  f1: 'mutation',
} as const
const GENERIC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:/
const PLACEHOLDER_TIMESTAMP = /^2026-01-01T00:00:[0-5]\d\.000Z$/
const SEQ_OR_CURSOR = /^(0|[1-9][0-9]*)$/
/**
 * Origin HLC grammar (hlc-mode tables, conflict/003): a logical-timestamp
 * fixture, '|', a non-negative logical counter, '|', a placeholder client uuid.
 * ISO-8601 sorts chronologically, so compareHlc orders <iso> lexicographically,
 * then <logical> numerically, then <node> byte-wise (a total order). For
 * arrival-mode tables hlc is forensic-only; for hlc-mode tables it is the
 * per-column ordering key (P:verdict-completeness-transforms-and-conflict-rejection).
 */
const PLACEHOLDER_HLC =
  /^2026-01-01T00:00:[0-5]\d\.000Z\|(0|[1-9][0-9]*)\|00000000-0000-4000-8000-(a1|c1|e1|f1)\d{10}$/
const KEY_PATTERN = /^[a-z0-9_]+$/

/**
 * I-7: authority refs only. Prefixes `SQL:`, `CONV:`, `P:`, `A:`, `DR:`, `DX:`,
 * and `AT:` carry a lowercase-hyphen slug. `D-` is a decision id
 * (`D-<kebab-slug>`). No cite addresses a source line.
 */
export const CITE_PREFIXES = ['SQL:', 'CONV:', 'P:', 'A:', 'DR:', 'DX:', 'AT:', 'D-'] as const
export const CITE_PATTERN =
  /^((SQL:|CONV:|P:|A:|DR:|DX:|AT:)[a-z][a-z0-9]*(-[a-z0-9]+)*$|D-[a-z][a-z0-9]*(-[a-z0-9]+)*$)/
export const CITE_TOKEN = /(?:SQL:|CONV:|P:|A:|DR:|DX:|AT:)[a-z][a-z0-9-]*|D-[a-z][a-z0-9-]+/g
const OPEN_DECISION_PATTERN = /^D-[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// MARK: - Guards

const isObject = (value: unknown): value is TJsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asObject = (value: unknown): TJsonObject | null => (isObject(value) ? value : null)

const inUnion = (value: unknown, union: readonly string[]): boolean =>
  typeof value === 'string' && union.includes(value)

const parseSeq = (value: unknown): bigint | null =>
  typeof value === 'string' && SEQ_OR_CURSOR.test(value) ? BigInt(value) : null

/**
 * D-cursor-opaque-token: decode a cursor token through the spec codec.
 * Returns null when the value is not a canonical wire token.
 */
const parseCursor = (value: unknown): TCursorToken | null =>
  typeof value === 'string' ? parseCursorToken(value) : null

function parseHighWater(value: unknown): bigint | null {
  return parseCursor(value)?.highWater ?? null
}

// MARK: - Top-level shape

const REQUIRED_TOP_LEVEL = [
  'case',
  'cites',
  'context',
  'fencing',
  'postconditions',
  'priority',
  'status',
  'steps',
  'title',
]

const checkTopLevel = (t: TJsonObject, issues: TValidationIssue[]): void => {
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in t)) {
      issues.push({ path: '', message: `missing top-level field "${key}"` })
    }
  }
  if (!inUnion(t.fencing, E_FENCING)) {
    issues.push({ path: '/fencing', message: `expected one of ${E_FENCING.join('|')}` })
  }
  if (!inUnion(t.status, E_STATUS)) {
    issues.push({ path: '/status', message: `expected one of ${E_STATUS.join('|')}` })
  }
  if (!inUnion(t.priority, E_PRIORITY)) {
    issues.push({ path: '/priority', message: `expected one of ${E_PRIORITY.join('|')}` })
  }
  // I-7 citation discipline (grammar half; registry half is checkOpenDecisionRefs)
  const cites = asArray(t.cites)

  if (!Array.isArray(t.cites) || cites.length === 0) {
    issues.push({ path: '/cites', message: 'cites must be a non-empty array (I-7)' })
  }
  cites.forEach((cite, index) => {
    if (typeof cite !== 'string' || !CITE_PATTERN.test(cite)) {
      issues.push({ path: `/cites/${index}`, message: 'citation does not match the authority grammar (I-7)' })
    }
  })
}

// MARK: - Placeholder discipline

/** One node of the placeholder walk: its value, the key it sits under (null for the root and array items), its path, and the two accumulators. */
type TPlaceholderWalk = { value: unknown; key: string | null; path: string; deletedAt: string[]; issues: TValidationIssue[] }

function checkKeyedGrammars(value: string, { key, path, deletedAt, issues }: TPlaceholderWalk): void {
  // seq stays STRICTLY decimal; cursor accepts every token form (optional start, decimal high-water, optional holes), of which the flat decimal is the simplest.
  if (key === 'seq' && !SEQ_OR_CURSOR.test(value)) {
    issues.push({ path, message: `seq must match the decimal-string grammar: ${value}` })
  }
  if (key === 'cursor' && !CURSOR_TOKEN.test(value)) {
    issues.push({ path, message: `cursor must match the cursor-token grammar (optional <start>: prefix, decimal high-water, optional ~holes): ${value}` })
  }
  if (key === 'deleted_at') {
    deletedAt.push(value)
  }
}

function checkPlaceholderString(value: string, walk: TPlaceholderWalk): void {
  const { key, path, issues } = walk

  // Origin HLC ("<iso>|<logical>|<node>"): validated whole against the origin HLC grammar and returned before the UUID and timestamp checks, which would otherwise mis-flag the leading timestamp and the embedded node uuid that are intentionally not bare scalars here.
  if (key === 'hlc') {
    if (!PLACEHOLDER_HLC.test(value)) {
      issues.push({ path, message: `hlc does not match the origin HLC grammar: ${value}` })
    }
    return
  }
  if (GENERIC_UUID.test(value) && !PLACEHOLDER_UUID.test(value)) {
    issues.push({ path, message: `UUID does not match the UUID placeholder grammar: ${value}` })
  }
  if (GENERIC_TIMESTAMP.test(value) && !PLACEHOLDER_TIMESTAMP.test(value)) {
    issues.push({ path, message: `timestamp does not match the logical timestamp grammar: ${value}` })
  }
  checkKeyedGrammars(value, walk)
}

const walkPlaceholders = (walk: TPlaceholderWalk): void => {
  const { value, path } = walk

  if (typeof value === 'string') {
    checkPlaceholderString(value, walk)

    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkPlaceholders({ ...walk, value: item, key: null, path: `${path}/${index}` })
    })

    return
  }
  if (isObject(value)) {
    for (const [name, item] of Object.entries(value)) {
      if (!KEY_PATTERN.test(name)) {
        walk.issues.push({ path: `${path}/${name}`, message: 'object keys must match ^[a-z0-9_]+$ (C-2)' })
      }
      walkPlaceholders({ ...walk, value: item, key: name, path: `${path}/${name}` })
    }
  }
}

const checkPlaceholders = (t: TJsonObject, issues: TValidationIssue[]): void => {
  const deletedAt: string[] = []

  walkPlaceholders({ value: t, key: null, path: '', deletedAt, issues })
  // Logical timestamp grammar: server-assigned timestamps strictly increase per transcript. Compared on first appearance so a re-delivered tombstone (a committed hole re-scanned by the refined horizon, D-visibility-horizon) repeating an already-seen value stays legal.
  const firstSeen: string[] = []

  for (const value of deletedAt) {
    if (!firstSeen.includes(value)) {
      firstSeen.push(value)
    }
  }
  for (let i = 1; i < firstSeen.length; i += 1) {
    const previous = firstSeen[i - 1] ?? ''
    const current = firstSeen[i] ?? ''

    if (!(current > previous)) {
      issues.push({
        path: '',
        message: `deleted_at values must strictly increase per transcript (Logical timestamp grammar): ${previous} then ${current}`,
      })
    }
  }
}

// MARK: - Step numbering

const checkStepNumbering = (steps: unknown[], issues: TValidationIssue[]): void => {
  steps.forEach((raw, index) => {
    const step = asObject(raw)

    if (step === null) {
      issues.push({ path: `/steps/${index}`, message: 'step must be an object' })

      return
    }
    if (!inUnion(step.kind, E_STEP_KIND)) {
      issues.push({ path: `/steps/${index}/kind`, message: `expected one of ${E_STEP_KIND.join('|')}` })
    }
    if (step.n !== index + 1) {
      issues.push({ path: `/steps/${index}/n`, message: `expected n=${index + 1} (1-based, dense)` })
    }
  })
}

// MARK: - Step accessors

const pullSteps = (steps: unknown[]): { index: number; request: TJsonObject; response: TJsonObject }[] => {
  const out: { index: number; request: TJsonObject; response: TJsonObject }[] = []

  steps.forEach((raw, index) => {
    const step = asObject(raw)

    if (step !== null && step.kind === 'rpc' && step.rpc === 'pull') {
      const request = asObject(step.request)
      const response = asObject(step.response)

      if (request !== null && response !== null) {
        out.push({ index, request, response })
      }
    }
  })

  return out
}

// MARK: - I-3 cursor monotonicity, checkpoint boundary, rebase

/** The I-3 facts one step hands to the next, and the issue sink. */
type TCursorDiscipline = {
  issues: TValidationIssue[]
  lastResponseCursor: bigint | null
  assertedCursor: string | null
  boundarySinceAssert: boolean
}

type TCursorSite = { path: string; step: TJsonObject }

function trackPullCursor(state: TCursorDiscipline, { path, step }: TCursorSite): void {
  const response = asObject(step.response)
  // Monotonicity compares the HIGH-WATER mark of the cursor token (D-cursor-opaque-token): a composite cursor "6~5" has high-water 6. Holes never lower coverage, they are gaps already at/above what was delivered, so comparing high-water is the correct non-decreasing check (I-3).
  const cursor = parseHighWater(response?.cursor)

  if (cursor !== null) {
    if (state.lastResponseCursor !== null && cursor < state.lastResponseCursor) {
      state.issues.push({
        path: `${path}/response/cursor`,
        message: `pull response cursor high-water must be non-decreasing (I-3): ${state.lastResponseCursor} then ${cursor}`,
      })
    }
    state.lastResponseCursor = cursor
  }
  const signal = asObject(response?.signal)

  if (signal !== null && signal.type === 'CHECKPOINT_EXPIRED') {
    // The token is invalidated; re-hydration restarts the keyset from "0" [P:cursor-monotonicity-rebase-and-atomic-checkpoints], so the monotonic baseline resets here.
    state.lastResponseCursor = null
  }
  if (response?.has_more === false) {
    state.boundarySinceAssert = true
  }
}

function checkAssertedCursors(state: TCursorDiscipline, { path, step }: TCursorSite): void {
  asArray(step.checks).forEach((rawCheck, checkIndex) => {
    const check = asObject(rawCheck)

    if (check === null) {
      return
    }
    if (check.check === 'cursor') {
      const checkPath = `${path}/checks/${checkIndex}/value`

      // An asserted cursor is the opaque token (D-cursor-opaque-token) in any of its forms, which CURSOR_TOKEN covers; the decimal seq grammar stays for seq fields only.
      if (typeof check.value !== 'string' || !CURSOR_TOKEN.test(check.value)) {
        state.issues.push({ path: checkPath, message: 'asserted cursor must match the cursor-token grammar (D-cursor-opaque-token)' })

        return
      }
      if (state.assertedCursor !== null && check.value !== state.assertedCursor) {
        if (!state.boundarySinceAssert) {
          state.issues.push({
            path: checkPath,
            message:
              'asserted cursor changed without an intervening has_more:false checkpoint boundary ' +
              '(I-3; token-after-durable-apply [P:cursor-monotonicity-rebase-and-atomic-checkpoints], boundary encoding D-page-cap-and-checkpoint-boundary)',
          })
        }
      }
      state.assertedCursor = check.value
      state.boundarySinceAssert = false
    }
  })
}

/**
 * Single fencing-parameterized function so a change to D-cursor-opaque-token (cursor encoding)
 * touches one place. Only I-4's delivery bound reads the fencing value.
 */
const checkCursorDiscipline = (steps: unknown[], fencing: string, issues: TValidationIssue[]): void => {
  void fencing
  const state: TCursorDiscipline = { issues, lastResponseCursor: null, assertedCursor: null, boundarySinceAssert: false }

  steps.forEach((raw, index) => {
    const step = asObject(raw)

    if (step === null) {
      return
    }
    const site: TCursorSite = { path: `/steps/${index}`, step }

    if (step.kind === 'rpc' && step.rpc === 'pull') {
      trackPullCursor(state, site)

      return
    }
    if (step.kind === 'assert') {
      checkAssertedCursors(state, site)
    }
  })
}

// MARK: - I-4 delivery bound

const deliveredSeqs = (response: TJsonObject): { path: string; seq: bigint }[] => {
  const out: { path: string; seq: bigint }[] = []

  for (const field of ['rows', 'tombstones']) {
    asArray(response[field]).forEach((raw, index) => {
      const seq = parseSeq(asObject(raw)?.seq)

      if (seq !== null) {
        out.push({ path: `${field}/${index}`, seq })
      }
    })
  }
  return out
}

const checkDeliveryBound = (steps: unknown[], fencing: string, issues: TValidationIssue[]): void => {
  for (const { index, request, response } of pullSteps(steps)) {
    const path = `/steps/${index}/response`
    // Bound + re-delivery are measured against the cursor token's high-water mark (D-cursor-opaque-token). The request token's holes name the seqs the visibility horizon is ALLOWED to re-deliver at/below the mark (a gap that has since committed).
    const requestCursor = parseCursor(request.cursor)
    const responseHighWater = parseHighWater(response.cursor)

    for (const delivered of deliveredSeqs(response)) {
      // I-4 upper bound: no delivered seq may exceed the response cursor high-water (6 <= 6 passes; a hole delivered later is at or below its mark).
      if (responseHighWater !== null && delivered.seq > responseHighWater) {
        issues.push({
          path: `${path}/${delivered.path}`,
          message: `delivered seq ${delivered.seq} exceeds the response cursor high-water ${responseHighWater} (I-4 [P:keyset-pagination-and-delivery-bound])`,
        })
      }
      // Re-delivery at/below the request high-water is legal ONLY when the visibility horizon delivers one of the request token's holes (D-visibility-horizon: the refined horizon re-scans the gaps an earlier page skipped that have since committed).
      if (requestCursor === null || delivered.seq > requestCursor.highWater) {
        continue
      }
      const refinedHole = fencing === 'visibility-horizon' && requestCursor.holes.includes(delivered.seq)

      if (!refinedHole) {
        issues.push({
          path: `${path}/${delivered.path}`,
          message:
            `delivered seq ${delivered.seq} at/below the request cursor high-water ${requestCursor.highWater}: ` +
            're-delivery is a visibility-horizon hole only (I-4; D-visibility-horizon)',
        })
      }
    }
  }
}

// MARK: - I-5 verdict completeness

/** One push step under I-5: its request mutations, its response (an empty object when absent), and where its issues land. */
type TPushStep = { path: string; mutations: unknown[]; response: TJsonObject; issues: TValidationIssue[] }

function checkAbortShape(push: TPushStep, batch: TJsonObject): void {
  if (batch.outcome !== 'aborted') {
    push.issues.push({ path: `${push.path}/response/batch/outcome`, message: 'batch outcome must be "aborted" (D-atomic-batch-abort)' })
  }
  const offender = batch.offender_mutation_id
  const named = push.mutations.some((rawMutation) => asObject(rawMutation)?.mutation_id === offender)

  if (typeof offender !== 'string' || !named) {
    push.issues.push({
      path: `${push.path}/response/batch/offender_mutation_id`,
      message: 'offender_mutation_id must name one of the request batch mutations (D-atomic-batch-abort)',
    })
  }
}

function checkPushSignal(push: TPushStep, signal: TJsonObject): void {
  if (signal.type !== 'RESET_REQUIRED') {
    push.issues.push({ path: `${push.path}/response/signal/type`, message: 'push signal must be RESET_REQUIRED (D-schema-version-handshake)' })
  }
}

function checkVerdictBijection(push: TPushStep): void {
  const verdicts = asArray(push.response.verdicts)

  if (push.mutations.length !== verdicts.length) {
    push.issues.push({
      path: `${push.path}/response/verdicts`,
      message: `expected ${push.mutations.length} verdicts (one per mutation, I-5), got ${verdicts.length}`,
    })

    return
  }
  const seen = new Set<string>()

  push.mutations.forEach((rawMutation, position) => {
    const mutationId = asObject(rawMutation)?.mutation_id
    const verdictId = asObject(verdicts[position])?.mutation_id

    if (typeof mutationId !== 'string' || verdictId !== mutationId) {
      push.issues.push({
        path: `${push.path}/response/verdicts/${position}`,
        message: 'verdicts must carry mutation_id in request order (I-5; dual keying, D-verdict-correlation)',
      })

      return
    }
    if (seen.has(mutationId)) {
      push.issues.push({
        path: `${push.path}/request/batch/mutations/${position}`,
        message: `duplicate mutation_id ${mutationId} breaks the verdict bijection (I-5)`,
      })
    }
    seen.add(mutationId)
  })
}

function checkPushResponse(push: TPushStep): void {
  const { response } = push
  const batch = asObject(response.batch)

  // The bijection (I-5) is CONDITIONAL on success: D-atomic-batch-abort (decided, JSON:API shape), an atomic batch that reverts returns a single batch outcome naming the offender, no per-member verdicts. Validate the abort shape minimally instead of the length/dual-keying check.
  if (batch !== null && response.verdicts === undefined) {
    checkAbortShape(push, batch)

    return
  }
  // The bijection (I-5) also presupposes the schema handshake passed: a push below the configured min_schema_version is gated BEFORE any mutation (D-schema-version-handshake decided) and returns a typed RESET_REQUIRED signal, no per-member verdicts (lifecycle/003). Validate the signal shape minimally.
  const signal = asObject(response.signal)

  if (signal !== null && response.verdicts === undefined && response.batch === undefined) {
    checkPushSignal(push, signal)

    return
  }
  checkVerdictBijection(push)
}

const checkVerdicts = (steps: unknown[], issues: TValidationIssue[]): void => {
  steps.forEach((raw, index) => {
    const step = asObject(raw)

    if (step === null || step.kind !== 'rpc' || step.rpc !== 'push') {
      return
    }
    const mutations = asArray(asObject(asObject(step.request)?.batch)?.mutations)

    checkPushResponse({ path: `/steps/${index}`, mutations, response: asObject(step.response) ?? {}, issues })
  })
}

// MARK: - I-8 signal shape

const checkSignals = (steps: unknown[], issues: TValidationIssue[]): void => {
  for (const { index, response } of pullSteps(steps)) {
    const path = `/steps/${index}/response`

    if (response.signal === null || response.signal === undefined) {
      continue
    }
    if (asArray(response.rows).length > 0 || asArray(response.tombstones).length > 0) {
      issues.push({
        path,
        message: 'non-null signal must ride an empty page: rows and tombstones empty (I-8, D-signal-excludes-page-data)',
      })
    }
    if (response.has_more !== false) {
      issues.push({ path: `${path}/has_more`, message: 'non-null signal requires has_more:false (I-8, D-signal-excludes-page-data)' })
    }
  }
}

// MARK: - I-9 page limit accounting

const DEFAULT_LIMIT = DEFAULT_PAGE_LIMIT

/** One pull page under I-9: the request's limit and cursor, the scan cap the transcript declares (null when none), the response, and where its issues land. */
type TPullPage = { path: string; limit: number; scanCap: number | null; request: TJsonObject; response: TJsonObject; issues: TValidationIssue[] }

function pageLimitMessage(clause: 'a' | 'b' | 'c' | 'd' | 'f', detail: string): string {
  return `${detail} (I-9 page limit accounting, clause ${clause}, D-page-cap-and-checkpoint-boundary)`
}

function pageEntries(response: TJsonObject): number {
  return asArray(response.rows).length + asArray(response.tombstones).length
}

function highestSeq(response: TJsonObject): bigint | null {
  return deliveredSeqs(response).reduce<bigint | null>((max, entry) => (max === null || entry.seq > max ? entry.seq : max), null)
}

/**
 * Clauses b and d for a page whose cursor carries a start: a continuation page
 * is full, keeps has_more:true, and its cursor is `<start>:<last entry seq>`,
 * where the start is the incoming token's start or, when it has none, the
 * incoming token's high-water. Under a declared scan cap a page may stop after
 * examining that many candidates, withheld rows included, so it holds at most
 * the smaller of the two caps and its cursor sits at or above its highest entry.
 */
function checkContinuationPage(page: TPullPage, cursor: { start: bigint; highWater: bigint }): void {
  const { path, limit, scanCap, request, response, issues } = page
  const entries = pageEntries(response)
  const isFull = scanCap === null ? entries === limit : entries <= Math.min(limit, scanCap)

  if (!isFull || response.has_more !== true) {
    issues.push({ path, message: pageLimitMessage('b', `page whose cursor carries a start holds ${entries} entries with has_more:${String(response.has_more)}: a continuation page holds exactly the limit ${limit} with has_more:true`) })
  }
  const highest = highestSeq(response)
  const isAtLastEntry = scanCap === null ? highest === cursor.highWater : highest === null || highest <= cursor.highWater

  if (!isAtLastEntry) {
    issues.push({ path: `${path}/cursor`, message: pageLimitMessage('d', `continuation cursor high-water ${cursor.highWater} is not the page's highest entry seq ${highest ?? '(none)'}`) })
  }
  const incoming = parseCursor(request.cursor)
  const expected = incoming === null ? null : (incoming.start ?? incoming.highWater)

  if (expected !== null && cursor.start !== expected) {
    issues.push({ path: `${path}/cursor`, message: pageLimitMessage('d', `continuation cursor start ${cursor.start} is not the incoming token's start, or its high-water when it has none (${expected})`) })
  }
}

/**
 * Clauses c and f for a page that keeps has_more:true with a hole-free cursor:
 * only a continuation keeps the checkpoint open that way, so the page is full
 * and its cursor carries a start. Only the oracle's holes keep a last page open.
 * Under a declared scan cap a continuation may hold fewer than the limit.
 */
function checkOpenPage({ path, limit, scanCap, response, issues }: TPullPage, cursor: TCursorToken): void {
  if (response.has_more !== true || cursor.holes.length > 0) {
    return
  }
  const entries = pageEntries(response)

  if (entries < limit && scanCap === null) {
    issues.push({ path: `${path}/has_more`, message: pageLimitMessage('c', `page holds ${entries} entries, under the limit ${limit}, yet keeps has_more:true with a hole-free cursor: a page that holds every remaining entry closes the checkpoint`) })
  }
  if (cursor.start === null) {
    issues.push({ path: `${path}/cursor`, message: pageLimitMessage('f', 'has_more:true page with a hole-free cursor carries no start: a continuation cursor names the checkpoint its transfer started from') })
  }
}

/**
 * Rows and tombstones count against one limit, and a page is a prefix of the
 * (seq, table, pk) stream. A continuation page is the one whose cursor carries
 * a start; the page that holds every remaining entry returns a checkpoint token,
 * which never carries one. Clause e exempts a signal page: I-8 governs it, and it
 * echoes the incoming cursor verbatim, start included.
 */
function checkPageAccounting(page: TPullPage): void {
  const { path, limit, response, issues } = page

  if (response.signal !== null && response.signal !== undefined) {
    return
  }
  const entries = pageEntries(response)
  const cursor = parseCursor(response.cursor)

  if (entries > limit) {
    issues.push({ path, message: pageLimitMessage('a', `page holds ${entries} rows and tombstones, over the limit ${limit}`) })
  }
  if (cursor === null) {
    return
  }
  if (cursor.start !== null) {
    checkContinuationPage(page, { start: cursor.start, highWater: cursor.highWater })
  }
  checkOpenPage(page, cursor)
}

/** The scan cap a transcript declares as `context.server.max_pull_scan`, null when it declares none (D-page-cap-and-checkpoint-boundary). */
const declaredScanCap = (t: TJsonObject): number | null => {
  const server = asObject(asObject(t.context)?.server)

  return typeof server?.max_pull_scan === 'number' ? server.max_pull_scan : null
}

const checkLimits = (steps: unknown[], scanCap: number | null, issues: TValidationIssue[]): void => {
  for (const { index, request, response } of pullSteps(steps)) {
    const limit = typeof request.limit === 'number' ? request.limit : DEFAULT_LIMIT

    checkPageAccounting({ path: `/steps/${index}/response`, limit, scanCap, request, response, issues })
  }
}

// MARK: - I-10

/** True when item `i` does not strictly follow item `i - 1` in (seq, table, pk) order; a pair lacking an object or a decimal seq is skipped. */
function isMisordered(items: unknown[], i: number): boolean {
  const previous = asObject(items[i - 1])
  const current = asObject(items[i])
  const previousSeq = parseSeq(previous?.seq)
  const currentSeq = parseSeq(current?.seq)

  if (previous === null || current === null || previousSeq === null || currentSeq === null) {
    return false
  }
  if (previousSeq !== currentSeq) {
    return previousSeq > currentSeq
  }
  const order =
    compareUtf8(String(previous.table), String(current.table)) || compareUtf8(String(previous.pk), String(current.pk))

  return order >= 0
}

function misorderedPositions(items: unknown[]): number[] {
  const positions: number[] = []

  for (let i = 1; i < items.length; i += 1) {
    if (isMisordered(items, i)) {
      positions.push(i)
    }
  }
  return positions
}

const checkOrdering = (steps: unknown[], issues: TValidationIssue[]): void => {
  for (const { index, response } of pullSteps(steps)) {
    for (const field of ['rows', 'tombstones']) {
      for (const i of misorderedPositions(asArray(response[field]))) {
        issues.push({
          path: `/steps/${index}/response/${field}/${i}`,
          message: `${field} must be strictly (seq, table, pk)-ordered (I-10 [P:keyset-pagination-and-delivery-bound])`,
        })
      }
    }
  }
}

// MARK: - Public API: per-transcript

export const checkTranscript = (t: unknown): TValidationIssue[] => {
  const issues: TValidationIssue[] = []

  if (!isObject(t)) {
    return [{ path: '', message: 'transcript must be a JSON object' }]
  }
  checkTopLevel(t, issues)
  checkPlaceholders(t, issues)
  const steps = asArray(t.steps)

  checkStepNumbering(steps, issues)
  const fencing = typeof t.fencing === 'string' ? t.fencing : 'shared'

  checkCursorDiscipline(steps, fencing, issues)
  checkDeliveryBound(steps, fencing, issues)
  checkVerdicts(steps, issues)
  checkSignals(steps, issues)
  checkLimits(steps, declaredScanCap(t), issues)
  checkOrdering(steps, issues)

  return issues
}

// MARK: - I-12 manifest bijection

const manifestEntries = (manifest: unknown): TJsonObject[] | null => {
  if (isObject(manifest) && Array.isArray(manifest.cases)) {
    return (manifest.cases as unknown[]).filter(isObject)
  }
  return null
}

const normalizeManifestPath = (file: string): string => file

const derivedPath = (id: string): string => `transcripts/${id}.json`

type TBlockedEntry = {
  entry: TJsonObject
  id: string
  where: string
  transcripts: Map<string, TCorpusEntry>
  issues: TValidationIssue[]
}

function checkBlockedEntry({ entry, id, where, transcripts, issues }: TBlockedEntry): void {
  // Blocked entry: zero seed bytes; the gate lives in blocked_on (grammar here, registry membership in checkOpenDecisionRefs).
  const blockedOn = asArray(entry.blocked_on)

  if (blockedOn.length === 0 || !blockedOn.every((v) => typeof v === 'string' && OPEN_DECISION_PATTERN.test(v))) {
    issues.push({ path: where, message: `blocked entry ${id} needs a non-empty blocked_on of D-<slug> ids (I-12)` })
  }
  const path = derivedPath(id)

  if (transcripts.has(path)) {
    issues.push({ path: where, message: `blocked entry ${id} must not have a transcript file (${path}) (I-12)` })
  }
}

const checkManifestBijection = (
  transcripts: Map<string, TCorpusEntry>,
  manifest: unknown,
  issues: TValidationIssue[]
): void => {
  const entries = manifestEntries(manifest)

  if (entries === null) {
    issues.push({ path: 'cases/manifest.json', message: 'manifest has no recognizable case entries (I-12)' })

    return
  }
  const claimed = new Set<string>()
  const seenIds = new Set<string>()

  entries.forEach((entry, index) => {
    const where = `cases/manifest.json/${index}`
    const id = typeof entry.id === 'string' ? entry.id : null

    if (id === null) {
      issues.push({ path: where, message: 'manifest entry lacks a string id (I-12)' })

      return
    }
    if (seenIds.has(id)) {
      issues.push({ path: where, message: `duplicate manifest id ${id} (I-12)` })
    }
    seenIds.add(id)

    if ('file' in entry && entry.file === null) {
      checkBlockedEntry({ entry, id, where, transcripts, issues })

      return
    }
    if ('blocked_on' in entry) {
      issues.push({ path: where, message: `entry ${id} has seed bytes: blocked_on is blocked-entry-only (I-12)` })
    }
    const path = typeof entry.file === 'string' ? normalizeManifestPath(entry.file) : derivedPath(id)

    claimed.add(path)

    if (!transcripts.has(path)) {
      issues.push({ path: where, message: `manifest entry ${id} names a missing transcript ${path} (I-12)` })
    }
  })

  for (const path of transcripts.keys()) {
    if (!claimed.has(path)) {
      issues.push({ path, message: 'transcript file has no manifest entry (I-12)' })
    }
  }
}

// MARK: - Case-id ↔ path coherence

const expectedCaseId = (path: string): string => path.slice('transcripts/'.length).replace(/\.json$/, '')

const checkCaseIds = (transcripts: Map<string, TCorpusEntry>, issues: TValidationIssue[]): void => {
  for (const [path, entry] of transcripts) {
    const t = asObject(entry.json)

    if (t === null) {
      continue
    }
    const expected = expectedCaseId(path)

    if (t.case !== expected) {
      issues.push({ path, message: `case "${String(t.case)}" does not match its path-derived id "${expected}"` })
    }
  }
}

// MARK: - Public API: corpus-wide

const checkFencingPaths = (
  transcripts: Map<string, { raw: string; json: unknown }>,
  issues: TValidationIssue[],
): void => {
  for (const [path, entry] of transcripts) {
    const fencing = asObject(entry.json)?.fencing
    const inFencingDir = path.startsWith('transcripts/fencing/')

    if (inFencingDir && fencing !== 'visibility-horizon') {
      issues.push({
        path,
        message: `transcripts/fencing/ requires fencing "visibility-horizon", got ${JSON.stringify(fencing)}`,
      })
    }
    if (!inFencingDir && fencing !== 'shared') {
      issues.push({
        path,
        message: `non-fencing transcripts require fencing "shared", got ${JSON.stringify(fencing)}`,
      })
    }
  }
}

const equalJsonValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const checkManifestTranscriptFields = (
  transcripts: Map<string, TCorpusEntry>,
  manifest: unknown,
  issues: TValidationIssue[],
): void => {
  const entries = manifestEntries(manifest)

  if (entries === null) {
    return
  }
  entries.forEach((entry, index) => {
    if (entry.file === null || typeof entry.file !== 'string') {
      return
    }
    const transcript = transcripts.get(normalizeManifestPath(entry.file))

    if (transcript === undefined) {
      return
    }
    const body = asObject(transcript.json)

    if (body === null) {
      return
    }
    const where = `cases/manifest.json/${index}`

    for (const field of ['cites', 'status', 'priority', 'title'] as const) {
      if (!equalJsonValue(entry[field], body[field])) {
        issues.push({
          path: where,
          message: `manifest ${field} does not equal transcript ${entry.file} ${field} (I-12)`,
        })
      }
    }
  })
}

export const checkCorpus = (
  transcripts: Map<string, { raw: string; json: unknown }>,
  manifest: unknown
): TValidationIssue[] => {
  const issues: TValidationIssue[] = []

  checkCaseIds(transcripts, issues)
  checkFencingPaths(transcripts, issues)

  if (manifest !== null && manifest !== undefined) {
    checkManifestBijection(transcripts, manifest, issues)
    checkManifestTranscriptFields(transcripts, manifest, issues)
  }
  return issues
}

// MARK: - I-6 registry half: every placeholder UUID exists in fixtures/identifiers.json

export const checkIdentifierRegistry = (
  transcripts: Map<string, { raw: string; json: unknown }>,
  identifiers: unknown
): TValidationIssue[] => {
  const issues: TValidationIssue[] = []

  if (!isObject(identifiers)) {
    return [{ path: 'fixtures/identifiers.json', message: 'identifier registry must be a JSON object (I-6)' }]
  }
  const known = new Set(Object.keys(identifiers))

  for (const [uuid, entry] of Object.entries(identifiers)) {
    const matched = PLACEHOLDER_UUID.exec(uuid)

    if (matched === null) {
      issues.push({
        path: `fixtures/identifiers.json/${uuid}`,
        message: `registry UUID is not placeholder grammar (I-6)`,
      })
      continue
    }
    const code = matched[1] as keyof typeof PLACEHOLDER_KIND_BY_CODE
    const expected = PLACEHOLDER_KIND_BY_CODE[code]
    const kind = isObject(entry) ? entry.kind : undefined

    if (kind !== expected) {
      issues.push({
        path: `fixtures/identifiers.json/${uuid}`,
        message: `kind ${JSON.stringify(kind)} does not match code ${code} (${expected}) (I-6)`,
      })
    }
  }
  const collect = (value: unknown, path: string, file: string): void => {
    if (typeof value === 'string' && GENERIC_UUID.test(value) && !known.has(value)) {
      issues.push({ path: `${file}${path}`, message: `UUID ${value} is not registered in fixtures/identifiers.json (I-6)` })

      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collect(item, `${path}/${index}`, file)
      })

      return
    }
    if (isObject(value)) {
      for (const [name, item] of Object.entries(value)) {
        collect(item, `${path}/${name}`, file)
      }
    }
  }
  for (const [file, entry] of transcripts) {
    collect(entry.json, '', file)
  }
  return issues
}

// MARK: - I-6 domain half: every table/column exists in fixtures/domain.json

const extractDomain = (domain: unknown): Map<string, Set<string>> | null => {
  const source = isObject(domain) && isObject(domain.tables) ? domain.tables : asObject(domain)

  if (source === null) {
    return null
  }
  const out = new Map<string, Set<string>>()

  for (const [table, def] of Object.entries(source)) {
    if (Array.isArray(def)) {
      out.set(table, new Set(def.filter((c): c is string => typeof c === 'string')))
    } else if (isObject(def)) {
      const columns = def.columns

      if (Array.isArray(columns)) {
        out.set(table, new Set(columns.filter((c): c is string => typeof c === 'string')))
      } else if (isObject(columns)) {
        out.set(table, new Set(Object.keys(columns)))
      } else {
        out.set(table, new Set(Object.keys(def)))
      }
    }
  }
  return out.size > 0 ? out : null
}

const COLUMN_BEARING_KEYS = ['columns', 'params', 'precondition', 'row', 'transforms']

/** One node of the I-6 domain walk over a transcript file, with the extracted fixture tables, the raw fixture, and the issue sink. */
type TDomainWalk = {
  value: unknown
  path: string
  file: string
  tables: Map<string, Set<string>>
  domain: unknown
  issues: TValidationIssue[]
}

type TServerTable = { table: string; declared: TJsonObject | null; fixture: TJsonObject | null }

function checkTableColumns({ path, file, tables, issues }: TDomainWalk, value: TJsonObject): void {
  if (typeof value.table !== 'string') {
    return
  }
  const columns = tables.get(value.table)

  if (columns === undefined) {
    issues.push({ path: `${file}${path}/table`, message: `unknown table "${value.table}" (I-6)` })

    return
  }
  for (const key of COLUMN_BEARING_KEYS) {
    const holder = asObject(value[key])

    if (holder === null) {
      continue
    }
    for (const column of Object.keys(holder)) {
      if (!columns.has(column)) {
        issues.push({
          path: `${file}${path}/${key}/${column}`,
          message: `unknown column "${column}" on table "${value.table}" (I-6)`,
        })
      }
    }
  }
}

function checkServerTableFixture(walk: TDomainWalk, { table, declared, fixture }: TServerTable): void {
  if (declared === null || fixture === null || typeof fixture.bucket_column !== 'string') {
    return
  }
  const { path, file, tables, issues } = walk

  if (declared.bucket_column !== fixture.bucket_column) {
    issues.push({
      path: `${file}${path}/tables/${table}/bucket_column`,
      message: `bucket_column ${JSON.stringify(declared.bucket_column)} does not match fixtures/domain.json (${fixture.bucket_column}) (I-6)`,
    })
  }
  if (typeof fixture.pk === 'string' && !tables.get(table)?.has(fixture.pk)) {
    issues.push({
      path: 'fixtures/domain.json',
      message: `pk "${fixture.pk}" is not a column of table "${table}" (I-6)`,
    })
  }
}

function checkServerTables(walk: TDomainWalk, value: TJsonObject): void {
  const { path, file, tables, domain, issues } = walk

  if (!path.endsWith('/context/server') || !isObject(value.tables)) {
    return
  }
  const domainRoot = isObject(domain) && isObject(domain.tables) ? domain.tables : asObject(domain)

  for (const table of Object.keys(value.tables)) {
    if (!tables.has(table)) {
      issues.push({ path: `${file}${path}/tables/${table}`, message: `unknown table "${table}" (I-6)` })
    }
    const declared = asObject(value.tables[table])
    const fixture = domainRoot === null ? null : asObject(domainRoot[table])

    checkServerTableFixture(walk, { table, declared, fixture })
  }
}

function visitDomain(walk: TDomainWalk): void {
  const { value, path } = walk

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitDomain({ ...walk, value: item, path: `${path}/${index}` })
    })

    return
  }
  if (!isObject(value)) {
    return
  }
  checkTableColumns(walk, value)
  checkServerTables(walk, value)

  for (const [name, item] of Object.entries(value)) {
    visitDomain({ ...walk, value: item, path: `${path}/${name}` })
  }
}

export const checkDomainTables = (
  transcripts: Map<string, { raw: string; json: unknown }>,
  domain: unknown
): TValidationIssue[] => {
  const issues: TValidationIssue[] = []
  const tables = extractDomain(domain)

  if (tables === null) {
    return [{ path: 'fixtures/domain.json', message: 'domain fixture has no recognizable tables (I-6)' }]
  }
  for (const [file, entry] of transcripts) {
    visitDomain({ value: entry.json, path: '', file, tables, domain, issues })
  }
  return issues
}

// MARK: - I-7 registry half: referenced decision ids exist in decisions/index.json

const registryIds = (registry: unknown): Set<string> | null => {
  // decisions/index.json: a flat object whose KEYS are D-<kebab-slug> ids.
  if (isObject(registry) && !Array.isArray(registry)) {
    const keys = Object.keys(registry).filter((k) => /^D-[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(k))

    if (keys.length > 0) {
      return new Set(keys)
    }
  }
  return null
}

export const checkOpenDecisionRefs = (
  transcripts: Map<string, { raw: string; json: unknown }>,
  manifest: unknown,
  registry: unknown
): TValidationIssue[] => {
  const issues: TValidationIssue[] = []
  const ids = registryIds(registry)

  if (ids === null) {
    return [{ path: 'decisions/index.json', message: 'decision registry has no recognizable entries (I-7)' }]
  }
  void transcripts

  for (const entry of manifestEntries(manifest) ?? []) {
    asArray(entry.blocked_on).forEach((id) => {
      if (typeof id === 'string' && !ids.has(id)) {
        issues.push({
          path: `cases/manifest.json (${String(entry.id)})`,
          message: `blocked_on ${id} is not in the decision registry (I-12 ⊆ I-7)`,
        })
      }
    })
  }
  return issues
}
