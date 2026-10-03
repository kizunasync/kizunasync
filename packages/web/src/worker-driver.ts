/**
 * @kizunasync/web worker driver: the browser's Rust engine, seen from the page.
 *
 * The driver is a locator carrying an `engineTransport`. The app client calls it on
 * its first engine call, that call joins or wins the election for the database,
 * and from there the Rust engine in one tab's worker owns it. What crosses this
 * file is the engine's own call surface plus the two directions it needs back on
 * the page: the protocol remote (`pull`/`push`, so transport, auth and retry
 * classification stay in the app) and the event stream. The page opens no
 * database of its own: reading one around the engine's back would read a
 * connection the engine does not own.
 *
 * Only the leading tab spawns a worker. A follower's calls are posted to that tab
 * and answered from its worker, and its events arrive rebroadcast. When the
 * leader goes away, a follower is promoted and swaps a worker in behind the same
 * transport object (`createRustEngine` keeps the transport it was handed).
 */

// MARK: - @kizunasync/web worker driver

import { EEngineErrorCode, isJsonObject, parseFailureEnvelope, readEngineJson, TEngineError } from '@kizunasync/core'
import type { IEngineLeadership, IEngineTransport, ILogger, IStoreLocator, TEngineTransportFactory, TStoreDurability } from '@kizunasync/core'
import { createWebConnectivity } from './connectivity'
import { errorMessage } from './error-message'
import { createFollowerTransport, LEADER_GONE } from './follower-transport'
import type { IFollowerTransport } from './follower-transport'
import { electLeader, hasWebLocks, type ILeaderFailure } from './leader'
import { isLeaderMessage, SCOPE_PREFIX } from './leader-protocol'
import type { TLeaderRequest, TLeaderResponse } from './leader-protocol'
import { CRASH_RECOVERY_METHOD } from './worker-protocol'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

export interface IWebEngineDriver extends IStoreLocator {
  /**
   * Always present: this driver exists to carry the engine its worker runs.
   * Narrowed from the optional port member so a caller can invoke it.
   */
  readonly engineTransport: TEngineTransportFactory

  /**
   * What a write this store acknowledged survives. Absent until the engine has
   * opened the store and answered `store_kind`, except on a tab without Web
   * Locks, whose memory store is `'none'` from the start.
   */
  readonly durability?: TStoreDurability
}

const CLOSED = 'the @kizunasync/web engine transport is closed'

const DURABILITIES = new Set<string>(['full', 'relaxed', 'none'])

/** The engine's answer to a crash recovery, given to a page that asks for one. */
const RECOVERED = '{"ok":true,"value":null}'

/**
 * How long `close()` waits for the worker to acknowledge before terminating it
 * anyway. The graceful `free()` is attempted, never waited on indefinitely: a
 * worker blocked on a call that cannot settle would otherwise hold its OPFS
 * access handles until the tab dies.
 */
const CLOSE_TIMEOUT_MS = 5_000

/**
 * Unreachable in practice: both paths run `onFollower` before `electLeader`
 * returns, so a role is in place before the first call can be made.
 */
const NO_ENGINE = 'the @kizunasync/web engine transport has no engine'

interface IPending {
  resolve: (value: string) => void
  reject: (reason: Error) => void
}

function unavailable(message: string): TEngineError {
  return new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, message)
}

/**
 * A failure the worker answered with the engine's own envelope keeps the engine's
 * code. A store another tab holds (`STORE_BUSY`, worth retrying) stays apart from
 * one this browser can never have (`STORE_UNAVAILABLE`); it does not arrive as
 * one opaque sentence. The envelope is read by the core's own parser, so the page
 * and a direct caller cannot drift on one wire shape. Anything else is what it
 * always was: the transport had no engine to give.
 */
function fromWorkerFailure(raw: string): TEngineError {
  const failure = parseFailureEnvelope(raw)

  if (failure === null) {
    return unavailable(raw)
  }
  ;(failure as TEnvelopeCarrier).engineEnvelope = raw

  return failure
}

