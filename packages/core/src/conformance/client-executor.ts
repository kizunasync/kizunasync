// MARK: - Client transcript executor

/**
 * The mirror of packages/protocol/executor/executor.ts, but it DRIVES an
 * IProtocolClient (the engine); it does not answer as an IProtocolServer. It
 * interprets the `local` / `rpc` / `fault` / `assert` steps the server-side
 * executor records-and-skips (executor.ts:215-222), the seam it fills:
 *   server ⇒ no-op (its effect is baked into later golden pull responses; the
 *            client never observes out-of-band changes directly).
 *   rpc    ⇒ drive client.pull/push; TranscriptRemote replays step.response and
 *            asserts the engine sent the byte-exact step.request.
 *   fault  ⇒ drop-ack: drive once, discard (engine retries next rpc, push/003);
 *            transport-error: the call rejects, nothing applies (fencing/001).
 *   local  ⇒ client.applyLocal (the engine performs the P:outbox-and-serial-in-flight txn).
 *   assert ⇒ interpret each Check against the engine (cursor / outbox-depth /
 *            local-row / event / no-intermediate-commit).
 *   postconditions ⇒ run as a final assert (final-state obligations).
 *
 * Result type mirrors executor.ts TCaseResult exactly (pass / fail-with-
 * diverging-check / skipped-blocked). Async throughout because the engine's
 * remote boundary is async; the protocol original is sync because the reference
 * server is in-memory.
 */

import { canonicalize } from '@kizunasync/protocol/harness/canonical'
import { readCorpusFile } from '@kizunasync/protocol/harness/load'
import { EFencing } from '@kizunasync/protocol/executor/server-contract'
import type { TFencing } from '@kizunasync/protocol/executor/server-contract'

import { EConflictMode, type TColumnValues, type TEngineConfig } from '../wire/types'
import type { IProtocolClient, TLocalMutationSpec, TReadableRow, TTranscriptStep } from './client-contract'
import { RequestDivergenceError } from './transcript-remote'

// MARK: - Result types

export type TStepOutcome = { n: number; kind: string; ok: boolean; detail?: string }

export type TClientFailure = {
  step: number
  message: string
  expected: string
  actual: string
}

export type TClientResult =
  | { status: 'pass'; case: string; candidate: TFencing; steps: TStepOutcome[] }
  | {
      status: 'fail'
      case: string
      candidate: TFencing
      steps: TStepOutcome[]
      failures: TClientFailure[]
    }
  | { status: 'skipped-blocked'; case: string; blocked_on: string[]; reason: string }

// MARK: - JSON guards

type TJsonObject = Record<string, unknown>

const isObject = (value: unknown): value is TJsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asObject = (value: unknown): TJsonObject | null => (isObject(value) ? value : null)

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

// MARK: - Engine config from transcript context

/**
 * The engine is generic and config-driven (no domain-table knowledge): tables,
 * their bucket columns, and the bucket PARAMS come from the transcript context, the
 * same block the server-side executor reads (context.server + the owner
 * identity). Built to TEngineConfig (wire/types.ts) EXACTLY:
 *
 *   tables[name].bucketColumn: context.server.tables[name].bucket_column.
 *   tables[name].bucketParams: the concrete equality map sent on the wire.
 *     The client's identity bucket is one owner-equality map whose param
 *     value is context.user_id (the request bucket is
 *     { params: { <bucket_column>: <user_id> }, table }). This value is NOT in
 *     context.server, because it is the runtime identity context.user_id, so it
 *     is materialized here; TTableConfig documents that an absent bucketParams
 *     makes the engine's request build throw; it does not send an empty bucket.
 *     Probe pulls that name a different map (tombstones/003) stay on the
 *     protocol/SQL oracle; the client harness does not emit them.
 *   schemaVersion: context.schema_version (the client's declared version).
 *
 *   defaultLimit: the page size the engine sends on `pull.limit`. This is a
 *     CLIENT configuration choice, not server context: most transcripts omit
 *     `limit` (the engine sends none → default 500 server-side), but pull/002
 *     configures limit 2 to force keyset pagination, and pins that 2 in its
 *     request bytes. The client's configured limit is derived FROM the
 *     transcript's own pull requests (the spec of how this client was set up):
 *     the first pull request that carries `limit` sets defaultLimit; if none
 *     does, it stays unset and the engine emits no `limit`. The corpus uses a
 *     single constant limit per transcript, so first-seen is unambiguous. The
 *     harness stays corpus-driven (no external per-case registry) while still
 *     asserting the engine emits exactly the configured limit and paginates
 *     correctly.
 */
