/// <reference types="vite/client" />
// MARK: - The browser conformance page

/**
 * The same manifest, the same executor and the same golden bytes as
 * `packages/core/src/conformance/transport-client.test.ts`, driven through
 * `makeTransportClient` against the wasm engine the `@kizunasync/web` driver runs in a
 * dedicated worker. The NAPI lane proves the transport seam under bun; this page
 * proves the SAME seam in a real browser, worker and wasm included. Which VFS the
 * store picks is a separate obligation, asserted by `durability.spec.ts` and
 * `fallback.spec.ts`.
 *
 * The corpus is read in place through `import.meta.glob` (zero forked bytes;
 * @../../../CONVENTIONS.md): the protocol harness loader is a Node module, so
 * Vite serves the transcripts as JSON modules instead.
 *
 * Playwright drives this page in six ways:
 *   ?run=corpus    → the whole manifest; the summary lands in `#summary` and `window.__kizunasyncCorpus`
 *   ?run=parity    → the query parity vectors; `window.__kizunasyncParity`
 *   ?opfs=absent   → the worker's `getDirectory` is gone, as it is in a browser without OPFS
 *   ?opfs=off      → the worker's `getDirectory` rejects with a `SecurityError` (`refuse-opfs.ts` for why both exist)
 *   ?opfs=failing  → the worker's `getDirectory` rejects with a plain `Error`: an OPFS that exists and fails
 *   (no `run`)     → idle; the spec drives `window.__kizunasync` itself
 */

import { EFencing } from '@kizunasync/protocol/executor/server-contract'
import type { TFencing } from '@kizunasync/protocol/executor/server-contract'
import { configFromContext, FIXED_NOW, makeTransportClient, parseCallEnvelope, runTranscriptClient, TranscriptRemote } from '@kizunasync/core/conformance'
import type { IEngineTransport, TEngineConfig, TEngineTransportFactory } from '@kizunasync/core'
import { createWebWorkerDriver, type IRoleTransport } from '../src/worker-driver'
import { refuseOpfsInWorkers, type TOpfsRefusal } from './refuse-opfs'
import parityVectorsJson from '../../core/src/query/parity-vectors.json'

// MARK: - Constants

/** The single table the parity vectors are written against. */
const PARITY_TABLE = 'items'

/** The identity the parity engine opens with; the vectors never sync. */
const PARITY_CLIENT_ID = 'parity-transport-client'

const CORPUS_PREFIX = '../../protocol/'

// MARK: - The corpus, served as modules instead of files

const CORPUS: Record<string, unknown> = import.meta.glob(
  '../../protocol/{cases,transcripts,fixtures}/**/*.json',
  { eager: true },
)

// MARK: - JSON guards

type TJsonObject = Record<string, unknown>

function asObject(value: unknown): TJsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TJsonObject)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function readCorpusFile(relative: string): unknown {
  const module = asObject(CORPUS[CORPUS_PREFIX + relative])

  if (module === null) {
    throw new Error(`the conformance page cannot see corpus file "${relative}"`)
  }
  return module.default
}

// MARK: - Summary shapes

interface ICaseFailure {
  case: string
  step: number
  message: string
  expected: string
  actual: string
}

export interface ICorpusSummary {
  passed: number
  failed: number
  skipped: number
  failures: ICaseFailure[]
}

interface IVectorFailure {
  vector: string
  expected: string[]
  actual: string[]
}

export interface IParitySummary {
  vectors: number

  /**
   * Every vector's name, in order, so the spec can assert the oracle carries no
   * duplicate the way `transport-parity.test.ts` does.
   */
  names: string[]

  passed: number
  failed: number
  failures: IVectorFailure[]
}

// MARK: - One engine per case, behind the web driver's transport

interface IOpenedEngine {
  /** Handed to `makeTransportClient`, which opens the engine through it. */
  factory: TEngineTransportFactory

  /** The transport that factory returned, for the raw calls the specs make. */
  transport: () => IEngineTransport | null

  /** Closes the engine and settles once its worker is terminated. */
  close: () => Promise<void>
}