/**
 * A transport failure carries no envelope of its own, but a follower's call has to
 * be answered with one: re-encoding it as the engine's `engine_unavailable` failure
 * gets the follower the same typed error the leader's own page saw.
 */
function unavailableEnvelope(message: string): string {
  return JSON.stringify({ ok: false, error: { kind: 'engine_unavailable', message } })
}

/**
 * The engine's own failure envelope, kept on the error the transport threw. A
 * leader answering a follower re-posts these bytes; it does not re-encode them.
 * The follower rebuilds exactly the failure the leader's page saw: a store
 * another context holds must not reach it flattened to ENGINE_UNAVAILABLE.
 */
type TEnvelopeCarrier = { engineEnvelope?: string }

function answerEnvelope(error: unknown): string {
  const carried = (error as TEnvelopeCarrier | null)?.engineEnvelope

  return typeof carried === 'string' ? carried : unavailableEnvelope(errorMessage(error))
}

/**
 * The wasm bridge reads `database_path` out of the config it is created with, so
 * the path the engine selection resolved is merged in here, not riding as a
 * second field the worker would have to re-join. A config that is not a JSON
 * object is the engine's `JSON` failure, and the open is never posted.
 */
function withDatabasePath(configJson: string, databasePath: string | null): string {
  return JSON.stringify({ ...readEngineJson(configJson, isJsonObject), database_path: databasePath })
}

/** The `store_kind` envelope's durability, or null when the answer is unreadable. */
function readDurability(envelope: string): TStoreDurability | null {
  try {
    const parsed = JSON.parse(envelope) as { ok?: unknown; value?: { durability?: unknown } }
    const durability = parsed.ok === true ? parsed.value?.durability : undefined

    return typeof durability === 'string' && DURABILITIES.has(durability)
      ? (durability as TStoreDurability)
      : null
  } catch {
    return null
  }
}

// MARK: - The leader's transport

/**
 * Where the worker fetches `kizunasync_wasm_bg.wasm`: a URL, or a function
 * called when the worker spawns, so a page that builds its driver where there
 * is no `location` to resolve against (a static render) never calls it.
 * Unset, or a function answering undefined, leaves the worker on the reference
 * its bundler rewrote, as Vite does.
 */
export type TWasmUrl = string | URL | (() => string | URL | undefined)

/** The URL a spawning worker is told, `undefined` for its own bundled one. */
function resolveWasmUrl(wasmUrl: TWasmUrl | undefined): string | undefined {
  const resolved = typeof wasmUrl === 'function' ? wasmUrl() : wasmUrl

  return resolved instanceof URL ? resolved.href : resolved
}

interface IWorkerOptions {
  configJson: string
  databasePath: string | null
  wasmUrl?: TWasmUrl

  pull: (requestJson: string) => Promise<string>
  push: (requestJson: string) => Promise<string>
  onEvent: (eventJson: string) => void
  onDurability: (durability: TStoreDurability) => void

  /**
   * The worker died under this tab. Leadership has to move; this transport stays
   * failed. The page fails; it does not pretend to hold a database.
   */
  onFailure: (error: TEngineError) => void

  closeTimeoutMs: number
}

interface IWorkerTransport extends IEngineTransport {
  /**
   * Settles when `close()` has finished: the worker acknowledged and was
   * terminated, or the budget expired and it was terminated anyway.
   */
  readonly terminated: Promise<void>
}

/** What one worker transport mutates, shared by the functions below. */
interface IWorkerState {
  readonly worker: Worker
  readonly options: IWorkerOptions
  readonly pending: Map<number, IPending>
  nextId: number
  closed: boolean

  /**
   * A worker that died after the open resolved leaves `opened` fulfilled, so the
   * failure has to be latched: without it a later call would await a settled
   * promise, post to a dead worker and never settle.
   */
  failure: TEngineError | null
}