export const configFromContext = (transcript: TJsonObject): TEngineConfig => {
  const context = asObject(transcript.context) ?? {}
  const serverConfig = asObject(context.server) ?? {}
  const userId = asString(context.user_id)
  const tables: TEngineConfig['tables'] = {}

  for (const [name, raw] of Object.entries(asObject(serverConfig.tables) ?? {})) {
    const bucketColumn = asString(asObject(raw)?.bucket_column)
    // The seed's single owner-equality bucket: bucketParams[bucketColumn] = user_id.
    const tableConfig: TEngineConfig['tables'][string] = {
      bucketColumn,
      bucketParams: { [bucketColumn]: userId },
    }

    // conflict_mode opt-in (conflict/003): thread 'hlc' through so the engine attaches the origin HLC; absent ⇒ 'arrival'.
    if (asObject(raw)?.conflict_mode === EConflictMode.hlc) {
      tableConfig.conflictMode = EConflictMode.hlc
    }
    // soft_delete_column opt-in (D-corpus-soft-delete-and-refusal, lifecycle/004): the engine refuses a hard delete on this table; absent ⇒ hard deletes stay legal.
    const softDeleteColumn = asString(asObject(raw)?.soft_delete_column)

    if (softDeleteColumn !== '') {
      tableConfig.softDelete = softDeleteColumn
    }
    tables[name] = tableConfig
  }
  const schemaVersion = typeof context.schema_version === 'number' ? context.schema_version : 1
  const defaultLimit = firstPullLimit(transcript)

  return defaultLimit === undefined ? { tables, schemaVersion } : { tables, schemaVersion, defaultLimit }
}

/**
 * The `limit` the transcript's pull requests carry = the client's configured
 * page size (undefined when the corpus omits it). Scans rpc steps in order.
 */
const firstPullLimit = (transcript: TJsonObject): number | undefined => {
  for (const raw of asArray(transcript.steps)) {
    const step = asObject(raw)

    if (step === null || step.kind !== 'rpc' || step.rpc !== 'pull') {
      continue
    }
    const limit = asObject(step.request)?.limit

    if (typeof limit === 'number') {
      return limit
    }
  }
  return undefined
}

// MARK: - Resume-checkpoint precondition

/**
 * The cursor the client RESUMES from is the cursor its FIRST pull request
 * carries. Cases that bootstrap fresh send '0'; cases that open mid-history
 * (lifecycle/001 at '1', fencing/001 at '4') document the non-'0' resume only
 * in prose context.notes, with no machine-readable field. Recover it from
 * that first pull request and seed the durable cursor before the steps run.
 * Seeding '0' is a no-op (the engine already bootstraps there) and cannot
 * regress the fresh-start cases. Absent any pull step ⇒ undefined ⇒ seed
 * nothing.
 */
const firstPullCursor = (transcript: TJsonObject): string | undefined => {
  for (const raw of asArray(transcript.steps)) {
    const step = asObject(raw)

    if (step === null || step.kind !== 'rpc' || step.rpc !== 'pull') {
      continue
    }
    const cursor = asObject(step.request)?.cursor

    if (typeof cursor === 'string') {
      return cursor
    }
  }
  return undefined
}

// MARK: - Local-mutation feed