/**
 * The locator declares the core's factory, whose return type is the port's
 * `IEngineTransport`, but the web driver's own transport is the richer
 * `IRoleTransport` that reports when its worker is gone. Proved at runtime, not
 * assumed. Throws if the driver ever stops carrying it: a page that stopped
 * waiting would go back to overlapping workers on one store.
 */
function asRoleTransport(transport: IEngineTransport): IRoleTransport {
  if (typeof (transport as Partial<IRoleTransport>).whenClosed !== 'function') {
    throw new Error('the @kizunasync/web transport does not report when it closed')
  }
  return transport as IRoleTransport
}

/**
 * The driver's `engineTransport`, wrapped so the caller can close the transport
 * `makeTransportClient` opened behind it: the client has no lifecycle of its own.
 * Closing AWAITS the driver's teardown, so the next case or the reopening spec
 * never races the outgoing worker for the store it still holds.
 */
function openEngine(name: string): IOpenedEngine {
  const driver = createWebWorkerDriver(name)
  let opened: IRoleTransport | null = null

  return {
    factory: (configJson, databasePath, pull, push, onEvent): IEngineTransport => {
      opened = asRoleTransport(driver.engineTransport(configJson, databasePath, pull, push, onEvent))

      return opened
    },
    transport: (): IEngineTransport | null => opened,
    close: async (): Promise<void> => {
      const transport = opened

      if (transport === null) {
        return
      }
      transport.close()
      await transport.whenClosed()
    },
  }
}

/**
 * The raw calls this page makes outside the client adapter (`ping`, `store_kind`,
 * `query`), carrying the same pinned clock every other call does. The envelope is
 * read by the engine's own parser, so a failure surfaces as the typed
 * `TEngineError` an app would see, not as a second reader's guess.
 */
async function callTransport(
  transport: IEngineTransport,
  method: string,
  params: TJsonObject = {},
): Promise<unknown> {
  const envelope = await transport.call(
    method,
    JSON.stringify({ ...params, now: FIXED_NOW, now_ms: Date.parse(FIXED_NOW) }),
  )

  return parseCallEnvelope(envelope)
}

/** How long the engine's first call may hang before it counts as unanswered. */
const FIRST_CALL_TIMEOUT_MS = 30_000

/**
 * A worker that never loaded leaves its calls pending forever, which a runner can
 * only report as "the whole lane timed out"; this turns it into one named step.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const expiry = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label} did not settle in ${ms} ms`)), ms)
  })

  return Promise.race([work, expiry])
}

/**
 * One `ping`, bounded, with its failure propagated. A call issued before this tab
 * is promoted is carried over to its own worker and still executes exactly once
 * (`follower-transport.ts` `handOver`, re-issued by `worker-driver.ts` at
 * promotion). The lanes do not need the election to have settled. A worker that
 * never loaded is reported as this named step, not as a lane-wide timeout. It
 * retries nothing and swallows nothing: if the carry-over ever regressed, this is
 * the step that would fail.
 */
async function pingEngine(engine: IOpenedEngine): Promise<IEngineTransport> {
  const transport = engine.transport()

  if (transport === null) {
    throw new Error('the engine was never opened')
  }
  await withTimeout(callTransport(transport, 'ping'), FIRST_CALL_TIMEOUT_MS, "the engine's ping")

  return transport
}

// MARK: - The corpus lane

/**
 * A database name the election and a store both accept, derived from the
 * manifest id (`pull/001-bootstrap-empty`).
 */
function databaseNameFor(id: string): string {
  return `conformance-${id.replace(/[^a-z0-9]+/gi, '-')}`
}