function createWorkerTransport(options: IWorkerOptions): IWorkerTransport {
  const { configJson, databasePath, onDurability, onFailure } = options
  const wasmUrl = resolveWasmUrl(options.wasmUrl)
  // Vite/bundlers turn this `new URL(..., import.meta.url)` form into a separate worker chunk; `{ type: 'module' }` keeps the worker's own imports as ESM.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const state: IWorkerState = { worker, options, pending: new Map(), nextId: 1, closed: false, failure: null }
  let resolveTerminated: () => void = () => undefined
  const terminated = new Promise<void>((resolve) => {
    resolveTerminated = resolve
  })

  worker.addEventListener('message', (event: MessageEvent<TWorkerResponse>) => {
    receiveFromWorker(state, event.data)
  })

  // A worker-level failure (the wasm module never loaded, the worker crashed) fails the open and every outstanding call; it does not hang them. It tells the page so the database can be led from another tab.
  worker.addEventListener('error', (event) => {
    const failure = unavailable(event.message || 'the @kizunasync/web worker crashed')

    state.failure = failure
    failAll(state, failure)
    onFailure(failure)
  })

  const opened = send(state, (id) => ({
    type: 'open',
    id,
    configJson: withDatabasePath(configJson, databasePath),
    ...(wasmUrl !== undefined ? { wasmUrl } : {}),
  }))

  // Nothing observes `opened` until the first call, and an unobserved rejection is reported by the runtime; every caller re-reads it below.
  void opened.catch(() => undefined)

  // Checked on both sides of the await: the worker can die, or the transport be closed, between the open resolving and this continuation running.
  const call = async (method: string, paramsJson: string): Promise<string> => {
    refuseIfUnusable(state)
    await opened
    refuseIfUnusable(state)

    return send(state, (id) => ({ type: 'call', id, method, paramsJson }))
  }

  void opened
    .then(() => call('store_kind', '{}'))
    .then((envelope) => {
      const durability = readDurability(envelope)

      if (durability !== null) {
        onDurability(durability)
      }
    })
    .catch(() => undefined)

  return {
    call,
    terminated,
    close: () => {
      closeWorker(state, resolveTerminated)
    },
  }
}

function send(state: IWorkerState, build: (id: number) => TWorkerRequest): Promise<string> {
  const id = state.nextId++

  return new Promise<string>((resolve, reject) => {
    state.pending.set(id, { resolve, reject })
    state.worker.postMessage(build(id))
  })
}

function failAll(state: IWorkerState, error: Error): void {
  for (const entry of state.pending.values()) {
    entry.reject(error)
  }
  state.pending.clear()
}

function refuseIfUnusable(state: IWorkerState): void {
  if (state.failure !== null) {
    throw state.failure
  }
  if (state.closed) {
    throw unavailable(CLOSED)
  }
}

function receiveFromWorker(state: IWorkerState, message: TWorkerResponse): void {
  const { onEvent } = state.options

  if (message.type === 'event') {
    onEvent(message.eventJson)

    return
  }
  if (message.type === 'remote') {
    void answerRemote(state, message)

    return
  }
  const entry = state.pending.get(message.id)

  if (entry === undefined) {
    return
  }
  state.pending.delete(message.id)

  if (message.ok) {
    entry.resolve(message.value)
  } else {
    entry.reject(fromWorkerFailure(message.error))
  }
}

/**
 * The page owns the transport, so a remote failure comes back as an envelope the
 * engine can classify, never as a rejected round trip.
 */
async function answerRemote(
  state: IWorkerState,
  message: Extract<TWorkerResponse, { type: 'remote' }>,
): Promise<void> {
  const { worker } = state
  const { pull, push } = state.options
  let value: string

  try {
    value = await (message.kind === 'pull' ? pull : push)(message.requestJson)
  } catch (error) {
    value = remoteFailureEnvelope(error)
  }
  worker.postMessage({ type: 'remote-result', id: message.id, ok: true, value })
}

/**
 * A remote that threw, encoded as `@kizunasync/core`'s remote bridge encodes one
 * and the engine's remote envelope parser reads it: the message, a string `code`
 * when the failure carried one, and `retryable` unless the failure said `false`.
 * A rejected round trip would reach the engine as a retryable fault with no code.
 */