/**
 * The engine mints mutation_id via uuid() and reads precondition off the local
 * write, but the `local` step grammar (transcript.schema.json) pins only the
 * mutation_id, NOT the precondition (push/004's precondition `{title:'unclaimed'}`
 * rides only the push REQUEST). The client is fed, in apply order:
 *   - each local step's pinned mutation_id (so uuid() returns it → the emitted
 *     push request matches the golden bytes byte-for-byte);
 *   - that mutation's precondition, RECOVERED by mutation_id from the push /
 *     drop-ack request mutations (the only place the corpus pins it).
 * Same corpus-driven recovery as the cursor/limit helpers: the harness
 * reconstructs the client's setup from the authoritative request bytes and
 * does not invent anything.
 */
const preconditionsByMutationId = (transcript: TJsonObject): Map<string, TColumnValues> => {
  const map = new Map<string, TColumnValues>()
  const harvest = (request: unknown): void => {
    for (const raw of asArray(asObject(asObject(request)?.batch)?.mutations)) {
      const mutation = asObject(raw)
      const id = asString(mutation?.mutation_id)
      const precondition = asObject(mutation?.precondition)

      if (id !== '' && precondition !== null) {
        map.set(id, precondition as TColumnValues)
      }
    }
  }
  for (const raw of asArray(transcript.steps)) {
    const step = asObject(raw)

    if (step === null) {
      continue
    }
    // push rpc steps and drop-ack(push) fault steps both carry a batch request.
    if ((step.kind === 'rpc' && step.rpc === 'push') || step.kind === 'fault') {
      harvest(step.request)
    }
  }
  return map
}

/**
 * The per-mutation origin HLC, recovered by mutation_id from the push request
 * bytes. Same corpus-driven recovery as preconditionsByMutationId: the
 * `local` step grammar carries no hlc; the push request pins it (conflict/003).
 * Feeding it makes the engine emit the transcript's pinned hlc byte-for-byte.
 */
const hlcsByMutationId = (transcript: TJsonObject): Map<string, string> => {
  const map = new Map<string, string>()
  const harvest = (request: unknown): void => {
    for (const raw of asArray(asObject(asObject(request)?.batch)?.mutations)) {
      const mutation = asObject(raw)
      const id = asString(mutation?.mutation_id)
      const hlc = asString(mutation?.hlc)

      if (id !== '' && hlc !== '') {
        map.set(id, hlc)
      }
    }
  }
  for (const raw of asArray(transcript.steps)) {
    const step = asObject(raw)

    if (step === null) {
      continue
    }
    if ((step.kind === 'rpc' && step.rpc === 'push') || step.kind === 'fault') {
      harvest(step.request)
    }
  }
  return map
}

/**
 * Atomic grouping inferred from the corpus (no external config): any push rpc
 * step whose request.batch.atomic is true names an atomic group; the group's
 * mutation_ids all share one batchId (the push step's `n`, stable per
 * transcript). Feeding this to the engine makes those local writes carry a
 * shared batchId; the push loop sends them as ONE atomic batch and reverts
 * them together on abort. Same corpus-driven recovery as the precondition
 * helper: reconstruct the client's setup from the authoritative request
 * bytes, invent nothing (push/005).
 */
const atomicBatchIdByMutationId = (transcript: TJsonObject): Map<string, string> => {
  const map = new Map<string, string>()

  for (const raw of asArray(transcript.steps)) {
    const step = asObject(raw)

    if (step === null || step.kind !== 'rpc' || step.rpc !== 'push') {
      continue
    }
    const batch = asObject(asObject(step.request)?.batch)

    if (batch === null || batch.atomic !== true) {
      continue
    }
    const batchId = `atomic-${typeof step.n === 'number' ? step.n : 0}`

    for (const rawMutation of asArray(batch.mutations)) {
      const id = asString(asObject(rawMutation)?.mutation_id)

      if (id !== '') {
        map.set(id, batchId)
      }
    }
  }
  return map
}