async function runCase(
  id: string,
  file: string,
  candidate: TFencing,
  summary: ICorpusSummary,
): Promise<void> {
  let engine: IOpenedEngine | null = null

  try {
    const transcript = asObject(readCorpusFile(file)) ?? {}

    // One database per case: a case that fails mid-transcript leaks nothing into the next, and no two cases share a leader lock or a channel. The store is private and in-memory, exactly as the NAPI lane opens it. The corpus chooses that rather than being forced into it: a page can hold several OPFS databases at once (`two-databases.spec.ts`), and 38 pool installs would only cost the corpus time. What the store does is a separate obligation, asserted by `durability.spec.ts`, `fallback.spec.ts` and `busy.spec.ts`.
    engine = openEngine(databaseNameFor(id))
    const client = makeTransportClient({
      factory: engine.factory,
      config: configFromContext(transcript),
      clientId: asText(asObject(transcript.context)?.client_id),
      databasePath: null,
      remote: new TranscriptRemote(),
    })

    await pingEngine(engine)
    const result = await runTranscriptClient(client, transcript, candidate)

    if (result.status === 'fail') {
      summary.failed += 1

      for (const failure of result.failures) {
        summary.failures.push({ case: id, ...failure })
      }
      return
    }
    summary.passed += 1
  } catch (error) {
    summary.failed += 1
    summary.failures.push({
      case: id,
      step: 0,
      message: 'the case threw outside the executor',
      expected: '(no throw)',
      actual: errorText(error),
    })
  } finally {
    // Awaited: the next case must not open its store while this worker is still shutting down, and overlapping workers would stop the lane from measuring one engine at a time.
    await engine?.close()
  }
}

/**
 * The manifest loop of `transport-client.test.ts`, case for case: blocked
 * entries are skipped and every other entry runs its single file.
 */
async function runCorpus(): Promise<ICorpusSummary> {
  const manifest = asObject(readCorpusFile('cases/manifest.json'))
  const summary: ICorpusSummary = { passed: 0, failed: 0, skipped: 0, failures: [] }

  for (const raw of asArray(manifest?.cases)) {
    const entry = asObject(raw)

    if (entry === null) {
      continue
    }
    const id = asText(entry.id)

    if (entry.file === null) {
      summary.skipped += 1
      continue
    }
    if (typeof entry.file === 'string') {
      await runCase(id, entry.file, EFencing.visibilityHorizon, summary)
    }
  }
  return summary
}

// MARK: - The parity lane

interface IVector {
  name: string
  rows: TJsonObject[]
  plan: unknown
  expected: string[]
  expectError: boolean
}

const PARITY_CONFIG: TEngineConfig = {
  schemaVersion: 1,
  tables: { [PARITY_TABLE]: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } },
}

/**
 * A malformed oracle is a setup failure. It is never a vector that compares
 * against an empty row (@../../../CONVENTIONS.md), exactly as
 * `transport-parity.test.ts` reads it.
 */
function refuseVectors(message: string): never {
  throw new Error(`parity-vectors.json: ${message}`)
}

function readVectors(): IVector[] {
  const raw = asObject(parityVectorsJson as unknown)
  const list = Array.isArray(raw?.vectors) ? raw.vectors : refuseVectors('vectors must be an array')

  return list.map((entry, index) => {
    const vector = asObject(entry) ?? refuseVectors(`vectors[${index}] must be an object`)
    const name =
      typeof vector.name === 'string'
        ? vector.name
        : refuseVectors(`vectors[${index}].name must be a string`)
    const rows = Array.isArray(vector.rows) ? vector.rows : refuseVectors(`${name}.rows must be an array`)

    return {
      name,
      rows: rows.map((row, i) => asObject(row) ?? refuseVectors(`${name}.rows[${i}] must be an object`)),
      plan: vector.plan,
      expected: Array.isArray(vector.expected)
        ? vector.expected.map((id, i) =>
            typeof id === 'string' ? id : refuseVectors(`${name}.expected[${i}] must be a string`),
          )
        : refuseVectors(`${name}.expected must be an array`),
      expectError: vector.expectError === true,
    }
  })
}

/**
 * Element-wise, like the sibling's `toEqual`: joining would read `['a b']` and
 * `['a', 'b']` as the same result.
 */
function sameIds(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index])
}

/** `query` answers Many as an array, One as an object and Maybe as either or null. */
function resultIds(result: unknown): string[] {
  const rows = Array.isArray(result) ? result : result === null ? [] : [result]

  return rows.map((row) => asText(asObject(row)?.id) || '<missing id>')
}