function remoteFailureEnvelope(error: unknown): string {
  const carried = typeof error === 'object' && error !== null ? (error as { retryable?: unknown; code?: unknown }) : {}
  const failure = { ok: false, message: errorMessage(error), retryable: carried.retryable !== false }

  return JSON.stringify(typeof carried.code === 'string' ? { ...failure, code: carried.code } : failure)
}

function closeWorker(state: IWorkerState, onTerminated: () => void): void {
  if (state.closed) {
    return
  }
  state.closed = true
  const acknowledged = send(state, (id) => ({ type: 'close', id })).catch(() => undefined)
  let expiry: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    expiry = setTimeout(resolve, state.options.closeTimeoutMs)
  })

  void Promise.race([acknowledged, expired]).then(() => {
    clearTimeout(expiry)
    failAll(state, unavailable(CLOSED))
    state.worker.terminate()
    onTerminated()
  })
}

// MARK: - The two roles behind one transport

export interface IRoleTransport extends IEngineTransport {
  /**
   * Resolves once `close()` has finished: the answers this tab owed are posted,
   * its goodbye is out, and its worker is terminated. A page that means to reopen
   * the same database waits on this first, so the next engine is not racing the
   * old one for the store. Stays pending until `close()` is called.
   */
  whenClosed(): Promise<void>

  /**
   * Whether this tab leads the database: true from its promotion until its
   * worker dies or its promotion fails. Only the leading tab's app client drives
   * the automatic sync loop; a follower's calls still run on the leader's worker.
   */
  readonly leadership: IEngineLeadership
}

/** Derived from the core's factory, not copied, so the two cannot drift. */
export type TRoleTransportFactory = (
  ...args: Parameters<TEngineTransportFactory>
) => IRoleTransport

interface IRoleOptions {
  /** The database: what the lock and the tabs' channel are named after. */
  name: string

  configJson: string
  databasePath: string | null
  wasmUrl?: TWasmUrl
  pull: (requestJson: string) => Promise<string>
  push: (requestJson: string) => Promise<string>
  onEvent: (eventJson: string) => void
  onDurability: (durability: TStoreDurability) => void
  closeTimeoutMs: number
}

/** What one role transport mutates, shared by the functions below. */
interface IRoleState {
  readonly options: IRoleOptions
  current: IEngineTransport | null
  follower: IFollowerTransport | null
  leader: IWorkerTransport | null

  /**
   * A handed-over follower transport, kept alive only long enough to receive the
   * answers its old leader still owes the calls it had accepted.
   */
  draining: IFollowerTransport | null

  channel: BroadcastChannel | null

  /** The id this tab's `leader-ready`, `accepted` and goodbye carry, once it leads. */
  instance: string | null

  /** What `leadership.isLeader()` answers. */
  leading: boolean

  readonly leadershipListeners: Set<(leader: boolean) => void>

  /**
   * True only while this tab answers follower calls: it stops the moment the tab
   * starts closing or loses its worker, so the calls it will not finish stay
   * untaken and the next leader picks them up.
   */
  serving: boolean

  closed: boolean
  probed: boolean

  /**
   * Pending while this tab is taking the database over. Calls made during it
   * wait on it, so the hand-over stays the one place a call can change hands.
   */
  promotion: Promise<void> | null

  promotionFailure: string | undefined

  /**
   * Set only when this page failed to lead and no other page can: there is no
   * wait that could end well, so every call fails on it from then on.
   */
  fatal: TEngineError | null

  /**
   * Answers this tab accepted and has not posted yet. Closing waits for them: an
   * accepted call is never re-posted, so dropping one would strand it.
   */
  readonly owed: Set<Promise<void>>

  /** `election.release`, bound through a closure because the election is created after this record. */
  readonly releaseElection: () => Promise<void>
}

/**
 * One object, two roles. `createRustEngine` keeps the transport it was handed for
 * the engine's whole life. A tab promoted from follower to leader changes what it
 * delegates to, never which object it is. Calls in flight on the follower channel
 * are not thrown away with the role: the ones no leader took are re-issued on this
 * tab's own worker; the ones some leader took are left to be answered from where
 * they are already running. Only a call whose leader went away without answering
 * it fails, with ENGINE_UNAVAILABLE, which the engine layer reads as any other
 * engine failure. Nothing is replayed behind its back.
 */