const localMutationSpecs = (transcript: TJsonObject): TLocalMutationSpec[] => {
  const preconditions = preconditionsByMutationId(transcript)
  const batchIds = atomicBatchIdByMutationId(transcript)
  const hlcs = hlcsByMutationId(transcript)
  const specs: TLocalMutationSpec[] = []

  for (const raw of asArray(transcript.steps)) {
    const step = asObject(raw)

    if (step === null || step.kind !== 'local') {
      continue
    }
    const mutationId = asString(step.mutation_id)

    if (mutationId === '') {
      continue
    }
    const spec: TLocalMutationSpec = { mutationId }
    const precondition = preconditions.get(mutationId)

    if (precondition !== undefined) {
      spec.precondition = precondition
    }
    const batchId = batchIds.get(mutationId)

    if (batchId !== undefined) {
      spec.batchId = batchId
    }
    const hlc = hlcs.get(mutationId)

    if (hlc !== undefined) {
      spec.hlc = hlc
    }
    specs.push(spec)
  }
  return specs
}

// MARK: - Known-row tracking

/**
 * `no-intermediate-commit` (P:session-guarantees-and-exactly-once-effect item 2) asserts a staged has_more:true page is
 * never observable before the boundary commit. We snapshot the readable state
 * of every (table, pk) the transcript has touched, plus the cursor, right
 * BEFORE each rpc; the check then requires the readable state + cursor to be
 * byte-identical to that snapshot, so the staged page produced no observable
 * commit. The known-pk set grows monotonically as steps/responses mention pks.
 */
type TRowKey = string

const rowKey = (table: string, pk: string): TRowKey => `${table} ${pk}`

type TSnapshot = { cursor: string; rows: Map<TRowKey, string> }

const readableSignature = (row: TReadableRow): string =>
  row === null ? 'null' : canonicalize(row.columns)

type TKnownRows = Map<TRowKey, { table: string; pk: string }>

const snapshot = async (client: IProtocolClient, known: TKnownRows): Promise<TSnapshot> => {
  const rows = new Map<TRowKey, string>()

  for (const [key, { table, pk }] of known) {
    rows.set(key, readableSignature(await client.readRow(table, pk)))
  }
  return { cursor: await client.cursor(), rows }
}

/**
 * Record every (table, pk) a step or response mentions so the snapshot covers
 * staged rows even before they would (wrongly) become visible.
 */
const noteRowsFromStep = (step: TJsonObject, known: TKnownRows): void => {
  const note = (table: string, pk: string): void => {
    if (table !== '' && pk !== '') {
      known.set(rowKey(table, pk), { table, pk })
    }
  }
  // server / local / local-row-check carry table+pk directly.
  note(asString(step.table), asString(step.pk))
  // rpc responses carry rows[] and tombstones[].
  const response = asObject(step.response)

  if (response !== null) {
    for (const raw of asArray(response.rows)) {
      const r = asObject(raw)

      if (r !== null) {
        note(asString(r.table), asString(r.pk))
      }
    }
    for (const raw of asArray(response.tombstones)) {
      const t = asObject(raw)

      if (t !== null) {
        note(asString(t.table), asString(t.pk))
      }
    }
  }
  // assert blocks carry local-row checks with table+pk.
  for (const raw of asArray(step.checks)) {
    const c = asObject(raw)

    if (c !== null && c.check === 'local-row') {
      note(asString(c.table), asString(c.pk))
    }
  }
}

// MARK: - Check interpretation

const checkRow = async (
  client: IProtocolClient,
  check: TJsonObject,
  n: number,
  failures: TClientFailure[]
): Promise<boolean> => {
  const table = asString(check.table)
  const pk = asString(check.pk)
  const expected = check.row === null ? 'null' : canonicalize(check.row)
  const actual = readableSignature(await client.readRow(table, pk))

  if (actual === expected) {
    return true
  }
  failures.push({
    step: n,
    message: `step ${n} local-row ${table}/${pk} diverged`,
    expected,
    actual,
  })

  return false
}

