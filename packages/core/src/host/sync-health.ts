// MARK: - Sync health

/**
 * The scheduler already tracks every loop state: it arms the next tick, counts
 * consecutive failures, backs off, and marks an attempt wedged. It only ever
 * logs them. `getOutboxDepth()` cannot tell a blocked request from a few
 * seconds of backoff from an offline device. The tracker publishes those
 * transitions as a snapshot.
 *
 * It lives outside `TEngineEvent`: that union is pinned to the conformance
 * corpus vocabulary (@../../../../CONVENTIONS.md). Loop state is diagnostics,
 * not protocol, so it has its own snapshot and subscription.
 *
 * Phase is derived on every read, not stored. One input (connectivity) can
 * change without the tracker being told the new value, only that it changed.
 */

import type { TSoftBlockReason } from '../wire/types'

// MARK: - Types

export const ESyncPhase = {
  idle: 'idle',
  syncing: 'syncing',
  backoff: 'backoff',
  stalled: 'stalled',
  offline: 'offline',
} as const
export type TSyncPhase = (typeof ESyncPhase)[keyof typeof ESyncPhase]

export interface ISyncHealthError {
  /** Stable machine-readable code when the failure carried one, else null. */
  code: string | null

  message: string

  /** Epoch ms the failure was recorded. */
  at: number
}

export interface ISyncHealth {
  phase: TSyncPhase
  consecutiveFailures: number

  /** Epoch ms of the next armed automatic attempt; null when none is armed (poll off, disposed). */
  nextAttemptAt: number | null

  /** Epoch ms when the oldest attempt still in flight started; null when none is. */
  attemptStartedAt: number | null

  /** Epoch ms of the last attempt that settled successfully; null before the first. */
  lastSuccessAt: number | null

  lastError: ISyncHealthError | null

  /**
   * Why sync is soft-blocked until `reset()`: `reset_required` when the
   * server's schema gate refused this client, `identity_changed` when a token
   * of another user than the one the local store belongs to reached the
   * engine. `null` while sync is not soft-blocked. Every snapshot the engine
   * publishes carries it.
   */
  softBlockReason?: TSoftBlockReason | null
}

/**
 * The write side is for the engine and its scheduler; apps only ever see
 * `snapshot()` / `subscribe()` through the app client.
 */
interface ISyncHealthTracker {
  snapshot(): ISyncHealth
  subscribe(listener: (health: ISyncHealth) => void): () => void
  armed(nextAttemptAt: number | null): void

  /**
   * Record an attempt that starts now and answer its id. Attempts may overlap
   * (a manual `sync()` beside the scheduler's), so each settle names the one
   * it ends.
   */
  attemptStarted(): number

  /**
   * End the attempt `attempt` names: `null` means it succeeded, anything else
   * is the failure it threw. An id that already settled changes nothing.
   */
  attemptSettled(attempt: number, error: unknown): void

  /**
   * Record a server signal that no attempt threw. `RESET_REQUIRED` and
   * `CHECKPOINT_EXPIRED` arrive on the event bus while the pull itself resolves,
   * so a UI reading only `attemptSettled` sees a healthy loop and a blocked
   * client at the same time. The failure streak is left alone: the attempt did
   * complete, and the backoff has nothing to back off from. The signal belongs
   * to the oldest attempt in flight.
   */
  signalled(signal: { code: string; message: string }): void

  /** The oldest attempt in flight is wedged. */
  stalled(): void

  /**
   * Record why sync is soft-blocked, or `null` once `reset()` cleared the
   * block. A clean attempt leaves it in place: only a reset lifts the block.
   */
  softBlockChanged(reason: TSoftBlockReason | null): void

  woken(): void
  connectivityChanged(): void
}

interface ISyncHealthOptions {
  /**
   * Epoch ms. Injected so the conformance harness and the engine tests stay
   * deterministic, because core never reads the wall clock directly.
   */
  now: () => number

  isOnline: () => boolean
}

// MARK: - Factory

/** The machine-readable `code` a caught failure carries, or null when it has none. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const code = (error as { code?: unknown }).code

  return typeof code === 'string' ? code : null
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** One attempt in flight. */
interface IAttempt {
  readonly startedAt: number

  /**
   * Set by `stalled()`, so a wedged attempt reports one stall however many
   * ticks it goes on to occupy.
   */
  isStalled: boolean

  /**
   * A server signal landed during this attempt. The attempt itself succeeded,
   * so its clean settle would otherwise clear the very thing the signal exists
   * to report: a client the server has refused reads as healthy one tick after
   * being told it is blocked. A later clean attempt does clear the signal.
   */
  isSignalled: boolean
}