function createRoleTransport(options: IRoleOptions): IRoleTransport {
  let resolveClosed: () => void = () => undefined
  const teardown = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const state: IRoleState = {
    options,
    current: null,
    follower: null,
    leader: null,
    draining: null,
    channel: null,
    instance: null,
    leading: false,
    leadershipListeners: new Set(),
    serving: false,
    closed: false,
    probed: false,
    promotion: null,
    promotionFailure: undefined,
    fatal: null,
    owed: new Set(),
    releaseElection: () => election.release(),
  }
  const election = electLeader(options.name, {
    onLeader: (instance) => becomeLeader(state, instance),
    onFollower: () => becomeFollower(state),
    onLeaderFailed: (failure) => leaderFailed(state, failure),
  })

  return {
    call: async (method, paramsJson) => {
      refuseIfFinished(state)

      // The worker recovers crashed transfers as it opens the store (worker-runtime.ts); run again for a tab that joins, it would reset the claims the leader's uploads hold.
      if (method === CRASH_RECOVERY_METHOD) {
        return RECOVERED
      }
      if (state.promotion !== null) {
        // Waiting here is what keeps the hand-over the only place a call changes hands: this one joins the inherited calls on the new worker, behind them.
        await state.promotion
        refuseIfFinished(state)
      }
      const transport = state.current

      if (transport === null) {
        throw unavailable(NO_ENGINE)
      }
      const asFollower = transport === state.follower
      const envelope = await transport.call(method, paramsJson)

      if (asFollower) {
        probeDurability(state, transport)
      }
      return envelope
    },
    close: () => {
      if (state.closed) {
        return
      }
      state.closed = true
      state.serving = false
      void finishClose(state)
        .catch(() => undefined)
        .then(resolveClosed)
    },
    whenClosed: () => teardown,
    leadership: createLeadership(state),
  }
}

function createLeadership(state: IRoleState): IEngineLeadership {
  return {
    isLeader: () => state.leading,
    subscribe: (onChange) => {
      state.leadershipListeners.add(onChange)

      return () => {
        state.leadershipListeners.delete(onChange)
      }
    },
  }
}

/** Tells the leadership listeners when this tab starts or stops leading. */
function setLeading(state: IRoleState, leading: boolean): void {
  if (state.leading === leading) {
    return
  }
  state.leading = leading

  for (const listener of state.leadershipListeners) {
    listener(leading)
  }
}

// MARK: - Leading

/** One follower call this tab's worker runs, and the id this tab leads under. */
type TFollowerCall = {
  worker: IWorkerTransport
  request: TLeaderRequest
  leader: string
}

async function answerFollower(state: IRoleState, followerCall: TFollowerCall): Promise<void> {
  const { worker, request } = followerCall
  let envelope: string

  try {
    envelope = await worker.call(request.method, request.paramsJson)
  } catch (error) {
    envelope = answerEnvelope(error)
  }
  if (state.channel !== null) {
    state.channel.postMessage({ type: 'result', id: request.id, envelope } satisfies TLeaderResponse)
  }
}

function takeFollowerCall(state: IRoleState, followerCall: TFollowerCall): void {
  if (!state.serving || state.channel === null) {
    return
  }
  state.channel.postMessage({
    type: 'accepted',
    id: followerCall.request.id,
    leader: followerCall.leader,
  } satisfies TLeaderResponse)
  const answering = answerFollower(state, followerCall)

  state.owed.add(answering)
  void answering.finally(() => state.owed.delete(answering))
}

