// MARK: - @kizunasync/web worker runtime

/**
 * The worker's whole behavior, with the wasm module injected. `worker.ts` is only
 * the entry that loads the real glue and wires `onmessage` to the handler this
 * builds; everything testable lives here. The protocol is covered without a
 * browser, OPFS or a wasm build.
 *
 * Calls reach the engine in arrival order and run side by side: the engine answers
 * a local call while a network call awaits the remote, and runs the calls that pull
 * or push one at a time itself. `open` and `close` are barriers: each starts once
 * every earlier request has answered, and every later request starts after it, so
 * no call reaches a half-opened engine and `close` frees an engine no call still
 * holds, which releases its store. `remote-result` bypasses both; it is the answer
 * to a round trip an in-flight call is blocked on, and a barrier waits for that call.
 *
 * `open` also runs the attachment queue's crash recovery, once per database open
 * and before any call can claim a transfer: rows a dead context left claimed
 * become drainable again. Only the leading tab has a worker, and no page asks for
 * recovery (`worker-driver.ts`), so a tab that joins later never resets the
 * uploads the leader has in flight.
 */

import { errorMessage } from './error-message'
import { CRASH_RECOVERY_METHOD } from './worker-protocol'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

// MARK: - The slice of the wasm bridge this runtime uses

export interface IWasmEngine {
  create(
    configJson: string,
    pull: (requestJson: string) => Promise<string>,
    push: (requestJson: string) => Promise<string>,
  ): Promise<void>
  call(method: string, paramsJson: string): Promise<string>
  subscribe(callback: (eventJson: string) => void): number
  free(): void
}

/** Loads the wasm module and returns a fresh engine. Called on the first `open`. */
export type TWasmEngineFactory = (wasmUrl?: string) => Promise<IWasmEngine>

interface IRemotePending {
  resolve: (value: string) => void
  reject: (reason: Error) => void
}

/** Everything the runtime answers with a `result`. `remote-result` is settled on arrival instead. */
type TServedRequest = Exclude<TWorkerRequest, { type: 'remote-result' }>

function assertNever(value: never): never {
  throw new Error(`unhandled worker request: ${JSON.stringify(value)}`)
}

// MARK: - Public API

/**
 * Build the worker's message handler. `post` is the worker's `postMessage`; the
 * handler never throws, so a failure always comes back as a `result` the page can
 * settle its promise on, not an `onmessage` rejection nobody observes.
 */
/** What one runtime mutates, shared by the functions below. `createEngine` and `post` are always called bare. */
interface IRuntimeState {
  readonly createEngine: TWasmEngineFactory
  readonly post: (message: TWorkerResponse) => void
  engine: IWasmEngine | null
  nextRemoteId: number
  readonly remotes: Map<number, IRemotePending>

  /** Settles when the last `open` or `close` has answered; every later request starts after it. */
  barrier: Promise<void>

  /** Settles when every call issued since that barrier has answered; the next `open` or `close` waits for it. */
  calls: Promise<void>
}

export const createWorkerRuntime = (
  createEngine: TWasmEngineFactory,
  post: (message: TWorkerResponse) => void,
): ((request: TWorkerRequest) => void) => {
  const state: IRuntimeState = {
    createEngine,
    post,
    engine: null,
    nextRemoteId: 1,
    remotes: new Map(),
    barrier: Promise.resolve(),
    calls: Promise.resolve(),
  }

  return (request: TWorkerRequest): void => {
    if (request.type === 'remote-result') {
      settleRemote(state, request)

      return
    }
    // Every link ends in a catch: a rejected barrier or call set would skip every request queued behind it, dropping each in silence.
    if (request.type === 'call') {
      const answered = state.barrier.then(() => answer(state, request)).catch(() => undefined)

      state.calls = Promise.all([state.calls, answered]).then(() => undefined)

      return
    }
    state.barrier = Promise.all([state.barrier, state.calls])
      .then(() => answer(state, request))
      .catch(() => undefined)
    state.calls = Promise.resolve()
  }
}

// MARK: - Serving a request

/** Serve one request and post its `result`, a failure included. */
async function answer(state: IRuntimeState, request: TServedRequest): Promise<void> {
  const { id } = request
  const { post } = state

  try {
    post({ type: 'result', id, ok: true, value: await serve(state, request) })
  } catch (error) {
    post({ type: 'result', id, ok: false, error: errorMessage(error) })
  }
}

async function serve(state: IRuntimeState, request: TServedRequest): Promise<string> {
  switch (request.type) {
    case 'open':
      await openEngine(state, request)

      return ''
    case 'call':
      return requireEngine(state).call(request.method, request.paramsJson)
    case 'close':
      state.engine?.free()
      state.engine = null

      return ''
    default:
      return assertNever(request)
  }
}

async function openEngine(state: IRuntimeState, request: Extract<TServedRequest, { type: 'open' }>): Promise<void> {
  const { createEngine, post } = state
  const opened = await createEngine(request.wasmUrl)

  try {
    await opened.create(
      request.configJson,
      (requestJson) => roundTrip(state, { kind: 'pull', requestJson }),
      (requestJson) => roundTrip(state, { kind: 'push', requestJson }),
    )

    // `0` means the observer list refused the callback. The open still looks fine from here, so an unchecked 0 would cost the page every engine event and with them its reactivity, silently.
    if (
      opened.subscribe((eventJson) => {
        post({ type: 'event', eventJson })
      }) === 0
    ) {
      throw new Error('the @kizunasync/web worker could not subscribe to engine events')
    }
    const recovered = await opened.call(CRASH_RECOVERY_METHOD, '{}')

    // The engine's own failure envelope is the open's error, so the page reads the store's code, as for a refused create.
    if (!isSuccessEnvelope(recovered)) {
      throw new Error(recovered)
    }
  } catch (error) {
    // The wasm allocation outlives the failed open otherwise, held until a garbage collection that has no reason to run in this worker.
    opened.free()

    throw error
  }
  state.engine?.free()
  state.engine = opened
}

/** Whether an engine envelope reports success; one that cannot be read does not. */
function isSuccessEnvelope(envelope: string): boolean {
  try {
    return (JSON.parse(envelope) as { ok?: unknown } | null)?.ok === true
  } catch {
    return false
  }
}

function requireEngine(state: IRuntimeState): IWasmEngine {
  if (state.engine === null) {
    throw new Error('the @kizunasync/web worker received a call before the engine was opened')
  }
  return state.engine
}

// MARK: - Protocol remote round trips

type TRoundTrip = {
  kind: 'pull' | 'push'
  requestJson: string
}

function roundTrip(state: IRuntimeState, trip: TRoundTrip): Promise<string> {
  const { post } = state

  return new Promise<string>((resolve, reject) => {
    const id = state.nextRemoteId++

    state.remotes.set(id, { resolve, reject })
    post({ type: 'remote', id, kind: trip.kind, requestJson: trip.requestJson })
  })
}

function settleRemote(state: IRuntimeState, request: Extract<TWorkerRequest, { type: 'remote-result' }>): void {
  const pending = state.remotes.get(request.id)

  if (pending === undefined) {
    return
  }
  state.remotes.delete(request.id)

  if (request.ok) {
    pending.resolve(request.value)
  } else {
    pending.reject(new Error(request.error))
  }
}