const checkScalar = (
  label: string,
  expected: string,
  actual: string,
  n: number,
  failures: TClientFailure[]
): boolean => {
  if (actual === expected) {
    return true
  }
  failures.push({ step: n, message: `step ${n} ${label} diverged`, expected, actual })

  return false
}

const interpretCheck = async (
  client: IProtocolClient,
  check: TJsonObject,
  n: number,
  failures: TClientFailure[],
  preRpc: TSnapshot | null,
  known: TKnownRows,
  /**
   * Events drained ONCE for the whole assert block (so multiple event checks in
   * one block share the same view, and stale events never leak across blocks).
   */
  events: string[]
): Promise<boolean> => {
  switch (check.check) {
    case 'cursor':
      return checkScalar('cursor', asString(check.value), await client.cursor(), n, failures)
    case 'outbox-depth':
      return checkScalar(
        'outbox-depth',
        String(check.value),
        String(await client.outboxDepth()),
        n,
        failures
      )
    case 'local-row':
      return checkRow(client, check, n, failures)
    case 'event': {
      const want = asString(check.event)

      if (events.includes(want)) {
        return true
      }
      failures.push({
        step: n,
        message: `step ${n} event ${want} not emitted`,
        expected: want,
        actual: events.length === 0 ? '(no events)' : events.join(', '),
      })

      return false
    }
    case 'no-intermediate-commit': {
      if (preRpc === null) {
        // No prior rpc to have (not) committed, so it vacuously holds.
        return true
      }
      const now = await snapshot(client, known)
      const expected = canonicalize({ cursor: preRpc.cursor, rows: mapToSorted(preRpc.rows) })
      const actual = canonicalize({ cursor: now.cursor, rows: mapToSorted(now.rows) })

      if (actual === expected) {
        return true
      }
      failures.push({
        step: n,
        message: `step ${n} no-intermediate-commit: a staged page became observable before the boundary`,
        expected,
        actual,
      })

      return false
    }
    default:
      // Closed vocabulary (transcript.schema.json): an unknown check is a corpus/harness drift, surfaced loudly (@../../../../CONVENTIONS.md), never a silent pass.
      failures.push({
        step: n,
        message: `step ${n} unknown check kind "${asString(check.check)}"`,
        expected: '(closed check vocabulary)',
        actual: asString(check.check),
      })

      return false
  }
}

/**
 * Canonicalize tolerates only sorted, JSON-shaped values; turn the row map into
 * a sorted array of [key, sig] pairs for a stable serialization.
 */
const mapToSorted = (map: Map<string, string>): Array<[string, string]> =>
  [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

// MARK: - Local step

/**
 * A `local` step normally applies and enqueues (P:outbox-and-serial-in-flight). When it carries
 * `expect_error` the engine MUST refuse it with that engine error code and MUST
 * leave the outbox untouched: the row and its outbox entry are one transaction,
 * so a refusal that queued anything would have written half of it
 * (lifecycle/004). A refusal that never came, or came with a different code, is
 * a divergence: the code is the contract, never the message text.
 */
async function runLocalStep(
  client: IProtocolClient,
  step: TJsonObject,
  n: number
): Promise<{ failures: TClientFailure[]; detail: string }> {
  const expected = asString(step.expect_error)
  const depthBefore = expected === '' ? 0 : await client.outboxDepth()

  try {
    await client.applyLocal(step as TTranscriptStep)
  } catch (error) {
    const code = engineErrorCode(error)

    if (expected === '') {
      return {
        failures: [
          {
            step: n,
            message: `step ${n} local apply threw`,
            expected: '(applied + enqueued)',
            actual: errorText(error),
          },
        ],
        detail: errorText(error),
      }
    }
    if (code !== expected) {
      return {
        failures: [
          { step: n, message: `step ${n} local refusal code diverged`, expected, actual: errorText(error) },
        ],
        detail: errorText(error),
      }
    }
    const depthAfter = await client.outboxDepth()

    if (depthAfter !== depthBefore) {
      return {
        failures: [
          {
            step: n,
            message: `step ${n} refused local write still touched the outbox (P:outbox-and-serial-in-flight)`,
            expected: String(depthBefore),
            actual: String(depthAfter),
          },
        ],
        detail: `${expected}: refused, but the outbox moved`,
      }
    }
    return { failures: [], detail: `local: refused ${expected}, outbox untouched (D-corpus-soft-delete-and-refusal)` }
  }
  if (expected !== '') {
    return {
      failures: [
        {
          step: n,
          message: `step ${n} local apply was accepted but the corpus pins a refusal (D-corpus-soft-delete-and-refusal)`,
          expected,
          actual: '(no throw)',
        },
      ],
      detail: `expected ${expected}, applied instead`,
    }
  }
  return { failures: [], detail: 'local: applied + enqueued (P:outbox-and-serial-in-flight)' }
}

/** The engine's machine-readable code; consumers never classify by message text. */
function engineErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : ''
}