/**
 * One engine per vector, in memory: the vector's rows are the whole store, and the
 * local query surface touches neither the remote nor the checkpoint.
 */
async function runVector(vector: IVector, index: number): Promise<string[]> {
  const engine = openEngine(`parity-${index}`)
  const client = makeTransportClient({
    factory: engine.factory,
    config: PARITY_CONFIG,
    clientId: PARITY_CLIENT_ID,
    databasePath: null,
    remote: new TranscriptRemote(),
  })

  try {
    const transport = await pingEngine(engine)

    for (const [rowIndex, row] of vector.rows.entries()) {
      await client.applyLocal({
        table: PARITY_TABLE,
        pk: asText(row.id),
        op: 'insert',
        columns: row,
        mutation_id: `parity-${rowIndex}`,
      })
    }
    return resultIds(
      await callTransport(transport, 'query', { table: PARITY_TABLE, plan: vector.plan }),
    )
  } finally {
    await engine.close()
  }
}

async function runParity(): Promise<IParitySummary> {
  const vectors = readVectors()
  const summary: IParitySummary = {
    vectors: vectors.length,
    names: vectors.map((vector) => vector.name),
    passed: 0,
    failed: 0,
    failures: [],
  }

  for (const [index, vector] of vectors.entries()) {
    let actual: string[]

    try {
      actual = await runVector(vector, index)
    } catch (error) {
      if (vector.expectError) {
        summary.passed += 1
      } else {
        summary.failed += 1
        summary.failures.push({
          vector: vector.name,
          expected: vector.expected,
          actual: [errorText(error)],
        })
      }
      continue
    }
    if (vector.expectError) {
      summary.failed += 1
      summary.failures.push({ vector: vector.name, expected: ['(a refusal)'], actual })
    } else if (sameIds(actual, vector.expected)) {
      summary.passed += 1
    } else {
      summary.failed += 1
      summary.failures.push({ vector: vector.name, expected: vector.expected, actual })
    }
  }
  return summary
}

// MARK: - The page

interface IConformancePage {
  /**
   * `table` opens the engine with that one table declared. A spec needs that to
   * write a row; without it the engine has no tables and answers only the
   * store-level calls.
   */
  open(options: { name: string; databasePath: string | null; table?: string }): Promise<void>

  call(method: string, params?: TJsonObject): Promise<unknown>

  /**
   * The same call, addressed by name. Several engines can be open at once, so a
   * spec that opened two says which one it means; `call` is the last one opened.
   */
  callOn(name: string, method: string, params?: TJsonObject): Promise<unknown>

  /**
   * One row into the named engine, through the client adapter that opened it.
   * The engine must have been opened with `table`.
   */
  insertOn(name: string, table: string, columns: TJsonObject): Promise<void>

  /** Closes every open engine and settles once their workers are terminated. */
  close(): Promise<void>

  /** Close one engine, await its teardown, and leave the others running. */
  closeOn(name: string): Promise<void>

  runCorpus(): Promise<ICorpusSummary>
  runParity(): Promise<IParitySummary>
}

declare global {
  interface Window {
    __kizunasync: IConformancePage
    __kizunasyncCorpus?: ICorpusSummary
    __kizunasyncParity?: IParitySummary
  }
}

function report(summary: unknown): void {
  const element = document.getElementById('summary')

  if (element !== null) {
    element.textContent = JSON.stringify(summary, null, 2)
  }
}

/** The interactive specs drive `ping` and `store_kind`, which read no table. */
const IDLE_CONFIG: TEngineConfig = { schemaVersion: 1, tables: {} }

/**
 * One declared table, shaped like the parity lane's so a written row travels the
 * path this page already exercises, not a second one invented here.
 */
function tableConfig(table: string): TEngineConfig {
  return {
    schemaVersion: 1,
    tables: { [table]: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } },
  }
}

/**
 * What the page keeps per open engine: the transport the raw calls go through,
 * and the client adapter that owns the write path.
 */
interface IPageEngine {
  engine: IOpenedEngine
  client: ReturnType<typeof makeTransportClient>
}