function becomeLeader(state: IRoleState, instance: string): void {
  if (state.closed) {
    return
  }
  const { name, configJson, databasePath, wasmUrl, pull, push, onEvent, onDurability } = state.options
  const opened = new BroadcastChannel(SCOPE_PREFIX + name)

  state.channel = opened
  state.instance = instance
  const worker = createWorkerTransport({
    configJson,
    databasePath,
    wasmUrl,
    pull,
    push,
    onDurability,
    onFailure: () => demote(state),
    closeTimeoutMs: state.options.closeTimeoutMs,
    onEvent: (eventJson) => {
      onEvent(eventJson)

      if (state.channel !== null) {
        state.channel.postMessage({ type: 'event', eventJson } satisfies TLeaderResponse)
      }
    },
  })

  opened.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data

    if (isLeaderMessage(message) && message.type === 'call') {
      takeFollowerCall(state, { worker, request: message, leader: instance })
    }
  })
  state.serving = true
  // Announced after the listener is attached: a follower that re-posts before then would post to a bus with nothing serving, the state it is recovering from.
  opened.postMessage({ type: 'leader-ready', leader: instance } satisfies TLeaderResponse)
  state.current = worker
  state.leader = worker
  const previous = state.follower

  state.follower = null

  if (previous !== null) {
    state.promotion = promoteFrom(state, { worker, previous })
      .catch(() => undefined)
      .finally(() => {
        state.promotion = null
      })
  }
  // Last, so a listener that syncs at once finds the promotion already in place for its call to wait on.
  setLeading(state, true)
}

// MARK: - Promotion

/** The worker a promoted tab now runs, and the follower transport it was waiting on. */
type THandOver = {
  worker: IWorkerTransport
  previous: IFollowerTransport
}

/**
 * Takes over what this tab was waiting on as a follower. A call no leader ever
 * accepted can be re-issued on this tab's worker and still execute exactly once;
 * a call some leader accepted is already running there and must never be
 * re-issued. The follower can only tell which is which once it has stopped
 * hearing from the leader it was talking to. A Web Locks grant and a channel
 * message are different task sources with no ordering between them. A tab
 * promoted mid-conversation can read `accepted` before the message that would
 * have set it, and replay a call the old leader already ran. Promotion waits for
 * whichever comes first: - Idle. Nothing is pending. Either the tab had no calls
 * out, or the ones it had were answered, by the old leader, or by this tab
 * through the re-post its own `leader-ready` triggers. This is also the fresh
 * single tab, whose first call is answered by the engine it opened. - Goodbye.
 * The outgoing leader's `leader-closed` arrives. Messages from one sender arrive
 * in order, so every `accepted` and every `result` it sent has already been
 * processed and the flags are exact. - Budget, with nothing of this tab's own
 * outstanding. Neither happened and this tab owes no answers: the leader that
 * held those calls was another page and it went away mid-call. Never-accepted
 * calls are still safe to re-issue, because a leader posts `accepted` before it
 * executes anything. The accepted ones will never be answered; they fail with
 * `ENGINE_UNAVAILABLE` now, not at the end of their own much longer timeout. A
 * budget that expires while this tab still owes answers is different: its own
 * worker is slow, on work it accepted through its own channel after announcing
 * itself. That is the fresh single tab whose first call outlives the budget.
 * Those calls are running here. The wait is extended until they settle; it must
 * not fail a call this engine is executing.
 */
async function promoteFrom(state: IRoleState, handOver: THandOver): Promise<void> {
  const { worker, previous } = handOver

  state.draining = previous
  previous.stopFollowing()
  const settled = await settleBeforeHandOver(state, previous)

  for (const taken of previous.handOver()) {
    void worker.call(taken.method, taken.paramsJson).then(taken.resolve, taken.reject)
  }
  if (!settled) {
    previous.abandon(unavailable(LEADER_GONE))
    state.draining = null

    return
  }
  void drain(state, previous)
}

/**
 * False only when the budget ran out with calls still unaccounted for: held by a
 * leader that is not this tab and has said nothing.
 */
async function settleBeforeHandOver(state: IRoleState, previous: IFollowerTransport): Promise<boolean> {
  for (;;) {
    if (await raceTheBudget(state, previous)) {
      return true
    }
    if (state.owed.size === 0) {
      return false
    }
    // The budget expired on this tab's own worker, not on a vanished leader. Answering what it owes is what makes the transport idle.
    await Promise.all([...state.owed])
  }
}