// MARK: - runTranscriptClient

export const runTranscriptClient = async (
  client: IProtocolClient,
  transcript: unknown,
  candidate: TFencing
): Promise<TClientResult> => {
  const t = asObject(transcript)

  if (t === null) {
    throw new Error('runTranscriptClient: transcript must be a JSON object')
  }
  const caseId = asString(t.case)
  const fencing = asString(t.fencing)

  // A candidate-scoped transcript must be driven as the candidate it declares; 'shared' runs under any. A mismatch throws .
  if (fencing !== 'shared' && fencing !== candidate) {
    throw new Error(
      `runTranscriptClient: ${caseId} declares fencing "${fencing}" but was driven as ` +
        `"${candidate}" (path/field coherence)`
    )
  }

  // Establish the resume precondition BEFORE any step: seed the durable cursor to the first pull request's cursor (the persisted checkpoint the client resumed from). A no-op for fresh-start cases (cursor '0' / no pull step).
  const resumeCursor = firstPullCursor(t)

  if (resumeCursor !== undefined) {
    await client.seedCheckpoint(resumeCursor)
  }

  // Feed the ordered local-mutation ids (+ recovered preconditions) so the engine mints the transcript's pinned mutation_ids and emits push/004's precondition. Empty for pull-only cases, a harmless no-op there.
  client.seedLocalMutations(localMutationSpecs(t))

  const steps: TStepOutcome[] = []
  const failures: TClientFailure[] = []
  const known: TKnownRows = new Map()
  // The readable snapshot captured immediately before the most recent rpc/fault, used by no-intermediate-commit to prove a staged page did not commit.
  let preRpc: TSnapshot | null = null

  for (const raw of asArray(t.steps)) {
    const step = asObject(raw)

    if (step === null) {
      throw new Error('runTranscriptClient: every step must be a JSON object (I-2)')
    }
    const n = typeof step.n === 'number' ? step.n : 0
    const kind = asString(step.kind)

    noteRowsFromStep(step, known)

    if (kind === 'server') {
      // Out-of-band change by another actor: the client never sees it directly; its effect arrives baked into a later golden pull response.
      steps.push({ n, kind, ok: true, detail: 'server: baked into later pull bytes' })
    } else if (kind === 'rpc') {
      const rpc = step.rpc === 'push' ? 'push' : 'pull'

      preRpc = await snapshot(client, known)

      try {
        if (rpc === 'push') {
          await client.push(step as TTranscriptStep)
        } else {
          await client.pull(step as TTranscriptStep)
        }
        steps.push({ n, kind, ok: true, detail: `${rpc}: request bytes matched, response replayed` })
      } catch (error) {
        const failure = toFailure(n, error)

        steps.push({ n, kind, ok: false, detail: failure.message })
        failures.push(failure)
      }
    } else if (kind === 'fault') {
      preRpc = await snapshot(client, known)

      try {
        await client.injectFault(step as TTranscriptStep)
        const fault = asString(step.fault)

        steps.push({ n, kind, ok: true, detail: `${fault}: handled, nothing wrongly applied` })
      } catch (error) {
        const failure = toFailure(n, error)

        steps.push({ n, kind, ok: false, detail: failure.message })
        failures.push(failure)
      }
    } else if (kind === 'local') {
      const outcome = await runLocalStep(client, step, n)

      failures.push(...outcome.failures)
      steps.push({ n, kind, ok: outcome.failures.length === 0, detail: outcome.detail })
    } else if (kind === 'assert') {
      // Drain the event buffer once per block: every `event` check in this assert sees the same view, and events do not leak into a later block.
      const events = client.drainedEvents()
      let allOk = true

      for (const raw of asArray(step.checks)) {
        const check = asObject(raw)

        if (check === null) {
          continue
        }
        const ok = await interpretCheck(client, check, n, failures, preRpc, known, events)

        allOk = allOk && ok
      }
      steps.push({ n, kind, ok: allOk, detail: allOk ? undefined : 'one or more checks diverged' })
    } else {
      throw new Error(`runTranscriptClient: unknown step kind "${kind}" at n=${n}`)
    }
  }

  // Top-level postconditions: final-state obligations in the same Check vocab.
  const finalEvents = client.drainedEvents()

  for (const raw of asArray(t.postconditions)) {
    const check = asObject(raw)

    if (check === null) {
      continue
    }
    const ok = await interpretCheck(client, check, 0, failures, preRpc, known, finalEvents)

    steps.push({
      n: 0,
      kind: 'postcondition',
      ok,
      detail: ok ? undefined : `postcondition ${asString(check.check)} diverged`,
    })
  }

  return failures.length === 0
    ? { status: 'pass', case: caseId, candidate, steps }
    : { status: 'fail', case: caseId, candidate, steps, failures }
}

