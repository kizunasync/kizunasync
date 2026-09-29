/**
 * Transcript executor.
 *
 * Replays golden transcripts against any IProtocolServer: 'server' steps
 * drive oracle-side setup, 'rpc' steps byte-compare the server's response to
 * the golden slice through the EXISTING harness canonicalizer: every
 * transcript file is byte-canonical (I-1, C-1..C-9), so equality of the two
 * depth-0 canonical serializations is exactly byte-equality of the golden
 * response slice (C-7). Fault steps encode the at-least-once transport
 * (P:session-guarantees-and-exactly-once-effect, P:verdict-completeness-transforms-and-conflict-rejection). This server-facing executor records local/assert steps because an
 * IProtocolServer cannot answer client-state obligations. The separate Rust
 * conformance runner executes those steps and top-level postconditions against
 * SyncEngine.
 */

import { canonicalize } from '../harness/canonical'
import { readCorpusFile } from '../harness/load'
import type { TPullRequest, TPushRequest } from '../spec/wire-types'
import type { THeldTxn, TScenario } from './scenarios'
import { SCENARIOS } from './scenarios'
import { EFencing } from './server-contract'
import type { IProtocolServer, TFencing, TServerRowChange, TServerSeed, TServerTableConfig } from './server-contract'

// MARK: - Result types

export type TStepOutcome = { n: number; kind: string; ok: boolean; detail?: string }

export type TExecutionFailure = {
  step: number
  rpc: 'pull' | 'push'
  message: string
  expected: string
  actual: string
}

export type TCaseResult =
  | { status: 'pass'; case: string; fencing: TFencing; steps: TStepOutcome[] }
  | {
      status: 'fail'
      case: string
      fencing: TFencing
      steps: TStepOutcome[]
      failures: TExecutionFailure[]
    }
  | { status: 'skipped-blocked'; case: string; blocked_on: string[]; reason: string }

// MARK: - JSON guards

type TJsonObject = Record<string, unknown>

const isObject = (value: unknown): value is TJsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asObject = (value: unknown): TJsonObject | null => (isObject(value) ? value : null)

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

// MARK: - Seed assembly

function parseTableConfigs(serverConfig: TJsonObject): Record<string, TServerTableConfig> {
  const tables: Record<string, TServerTableConfig> = {}

  for (const [name, raw] of Object.entries(asObject(serverConfig.tables) ?? {})) {
    const tableConfig: TServerTableConfig = { bucket_column: asString(asObject(raw)?.bucket_column) }

    // conflict_mode is the per-table opt-in: 'hlc' selects origin-order resolution, absent or 'arrival' selects the arrival-order default.
    if (asObject(raw)?.conflict_mode === 'hlc') {
      tableConfig.conflict_mode = 'hlc'
    }
    if (asObject(raw)?.conflict_journal === true) {
      tableConfig.conflict_journal = true
    }
    tables[name] = tableConfig
  }
  return tables
}

function resolveRunSeed(fencing: TFencing, scenario: TScenario): Pick<TServerSeed, 'fencing' | 'next_seq' | 'history'> {
  return { fencing, next_seq: scenario.next_seq ?? '1', history: scenario.history ?? [] }
}

const seedFromContext = (
  context: TJsonObject,
  fencing: TFencing,
  scenario: TScenario
): TServerSeed => {
  const serverConfig = asObject(context.server) ?? {}
  const seed: TServerSeed = {
    client_id: asString(context.client_id),
    user_id: asString(context.user_id),
    min_schema_version:
      typeof serverConfig.min_schema_version === 'number' ? serverConfig.min_schema_version : 0,
    tables: parseTableConfigs(serverConfig),
    tombstone_ttl_days:
      typeof serverConfig.tombstone_ttl_days === 'number' ? serverConfig.tombstone_ttl_days : 0,
    ...resolveRunSeed(fencing, scenario),
  }

  if (typeof serverConfig.max_pull_scan === 'number') {
    seed.max_pull_scan = serverConfig.max_pull_scan
  }

  return seed
}

// MARK: - Step helpers

const serverChangeFromStep = (step: TJsonObject, txn: string | undefined): TServerRowChange => {
  const change: TServerRowChange = {
    actor: asString(step.actor),
    op: step.op === 'delete' ? 'delete' : 'upsert',
    table: asString(step.table),
    pk: asString(step.pk),
  }
  const columns = asObject(step.columns)

  if (columns !== null) {
    change.columns = columns as TServerRowChange['columns'] // I-2-validated golden bytes (scalar column values)
  }
  if (typeof step.hlc === 'string') {
    change.hlc = step.hlc // origin HLC the oracle stamps for hlc-mode tables (conflict/003)
  }
  if (txn !== undefined) {
    change.txn = txn
  }
  return change
}

