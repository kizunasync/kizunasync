// MARK: - Deferred engine

/**
 * The app client's engine, opened on the first call that needs it. An app
 * builds its client at module scope, and that module also loads where the
 * client never runs (a static render in Node), so building one selects no
 * engine, opens no store, arms no timer, and subscribes to no port. The first
 * call that needs the engine opens it and starts the automatic loop, once;
 * every later call reuses that engine. A session token handed before that is
 * kept, never a reason to open, and reaches the engine ahead of every other
 * call.
 *
 * A failed open is kept as one typed error, and nothing opens again. One rule
 * covers every member after that: subscriptions and synchronous reads stay
 * silent, async calls and setBucket carry the error, and sync health reports
 * it. A hook therefore shows one stable error state rather than crashing a
 * render or retrying an engine that cannot load. A client disposed before its
 * first use follows the same rule, except that its health reads idle: the
 * dispose was intentional, not a failure.
 */

import { ESyncPhase, type ISyncHealth } from '../host/sync-health'
import type { IAttachmentClient } from '../host/attachment-queue'
import type { ILogger } from '../util/logger'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import { asEngineErrorCode } from './engine-envelope'
import type { IInspector } from './inspector'
import type { IAppClientEngine, TEngineKind } from './select-engine'

/** What one open produces: the engine and the devtools handle built on it. */
export interface IOpenedEngine {
  engine: IAppClientEngine
  kind: TEngineKind
  inspector: IInspector | null
}

export interface IDeferredEngineOptions {
  /**
   * Opens the engine. `accessToken` is the latest token the app client was
   * handed before the open, `null` when that one cleared it, and `undefined`
   * when none was handed.
   */
  openEngine: (accessToken: string | null | undefined) => IOpenedEngine

  /** Epoch-ms clock that dates a failed open in the health snapshot. */
  now: () => number

  logger: ILogger
}

export interface IDeferredEngine {
  /**
   * The engine port the app client calls. Every member opens the engine first,
   * except `setRemoteAccessToken`, which only keeps the token until the open.
   * After a failed open a promise-returning member rejects with the kept
   * error, `setBucket` throws it, and `subscribe`, `onSyncHealth` and
   * `getSyncHealth` report it without throwing.
   */
  engine: IAppClientEngine

  /** The opened engine, opening it on the first call. Throws the kept failure. */
  open(): IOpenedEngine

  /** The opened engine, opening it on the first call, or null once the open failed or the client was disposed first. */
  attempt(): IOpenedEngine | null

  /**
   * Releases an opened engine. Before the first use there is nothing to
   * release, and every later call behaves as after a failed open, so no engine
   * opens that nothing would dispose; only the health reads idle.
   */
  dispose(): void
}

/** The kept failure and the health snapshot every later read answers with. */
interface IOpenFailure {
  error: TEngineError
  health: ISyncHealth
}

/** What asking for the engine answers: the opened engine, or the kept failure. */
type TOpenOutcome = { opened: IOpenedEngine } | { failure: IOpenFailure }

export const createDeferredEngine = (options: IDeferredEngineOptions): IDeferredEngine => {
  let opened: IOpenedEngine | null = null
  let failure: IOpenFailure | null = null
  let heldToken: { token: string | null } | undefined
  const fail = (error: unknown): IOpenFailure => {
    failure = toOpenFailure(toOpenError(error), options.now())

    return failure
  }
  const attempt = (): TOpenOutcome => {
    if (opened !== null) {
      return { opened }
    }
    if (failure !== null) {
      return { failure }
    }
    try {
      opened = options.openEngine(heldToken?.token)

      return { opened }
    } catch (error) {
      return { failure: fail(error) }
    }
  }
  const open = (): IOpenedEngine => {
    const outcome = attempt()

    if ('failure' in outcome) {
      throw outcome.failure.error
    }
    return outcome.opened
  }
  const gate: IEngineGate = {
    attempt,
    holdToken: (token) => {
      if (failure !== null) {
        throw failure.error
      }
      if (opened !== null) {
        return false
      }
      heldToken = { token }

      return true
    },
    logger: options.logger,
  }

  return {
    engine: createEnginePort(gate),
    open,
    attempt: () => {
      const outcome = attempt()

      return 'failure' in outcome ? null : outcome.opened
    },
    dispose: () => {
      if (opened === null && failure === null) {
        failure = {
          error: new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, 'this app client was disposed before its first use, so it opens no engine'),
          health: DISPOSED_HEALTH,
        }

        return
      }
      opened?.engine.dispose?.()
    },
  }
}

// MARK: - The engine port

/** What the engine port reads from the deferred engine. */
interface IEngineGate {
  attempt: () => TOpenOutcome

  /** Keeps `token` for the open and answers true, or answers false once the engine is open. Throws the kept failure. */
  holdToken: (token: string | null) => boolean

  logger: ILogger
}