/** What one tracker reads and mutates, shared by the functions below. */
interface IHealthState {
  readonly now: () => number
  readonly isOnline: () => boolean
  readonly listeners: Set<(health: ISyncHealth) => void>

  /** The attempts in flight by id, oldest first: ids only grow, and a Map keeps insertion order. */
  readonly attempts: Map<number, IAttempt>

  nextAttemptId: number
  consecutiveFailures: number
  nextAttemptAt: number | null
  lastSuccessAt: number | null
  lastError: ISyncHealthError | null
  softBlockReason: TSoftBlockReason | null
}

export const createSyncHealthTracker = (options: ISyncHealthOptions): ISyncHealthTracker => {
  const { now, isOnline } = options
  const state: IHealthState = {
    now,
    isOnline,
    listeners: new Set(),
    attempts: new Map(),
    nextAttemptId: 1,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    softBlockReason: null,
  }

  return {
    snapshot: () => takeSnapshot(state),
    subscribe: (listener) => {
      state.listeners.add(listener)

      return () => {
        state.listeners.delete(listener)
      }
    },
    armed: (at) => {
      state.nextAttemptAt = at
      notify(state)
    },
    attemptStarted: () => {
      const id = state.nextAttemptId

      state.nextAttemptId += 1
      state.attempts.set(id, { startedAt: now(), isStalled: false, isSignalled: false })
      notify(state)

      return id
    },
    attemptSettled: (attempt, error) => {
      settleAttempt(state, attempt, error)
    },
    signalled: (signal) => {
      const oldest = oldestAttempt(state)

      if (oldest !== undefined) {
        oldest.isSignalled = true
      }
      state.lastError = Object.freeze({ code: signal.code, message: signal.message, at: now() })
      notify(state)
    },
    stalled: () => {
      const oldest = oldestAttempt(state)

      if (oldest === undefined || oldest.isStalled) {
        return
      }
      oldest.isStalled = true
      state.consecutiveFailures += 1
      notify(state)
    },
    softBlockChanged: (reason) => {
      if (state.softBlockReason === reason) {
        return
      }
      state.softBlockReason = reason
      notify(state)
    },
    woken: () => {
      state.consecutiveFailures = 0
      notify(state)
    },
    connectivityChanged: () => {
      notify(state)
    },
  }
}

// MARK: - Snapshot

/** The oldest attempt still in flight, the one a stall or a signal is judged against. */
function oldestAttempt(state: IHealthState): IAttempt | undefined {
  return state.attempts.values().next().value
}

function derivePhase(state: IHealthState): TSyncPhase {
  const { isOnline } = state

  if (!isOnline()) {
    return ESyncPhase.offline
  }
  const oldest = oldestAttempt(state)

  if (oldest !== undefined) {
    return oldest.isStalled ? ESyncPhase.stalled : ESyncPhase.syncing
  }
  return state.consecutiveFailures > 0 ? ESyncPhase.backoff : ESyncPhase.idle
}

function takeSnapshot(state: IHealthState): ISyncHealth {
  return Object.freeze({
    phase: derivePhase(state),
    consecutiveFailures: state.consecutiveFailures,
    nextAttemptAt: state.nextAttemptAt,
    attemptStartedAt: oldestAttempt(state)?.startedAt ?? null,
    lastSuccessAt: state.lastSuccessAt,
    lastError: state.lastError,
    softBlockReason: state.softBlockReason,
  })
}

function notify(state: IHealthState): void {
  const health = takeSnapshot(state)

  for (const listener of state.listeners) {
    // Isolated like the engine's event bus: a throwing app callback must not break the loop transition that produced the snapshot.
    try {
      listener(health)
    } catch {
      // The listener's own fault.
    }
  }
}

// MARK: - Settlement

function settleAttempt(state: IHealthState, attempt: number, error: unknown): void {
  const { now } = state
  const settled = state.attempts.get(attempt)

  if (settled === undefined) {
    return
  }
  state.attempts.delete(attempt)

  if (error === null) {
    state.lastSuccessAt = now()
    state.consecutiveFailures = 0

    // A signal stays until the attempt it landed on has settled too.
    if (!settled.isSignalled && ![...state.attempts.values()].some((running) => running.isSignalled)) {
      state.lastError = null
    }
  } else {
    state.consecutiveFailures += 1
    state.lastError = Object.freeze({
      code: errorCode(error),
      message: errorMessage(error),
      at: now(),
    })
  }
  notify(state)
}