const invokeRpc = (server: IProtocolServer, rpc: 'pull' | 'push', request: unknown): unknown =>
  rpc === 'pull'
    ? server.pull(request as TPullRequest) // I-2: the harness schema-validates every golden rpc payload
    : server.push(request as TPushRequest) // I-2: the harness schema-validates every golden rpc payload

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

// MARK: - Step handlers

/** The state one transcript run threads through its step handlers; `scenario` is already defaulted. */
type TRunContext = {
  server: IProtocolServer
  scenario: TScenario
  heldTxns: THeldTxn[]
  steps: TStepOutcome[]
  failures: TExecutionFailure[]
}

type TParsedStep = { n: number; kind: string; raw: TJsonObject }

type TStepHandler = (ctx: TRunContext, step: TParsedStep) => void

function runServerStep(ctx: TRunContext, { n, kind, raw }: TParsedStep): void {
  // A `reap` server step runs the tombstone reaper: a change with no row, never an upsert (SQL:tombstone-reaping).
  if (raw.op === 'reap') {
    ctx.server.applyServerChange({ op: 'reap' })
    ctx.steps.push({ n, kind, ok: true, detail: 'reap' })

    return
  }
  // A 'server' step is another actor's change, applied as oracle-side setup (SQL:changelog-op).
  const txn = ctx.heldTxns.find((held) => held.step === n)?.txn

  ctx.server.applyServerChange(serverChangeFromStep(raw, txn))

  if (txn !== undefined) {
    ctx.steps.push({ n, kind, ok: true, detail: `held txn ${txn}` })
  } else {
    ctx.steps.push({ n, kind, ok: true })
  }
}

function runRpcStep(ctx: TRunContext, { n, kind, raw }: TParsedStep): void {
  const rpc = raw.rpc === 'push' ? 'push' : 'pull'
  const expected = canonicalize(raw.response)

  try {
    const actual = canonicalize(invokeRpc(ctx.server, rpc, raw.request))

    if (actual === expected) {
      ctx.steps.push({ n, kind, ok: true })
    } else {
      ctx.steps.push({ n, kind, ok: false, detail: 'response diverged from the golden bytes' })
      ctx.failures.push({
        step: n,
        rpc,
        message: `step ${n} ${rpc}: response diverged from the golden bytes (C-7)`,
        expected,
        actual,
      })
    }
  } catch (error) {
    // A throw (incl. OpenDecisionError) at an rpc step is a failure.
    const detail = errorText(error)

    ctx.steps.push({ n, kind, ok: false, detail })
    ctx.failures.push({
      step: n,
      rpc,
      message: `step ${n} ${rpc} threw: the corpus pins response bytes here`,
      expected,
      actual: detail,
    })
  }
}

function runFaultStep(ctx: TRunContext, { n, kind, raw }: TParsedStep): void {
  if (raw.fault === 'drop-ack') {
    // The server applied, the ack was lost (P:session-guarantees-and-exactly-once-effect at-least-once): invoke the target exactly once, discard the response.
    const rpc = raw.target === 'push' ? 'push' : 'pull'

    try {
      invokeRpc(ctx.server, rpc, raw.request)
      ctx.steps.push({ n, kind, ok: true, detail: 'drop-ack: applied, response discarded' })
    } catch (error) {
      const detail = errorText(error)

      ctx.steps.push({ n, kind, ok: false, detail })
      ctx.failures.push({
        step: n,
        rpc,
        message: `step ${n} drop-ack ${rpc} threw: the server must apply (P:session-guarantees-and-exactly-once-effect)`,
        expected: '(response discarded)',
        actual: detail,
      })
    }
  } else {
    // transport-error: the request was never applied, NO server invocation at all (P:verdict-completeness-transforms-and-conflict-rejection).
    ctx.steps.push({ n, kind, ok: true, detail: 'transport-error: request never applied' })
  }
}

function recordLocalStep(ctx: TRunContext, { n, kind }: TParsedStep): void {
  // A 'local' step is a client write plus an outbox enqueue (P:outbox-and-serial-in-flight); its wire effect rides in the later push request bytes, so the oracle does nothing here.
  ctx.steps.push({ n, kind, ok: true, detail: 'client-local' })
}

function recordAssertStep(ctx: TRunContext, { n, kind }: TParsedStep): void {
  // This server-facing executor records client-state obligations; the Rust conformance runner executes them against SyncEngine.
  ctx.steps.push({ n, kind, ok: true, detail: 'client-obligation-skipped' })
}

const STEP_HANDLERS: Record<string, TStepHandler> = {
  server: runServerStep,
  rpc: runRpcStep,
  fault: runFaultStep,
  local: recordLocalStep,
  assert: recordAssertStep,
}