async function raceTheBudget(state: IRoleState, previous: IFollowerTransport): Promise<boolean> {
  let expiry: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    expiry = setTimeout(() => resolve(false), state.options.closeTimeoutMs)
  })
  const settled = await Promise.race([
    previous.whenIdle().then(() => true),
    previous.whenLeaderClosed().then(() => true),
    expired,
  ])

  clearTimeout(expiry)

  return settled
}

async function drain(state: IRoleState, previous: IFollowerTransport): Promise<void> {
  let expiry: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    expiry = setTimeout(resolve, state.options.closeTimeoutMs)
  })

  await Promise.race([previous.whenIdle(), expired])
  clearTimeout(expiry)
  previous.close()

  if (state.draining === previous) {
    state.draining = null
  }
}

// MARK: - Following

/**
 * A follower's `configJson`, `pull` and `push` are dropped on purpose: the tab
 * that owns the engine opened the store and serves its protocol remote, so one
 * database keeps one outbox, not one per tab.
 */
function becomeFollower(state: IRoleState): void {
  const { name, onEvent } = state.options

  state.follower = createFollowerTransport(name, onEvent, {
    handOverMs: state.options.closeTimeoutMs,
    describePromotionFailure: () => state.promotionFailure,
  })
  state.current = state.follower
}

/**
 * The leader's worker reports `store_kind` on its own; a follower has to ask the
 * tab that opened the store, once it knows one is answering.
 */
function probeDurability(state: IRoleState, transport: IEngineTransport): void {
  if (state.probed) {
    return
  }
  state.probed = true
  // A probe lost to a handover must not cost this tab its durability for good: a leader standing down answers it with the `engine_unavailable` envelope, which carries no durability at all. Clearing `probed` lets the next successful call ask again.
  void transport
    .call('store_kind', '{}')
    .then((envelope) => {
      const durability = readDurability(envelope)

      if (durability === null) {
        state.probed = false

        return
      }
      state.options.onDurability(durability)
    })
    .catch(() => {
      state.probed = false
    })
}

function leaderFailed(state: IRoleState, failure: ILeaderFailure): void {
  const { error, canAnotherTabLead } = failure

  state.promotionFailure = errorMessage(error)
  state.serving = false
  state.channel?.close()
  state.channel = null
  setLeading(state, false)

  // Waiting for a leader is only worth doing where a leader can appear. On the single-tab fallback this page was the only candidate, so it says why it failed now, not at the end of a timeout nothing can satisfy.
  if (!canAnotherTabLead) {
    state.fatal = unavailable(`this tab's own promotion failed: ${state.promotionFailure}`)
    state.follower?.close()

    return
  }
  if (state.follower === null) {
    becomeFollower(state)
  } else {
    state.current = state.follower
  }
}

// MARK: - Closing

/**
 * Post every answer this tab still owes, say goodbye, then stop being reachable
 * on the bus. `leader-closed` is the last message this tab ever posts, so a
 * follower that has processed it has processed every `accepted` and every
 * `result` too, and can tell exactly which of its calls were taken.
 */
async function closeChannel(state: IRoleState): Promise<void> {
  await Promise.all([...state.owed])
  const { channel, instance } = state

  if (channel !== null && instance !== null) {
    channel.postMessage({ type: 'leader-closed', leader: instance } satisfies TLeaderResponse)
  }
  channel?.close()
  state.channel = null
}

async function standDown(state: IRoleState): Promise<void> {
  await closeChannel(state)
  await state.releaseElection()
}

/**
 * The worker died under a leading tab. Leadership moves; this transport keeps
 * rejecting with the latched worker failure, so the app sees the real reason and
 * recreates the driver. It does not reconnect to another tab.
 */
function demote(state: IRoleState): void {
  if (!state.serving) {
    return
  }
  state.serving = false
  setLeading(state, false)
  void standDown(state)
}