function createPage(): IConformancePage {
  // Keyed by database name, because a spec may hold several open at once. The corpus and parity lanes open theirs directly and never land here.
  const engines = new Map<string, IPageEngine>()
  let latest: string | null = null

  const require = (name: string | null): IPageEngine => {
    const opened = name === null ? undefined : engines.get(name)

    if (opened === undefined) {
      throw new Error(`the conformance page has no engine open for "${String(name)}"`)
    }
    return opened
  }

  const transportFor = (name: string | null): IEngineTransport => {
    const transport = require(name).engine.transport()

    if (transport === null) {
      throw new Error(`the engine for "${String(name)}" was never opened`)
    }
    return transport
  }

  return {
    open: async (options): Promise<void> => {
      const opened = openEngine(options.name)
      // Built for the engine it opens: the client adapter is the one encoder of the Rust config, so the page never spells that JSON itself.
      const client = makeTransportClient({
        factory: opened.factory,
        config: options.table === undefined ? IDLE_CONFIG : tableConfig(options.table),
        clientId: options.name,
        databasePath: options.databasePath,
        remote: new TranscriptRemote(),
      })

      engines.set(options.name, { engine: opened, client })
      latest = options.name
      await pingEngine(opened)
    },
    call: async (method, params = {}): Promise<unknown> =>
      callTransport(transportFor(latest), method, params),
    callOn: async (name, method, params = {}): Promise<unknown> =>
      callTransport(transportFor(name), method, params),
    insertOn: async (name, table, columns): Promise<void> => {
      await require(name).client.applyLocal({
        table,
        pk: asText(columns.id),
        op: 'insert',
        columns,
        mutation_id: `${name}-${String(engines.size)}-${asText(columns.id)}`,
      })
    },
    // Both closers settle only once the workers are gone, so a spec that reopens the same database is never racing the outgoing one for its store.
    close: async (): Promise<void> => {
      const closing = [...engines.values()].map((opened) => opened.engine.close())

      engines.clear()
      latest = null
      await Promise.all(closing)
    },
    closeOn: async (name): Promise<void> => {
      const opened = engines.get(name)

      engines.delete(name)

      if (latest === name) {
        latest = null
      }
      await opened?.engine.close()
    },
    // A lane that throws before it can count anything still publishes a summary: a spec waiting on one would otherwise report a timeout and no reason.
    runCorpus: async (): Promise<ICorpusSummary> => {
      const summary = await runCorpus().catch(
        (error: unknown): ICorpusSummary => ({
          passed: 0,
          failed: 1,
          skipped: 0,
          failures: [
            {
              case: '(the page)',
              step: 0,
              message: 'the corpus lane threw',
              expected: '(a summary)',
              actual: errorText(error),
            },
          ],
        }),
      )

      window.__kizunasyncCorpus = summary
      report(summary)

      return summary
    },
    runParity: async (): Promise<IParitySummary> => {
      const summary = await runParity().catch(
        (error: unknown): IParitySummary => ({
          vectors: 0,
          names: [],
          passed: 0,
          failed: 1,
          failures: [{ vector: '(the page)', expected: ['(a summary)'], actual: [errorText(error)] }],
        }),
      )

      window.__kizunasyncParity = summary
      report(summary)

      return summary
    },
  }
}

const flags = new URLSearchParams(globalThis.location.search)

/**
 * `absent` is what a browser without OPFS does and `off` is a private-mode refusal;
 * both must reach `relaxed-idb`. `failing` is an OPFS that exists and fails, which
 * must fail the open instead.
 */
const REFUSALS_BY_FLAG: Record<string, TOpfsRefusal> = { absent: 'absent', off: 'rejecting', failing: 'failing' }

const refusal = REFUSALS_BY_FLAG[flags.get('opfs') ?? '']

if (refusal !== undefined) {
  refuseOpfsInWorkers(refusal)
}

window.__kizunasync = createPage()

const lane = flags.get('run')

if (lane === 'corpus') {
  void window.__kizunasync.runCorpus()
} else if (lane === 'parity') {
  void window.__kizunasync.runParity()
}