// MARK: - runTranscript

/** A transcript past its object and fencing-coherence guards; `context` is an empty object when absent. */
type TOpenedTranscript = { caseId: string; context: TJsonObject; steps: unknown[] }

type TRunContextOptions = { server: IProtocolServer; scenario?: TScenario }

function openTranscript(transcript: unknown, fencing: TFencing): TOpenedTranscript {
  const t = asObject(transcript)

  if (t === null) {
    throw new Error('runTranscript: transcript must be a JSON object')
  }
  const caseId = asString(t.case)
  const declared = asString(t.fencing)

  // A mechanism-scoped transcript must be driven as the mechanism it declares; 'shared' runs under any (fail loud).
  if (declared !== 'shared' && declared !== fencing) {
    throw new Error(
      `runTranscript: ${caseId} declares fencing "${declared}" but was driven as "${fencing}" ` +
        '(path/field coherence)'
    )
  }
  return { caseId, context: asObject(t.context) ?? {}, steps: asArray(t.steps) }
}

function createRunContext({ server, scenario = {} }: TRunContextOptions): TRunContext {
  return { server, scenario, heldTxns: scenario.held_txns ?? [], steps: [], failures: [] }
}

function parseStep(raw: unknown): TParsedStep {
  const step = asObject(raw)

  if (step === null) {
    throw new Error('runTranscript: every step must be a JSON object (I-2)')
  }
  return { n: typeof step.n === 'number' ? step.n : 0, kind: asString(step.kind), raw: step }
}

function dispatchStep(ctx: TRunContext, step: TParsedStep): void {
  // Own keys only: an inherited name such as "constructor" is an unknown kind, never Object.prototype's function.
  const handler = Object.hasOwn(STEP_HANDLERS, step.kind) ? STEP_HANDLERS[step.kind] : undefined

  if (handler === undefined) {
    throw new Error(`runTranscript: unknown step kind "${step.kind}" at n=${step.n}`)
  }
  handler(ctx, step)
}

function resolveHeldTxns(ctx: TRunContext, n: number): void {
  for (const held of ctx.heldTxns) {
    if (held.commit_after_step === n) {
      ctx.server.commitTxn(held.txn)
    }
  }
}

export const runTranscript = (
  server: IProtocolServer,
  transcript: unknown,
  fencing: TFencing,
  scenario?: TScenario
): TCaseResult => {
  const opened = openTranscript(transcript, fencing)
  const ctx = createRunContext({ server, scenario })

  server.seed(seedFromContext(opened.context, fencing, ctx.scenario))

  for (const raw of opened.steps) {
    const step = parseStep(raw)

    server.setStep(step.n)
    dispatchStep(ctx, step)
    // After EVERY step n: held txns with commit_after_step === n resolve (the supastash late-commit race, fencing/001 context.notes).
    resolveHeldTxns(ctx, step.n)
  }

  return ctx.failures.length === 0
    ? { status: 'pass', case: opened.caseId, fencing, steps: ctx.steps }
    : { status: 'fail', case: opened.caseId, fencing, steps: ctx.steps, failures: ctx.failures }
}

// MARK: - runCorpus

/**
 * Manifest-driven: blocked entries (file:null + blocked_on) surface
 * skipped-blocked with the OD reason; every other entry runs ONCE against the
 * fencing mechanism D-visibility-horizon decided, the Postgres transaction-visibility horizon.
 */
export const runCorpus = (root: string, makeServer: () => IProtocolServer): TCaseResult[] => {
  const manifest = asObject(readCorpusFile(root, 'cases/manifest.json').json)
  const results: TCaseResult[] = []

  for (const raw of asArray(manifest?.cases)) {
    const entry = asObject(raw)

    if (entry === null) {
      continue
    }
    const id = asString(entry.id)

    if (entry.file === null) {
      // A manifest entry with no transcript file is blocked on an open decision: record the skip, never fabricate a result.
      results.push({
        status: 'skipped-blocked',
        case: id,
        blocked_on: asArray(entry.blocked_on).map(asString).filter((gate) => gate !== ''),
        reason: asArray(entry.notes).map(asString).filter((note) => note !== '').join(' · '),
      })
      continue
    }

    const scenario = SCENARIOS[id]

    if (typeof entry.file === 'string') {
      const transcript = readCorpusFile(root, entry.file).json
      const fencing =
        asObject(transcript)?.fencing === EFencing.visibilityHorizon
          ? EFencing.visibilityHorizon
          : EFencing.shared

      results.push(runTranscript(makeServer(), transcript, fencing, scenario))
    }
  }
  return results
}