function refuseIfFinished(state: IRoleState): void {
  if (state.fatal !== null) {
    throw state.fatal
  }
  if (state.closed) {
    throw unavailable(CLOSED)
  }
}

/**
 * Close the engine first and release the election last: a tab promoted while the
 * outgoing worker still holds the store would contend for its OPFS access
 * handles, and nothing retries that open.
 */
async function finishClose(state: IRoleState): Promise<void> {
  const worker = state.leader

  if (worker === null) {
    state.follower?.close()
    await standDown(state)

    return
  }
  worker.close()
  state.draining?.close()
  await closeChannel(state)
  await worker.terminated
  await state.releaseElection()
}

// MARK: - The transport the driver hands the core

export interface IEngineTransportOptions {
  /** The database being opened: one leader, one engine, one channel per name. */
  name: string

  onDurability: (durability: TStoreDurability) => void
  closeTimeoutMs?: number
  wasmUrl?: TWasmUrl
}

export function createEngineTransport(options: IEngineTransportOptions): TRoleTransportFactory {
  // eslint-disable-next-line max-params -- mirrors the N-API engine constructor argument for argument
  return (configJson, databasePath, pull, push, onEvent) =>
    createRoleTransport({
      name: options.name,
      onDurability: options.onDurability,
      closeTimeoutMs: options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
      wasmUrl: options.wasmUrl,
      configJson,
      databasePath,
      pull,
      push,
      onEvent,
    })
}

// MARK: - The driver

export interface IWebWorkerDriverOptions {
  /**
   * Where the worker fetches `kizunasync_wasm_bg.wasm`, or a function answering
   * it that runs when the worker spawns. Unset under Vite, which rewrites the
   * worker's own reference; `@kizunasync/expo` passes its asset resolver under
   * Metro.
   */
  wasmUrl?: TWasmUrl

  /** Where the driver reports a degradation, such as a tab kept on a memory store. */
  logger?: ILogger
}

const MEMORY = ':memory:'

/**
 * The browser driver. `name` is the database the engine opens in OPFS (or in the
 * IndexedDB fallback); `:memory:` opens a private in-memory store that dies with
 * the tab. Building it starts nothing: the election, and the worker if this tab
 * wins it, wait for the app client's first engine call. The driver hands the
 * browser's online and offline signal to the app client as
 * `platformPorts.connectivity`.
 *
 * Without Web Locks (an insecure context) no two tabs can agree on which one runs
 * the engine, and two engines on one store would overwrite each other. The tab
 * keeps a private memory store instead, reports `durability: 'none'`, and says why
 * through `logger`. A browser that refuses OPFS storage outright (Safari Private
 * Browsing) gets the same memory store from the engine, and the driver says so
 * through `logger` when the engine reports it.
 */
export const createWebWorkerDriver = (name: string, options: IWebWorkerDriverOptions = {}): IWebEngineDriver => {
  const isShared = hasWebLocks()
  let durability: TStoreDurability | undefined = isShared ? undefined : 'none'
  let hasWarnedRefusedStorage = false

  if (!isShared && name !== MEMORY) {
    options.logger?.warn('driver.memory_store', {
      database: name,
      reason: 'navigator.locks is unavailable: Web Locks need a secure context',
    })
  }
  const engineTransport = createEngineTransport({
    name,
    wasmUrl: options.wasmUrl,
    onDurability: (answered) => {
      durability = answered

      // Every leader open and follower probe answers again, so a refusal is told once per driver.
      if (isShared && name !== MEMORY && answered === 'none' && !hasWarnedRefusedStorage) {
        hasWarnedRefusedStorage = true
        options.logger?.warn('driver.memory_store', {
          database: name,
          reason: 'the browser refused OPFS storage (private browsing), so the tab keeps a memory store',
        })
      }
    },
  })

  return {
    databasePath: isShared ? name : null,
    engineTransport,
    platformPorts: { connectivity: createWebConnectivity() },
    // A getter, because the answer arrives after the store opens: a snapshot taken here would be `undefined` for the life of the driver.
    get durability(): TStoreDurability | undefined {
      return durability
    },
  }
}