/** The engine port, each member reaching the engine `gate` opens at call time. */
function createEnginePort(gate: IEngineGate): IAppClientEngine {
  const engine = (): IAppClientEngine => {
    const outcome = gate.attempt()

    if ('failure' in outcome) {
      throw outcome.failure.error
    }
    return outcome.opened.engine
  }

  return {
    ...createEngineCalls(engine),
    subscribe: (onEvent) => {
      const outcome = gate.attempt()

      return 'failure' in outcome ? noUnsubscribe : outcome.opened.engine.subscribe(onEvent)
    },
    setBucket: (params) => {
      engine().setBucket(params)
    },
    getSyncHealth: () => {
      const outcome = gate.attempt()

      return 'failure' in outcome ? outcome.failure.health : outcome.opened.engine.getSyncHealth()
    },
    onSyncHealth: (listener) => {
      const outcome = gate.attempt()

      if (!('failure' in outcome)) {
        return outcome.opened.engine.onSyncHealth(listener)
      }
      try {
        listener(outcome.failure.health)
      } catch (error) {
        gate.logger.error('sync health listener failed', error)
      }
      return noUnsubscribe
    },
    get attachments() {
      return engine().attachments
    },
    setRemoteAccessToken: async (token) => {
      if (gate.holdToken(token)) {
        return
      }
      await engine().setRemoteAccessToken?.(token)
    },
  }
}

/** The promise-returning members, each opening the engine at call time. */
function createEngineCalls(engine: () => IAppClientEngine): Omit<IAppClientEngine, 'subscribe' | 'setBucket' | 'getSyncHealth' | 'onSyncHealth' | 'attachments' | 'setRemoteAccessToken'> {
  return {
    sync: async () => engine().sync(),
    pullOnce: async () => engine().pullOnce(),
    pushOnce: async () => engine().pushOnce(),
    apply: async (mutation) => engine().apply(mutation),
    query: async (table, plan) => engine().query(table, plan),
    applyWhere: async (request) => engine().applyWhere(request),
    getCheckpoint: async () => engine().getCheckpoint(),
    getOutboxDepth: async () => engine().getOutboxDepth(),
    reset: async () => engine().reset(),
    seedCheckpoint: async (cursor) => engine().seedCheckpoint(cursor),
    rejections: async (listOptions) => engine().rejections(listOptions),
    dismissRejection: async (mutationId) => engine().dismissRejection(mutationId),
    overwrites: async (listOptions) => engine().overwrites(listOptions),
    dismissOverwrite: async (id) => engine().dismissOverwrite(id),
    inspect: async () => engine().inspect(),
  }
}

function noUnsubscribe(): void {}

// MARK: - Surfaces over the engine

/**
 * A surface built on the opened engine: `of` picks it out of an open that
 * built it, which the caller decides from the same options the open reads.
 */
type TSurfaceSource<TSurface> = {
  deferred: Pick<IDeferredEngine, 'open' | 'attempt'>
  of: (opened: IOpenedEngine) => TSurface
}

/** The attachment surface, each method opening the engine at call time; after a failed open `watch` returns an unsubscribe that does nothing. */
export const createDeferredAttachments = (source: TSurfaceSource<IAttachmentClient>): IAttachmentClient => {
  const attachments = (): IAttachmentClient => source.of(source.deferred.open())

  return {
    fromFile: async (args) => attachments().fromFile(args),
    resolveDownload: async (ref) => attachments().resolveDownload(ref),
    vacuum: async () => attachments().vacuum(),
    getStatus: async (ref) => attachments().getStatus(ref),
    watch: (ref, callback) => {
      const opened = source.deferred.attempt()

      return opened === null ? noUnsubscribe : source.of(opened).watch(ref, callback)
    },
    retry: async (ref) => attachments().retry(ref),
    cancel: async (ref) => attachments().cancel(ref),
    remove: async (ref) => attachments().remove(ref),
  }
}

/** The devtools handle, each method opening the engine at call time; after a failed open only `snapshot` carries the error. */
export const createDeferredInspector = (source: TSurfaceSource<IInspector>): IInspector => {
  const inspector = (): IInspector | null => {
    const opened = source.deferred.attempt()

    return opened === null ? null : source.of(opened)
  }

  return {
    snapshot: async () => source.of(source.deferred.open()).snapshot(),
    verdicts: () => inspector()?.verdicts() ?? [],
    subscribe: (onChange) => inspector()?.subscribe(onChange) ?? noUnsubscribe,
    clear: () => {
      inspector()?.clear()
    },
  }
}

// MARK: - Open failures

/** The N-API constructor's `<CODE>: <detail>` message. */
const CODED_MESSAGE = /^([A-Z_]+): ([\s\S]*)$/

/**
 * Every open failure as a typed error. The N-API constructor can only throw a
 * plain `Error` whose message starts with the catalog code, so that code is
 * read back; a failure that names no catalog code is ENGINE_UNAVAILABLE.
 */
function toOpenError(error: unknown): TEngineError {
  if (error instanceof TEngineError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  const coded = CODED_MESSAGE.exec(message)
  const code = asEngineErrorCode(coded?.[1])

  return code === null || coded === null
    ? new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, message)
    : new TEngineError(code, coded[2] ?? '')
}

/** What a client disposed before its first use reports: a loop that never ran, not one that failed. */
const DISPOSED_HEALTH: ISyncHealth = Object.freeze({
  phase: ESyncPhase.idle,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  attemptStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  softBlockReason: null,
})

/** The failure and the health snapshot of a loop that never got an engine. */
function toOpenFailure(error: TEngineError, at: number): IOpenFailure {
  return {
    error,
    health: Object.freeze({
      phase: ESyncPhase.backoff,
      consecutiveFailures: 1,
      nextAttemptAt: null,
      attemptStartedAt: null,
      lastSuccessAt: null,
      lastError: Object.freeze({ code: error.code, message: error.message, at }),
      softBlockReason: null,
    }),
  }
}