// MARK: - Failure mapping

/**
 * A RequestDivergenceError carries the canonical expected/actual request bytes;
 * any other throw becomes a single-line failure with the error text as actual.
 */
const toFailure = (n: number, error: unknown): TClientFailure => {
  if (error instanceof RequestDivergenceError) {
    return {
      step: n,
      message: `step ${n} ${error.rpc}: ${error.message}`,
      expected: error.expected,
      actual: error.actual,
    }
  }
  return {
    step: n,
    message: `step ${n} threw: the corpus pins this step`,
    expected: '(no throw)',
    actual: errorText(error),
  }
}

// MARK: - runCorpusClient

/**
 * Manifest-driven, identical iteration to executor.ts runCorpus: blocked entries
 * (file:null + blocked_on) surface skipped-blocked carrying the manifest entry's
 * notes as the reason; every other entry runs ONCE under the visibility horizon,
 * the fencing mechanism D-visibility-horizon decided. The client is
 * fencing-agnostic at the wire level: it consumes responses
 * (P:keyset-pagination-and-delivery-bound / I-4). makeClient builds a FRESH
 * client per run (fresh db).
 */
export const runCorpusClient = async (
  root: string,
  makeClient: (config: TEngineConfig) => IProtocolClient
): Promise<TClientResult[]> => {
  const manifest = asObject(readCorpusFile(root, 'cases/manifest.json').json)
  const results: TClientResult[] = []

  const runOne = async (file: string, candidate: TFencing): Promise<void> => {
    const transcript = readCorpusFile(root, file).json
    const config = configFromContext(asObject(transcript) ?? {})

    results.push(await runTranscriptClient(makeClient(config), transcript, candidate))
  }

  for (const raw of asArray(manifest?.cases)) {
    const entry = asObject(raw)

    if (entry === null) {
      continue
    }
    const id = asString(entry.id)

    if (entry.file === null) {
      results.push({
        status: 'skipped-blocked',
        case: id,
        blocked_on: asArray(entry.blocked_on)
          .map(asString)
          .filter((gate) => gate !== ''),
        reason: asArray(entry.notes)
          .map(asString)
          .filter((note) => note !== '')
          .join(' · '),
      })
      continue
    }

    if (typeof entry.file === 'string') {
      await runOne(entry.file, EFencing.visibilityHorizon)
    }
  }
  return results
}
