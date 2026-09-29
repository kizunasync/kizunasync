// MARK: - Sync scheduler

/**
 * Automatic sync goes through one scheduler: the loop's start, the jittered
 * poll tick, a realtime doorbell, a return to connectivity, and a local write (a
 * `QUEUE_DEPTH` event with a non-zero depth) waking the loop so the outbox
 * leaves without a manual sync, while the doorbell stays pull-driven. One
 * retry policy, one in-flight guard, one place the next attempt is guaranteed
 * to be armed.
 *
 * Two invariants, in this order.
 *
 * Mutual exclusion first: `sync()` never runs twice at once. The engine's
 * `sync()` reads the outbox and pushes it, so overlapping runs would race on
 * the same rows and hit the remote twice with the same batch. On the Rust/NAPI
 * engine the actor serialises them, and an overlap becomes a queue that
 * discharges back-to-back the moment a wedged call settles. Neither is
 * acceptable. A new attempt starts only after the previous one has settled,
 * and at most one catch-up is remembered while it has not: an hour of ticks
 * collapses into a single run, not a stampede.
 *
 * Liveness second: once started, the loop ticks until `dispose()`. The next
 * tick is armed before the attempt runs, so a rejection, hang, or throwing
 * logger cannot decide whether there is a next tick. The loop stays armed
 * across a hang, reports it (`sync.stalled`), and resumes the instant the
 * request settles.
 *
 * No hard timeout on the attempt. Racing `sync()` against a timer would
 * settle our view of the attempt without cancelling anything. `Promise.race`
 * cannot abort the underlying request, which keeps running and keeps holding
 * the outbox. Mutual exclusion already forbids a new run while that work is
 * in flight, so the race buys no progress; it only adds a second timer for
 * what the tick watchdog below already reports. A deadline that bounds a
 * wedged request has to live where the socket does (`AbortSignal` on the
 * remote/transport). A decorative one here would hide that gap.
 *
 * Retry: consecutive failures grow the interval exponentially, capped at
 * MAX_BACKOFF_MS, and never below the caller's configured interval, so a
 * deliberately slow poll is never sped up by a failure. The first success
 * resets the streak. Transitions go through the injected logger with a
 * stable event name: the engine's TEngineEvent union is pinned to the
 * conformance corpus vocabulary, and scheduler state is diagnostics, not
 * protocol.
 */

import type { ILogger } from '../util/logger'

// MARK: - Tuning constants

/**
 * Growth ceiling for the retry backoff. A stalled client therefore always
 * retries at least this often, so recovery latency has a hard upper bound.
 */
export const MAX_BACKOFF_MS = 30_000

/**
 * Ticks an unsettled attempt may occupy the in-flight slot before the loop
 * calls it wedged. Crossing this reports `sync.stalled`, counts one failure so
 * the backoff reflects the trouble, and books a catch-up run for the moment it
 * settles. It does NOT free the slot, because the request is still out there.
 * Two ticks, not one, keeps a merely slow sync from being called dead.
 */
export const STALLED_ATTEMPT_TICKS = 2

/**
 * A burst of wake signals (a peer writing several rows) collapses into one
 * attempt scheduled this far out. Leading-edge: the first signal arms it and
 * the rest ride along, so a chatty channel can neither stampede nor starve.
 */
export const WAKE_DEBOUNCE_MS = 250

// MARK: - Types

/** Why an out-of-band sync was requested. Carried into the diagnostics only. */
type TWakeReason = 'start' | 'connectivity' | 'wakeup' | 'foreground' | 'queue' | 'promotion'

/**
 * The transitions the logger alone cannot deliver to a UI: when the next
 * attempt is due, that the current one is presumed wedged, and that an external
 * signal cleared the streak. Implemented by the engine's sync-health tracker.
 */
export interface ISyncSchedulerObserver {
  armed(nextAttemptAt: number | null): void
  stalled(): void
  woken(): void
}

export interface ISyncSchedulerOptions {
  /**
   * The attempt to run. GUARANTEED never to be called again until the promise
   * returned by the previous call has settled: callers rely on this to own the
   * outbox exclusively for the duration of a run.
   */
  sync: () => Promise<void>

  /**
   * Base interval; the armed delay is full-jittered in [delay/2, delay]. Zero
   * or negative arms NO periodic tick: the scheduler is then purely
   * wake-driven. The conformance harness injects neither an interval nor a
   * wakeup, so it never touches a timer or Math.random.
   */
  intervalMs: number

  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  logger: ILogger

  /**
   * Jitter source, injectable so tests can pin the armed delay. Defaults to
   * Math.random, and called only once a timer is armed.
   */
  random?: () => number

  /**
   * Optional diagnostics sink for the loop's observable state. Absent on the
   * conformance path: nothing below it may change behavior.
   */
  observer?: ISyncSchedulerObserver

  /**
   * Epoch-ms clock, read ONLY to date the armed tick for `observer`. Both the
   * engines inject one; the corpus injects neither it nor an observer, so the
   * scheduler still reads no clock of its own there.
   */
  now?: () => number

  /**
   * Consulted before every automatic attempt and every wake. False skips it:
   * no attempt starts and the observer hears nothing, while the poll tick stays
   * armed so the loop resumes once the answer turns. Absent ⇒ always true.
   */
  shouldRun?: () => boolean
}

interface ISyncScheduler {
  /**
   * Request an attempt as soon as possible: clears the failure streak (an
   * external signal is fresh evidence that the previous failures are stale) and
   * pulls the next tick in to the debounce window. Coalesces a burst. Does
   * nothing while `shouldRun` answers false.
   */
  wake(reason: TWakeReason): void

  /** Stop the loop and release the pending timer. Idempotent. */
  dispose(): void
}

// MARK: - Factory

/**
 * What one scheduler reads and mutates, shared by the functions below. The
 * injected callables are captured at construction and always called bare,
 * never as methods of this record.
 */
interface ISchedulerState {
  readonly sync: () => Promise<void>
  readonly intervalMs: number
  readonly setTimer: ISyncSchedulerOptions['setTimer']
  readonly clearTimer: ISyncSchedulerOptions['clearTimer']
  readonly logger: ILogger
  readonly observer: ISyncSchedulerObserver | undefined
  readonly now: (() => number) | undefined
  readonly random: () => number
  readonly shouldRun: () => boolean
  readonly isPeriodic: boolean

  /**
   * Never shorter than what the caller configured: backoff only ever slows the
   * loop down, it must not turn a 5-minute poll into a 30-second one.
   */
  readonly ceilingMs: number

  /** The one callback every armed timer fires. */
  readonly tick: () => void

  timer: unknown
  disposed: boolean
  consecutiveFailures: number

  /**
   * The attempt owning the in-flight slot, or null when idle. Only its own
   * settlement releases it: the mutual-exclusion guarantee.
   */
  inFlight: number | null

  attemptCount: number
  ticksWaitingOnAttempt: number

  /** Set once per attempt, so a long hang reports and counts as ONE stall. */
  stallReported: boolean

  /**
   * A single coalesced catch-up run owed to whatever landed while the slot was
   * busy. A boolean, not a queue: a stampede cannot even be represented.
   */
  runRequested: boolean

  wakePending: boolean
}

export const createSyncScheduler = (options: ISyncSchedulerOptions): ISyncScheduler => {
  const { sync, intervalMs, setTimer, clearTimer, logger, observer, now } = options
  const state: ISchedulerState = {
    sync,
    intervalMs,
    setTimer,
    clearTimer,
    logger,
    observer,
    now,
    random: options.random ?? Math.random,
    shouldRun: options.shouldRun ?? (() => true),
    isPeriodic: intervalMs > 0,
    ceilingMs: Math.max(intervalMs, MAX_BACKOFF_MS),
    tick: () => {
      onTick(state)
    },
    timer: undefined,
    disposed: false,
    consecutiveFailures: 0,
    inFlight: null,
    attemptCount: 0,
    ticksWaitingOnAttempt: 0,
    stallReported: false,
    runRequested: false,
    wakePending: false,
  }

  armNextPoll(state)

  return {
    wake: (reason) => {
      wake(state, reason)
    },
    dispose: () => {
      dispose(state)
    },
  }
}

// MARK: - Arming

function backoffMs(state: ISchedulerState): number {
  return Math.min(state.intervalMs * 2 ** state.consecutiveFailures, state.ceilingMs)
}

/**
 * Arm the next tick, replacing any pending one. The only place a timer is
 * created, so "the loop is armed" is decidable by reading this function.
 */
function armIn(state: ISchedulerState, delayMs: number): void {
  const { setTimer, clearTimer, observer, now } = state

  if (state.disposed) {
    return
  }
  if (state.timer !== undefined) {
    clearTimer(state.timer)
  }
  state.timer = setTimer(state.tick, delayMs)

  if (observer !== undefined && now !== undefined) {
    observer.armed(now() + delayMs)
  }
}

/**
 * Full jitter in [backoff/2, backoff] so many clients de-sync on recovery. A
 * wake-only scheduler does not arm a poll.
 */
function armNextPoll(state: ISchedulerState): void {
  const { random } = state

  if (!state.isPeriodic) {
    return
  }
  const delayMs = backoffMs(state)

  armIn(state, delayMs / 2 + random() * (delayMs / 2))
}

// MARK: - Attempts

/**
 * A promise settles at most once and the synchronous-throw path below is
 * mutually exclusive with it, so this runs exactly once per attempt, and no
 * generation guard is needed to recognise the current owner of the slot.
 */
function finishAttempt(state: ISchedulerState, error: unknown): void {
  const { logger } = state

  state.inFlight = null
  // Uneventful: succeeded with no streak to clear, so the delay the pending tick was armed with is still the right one.
  const unchanged = error === null && state.consecutiveFailures === 0

  if (error === null) {
    if (state.consecutiveFailures > 0) {
      logger.info('sync.recovered', { afterFailures: state.consecutiveFailures })
      state.consecutiveFailures = 0
    }
  } else {
    state.consecutiveFailures += 1
    logger.warn('sync.failed', { consecutiveFailures: state.consecutiveFailures, error })
  }
  if (state.disposed) {
    return
  }
  if (state.runRequested) {
    // Clear the flag BEFORE running so this stays bounded: the catch-up run can re-enter here (a sync that throws synchronously) but finds nothing owed. A stale settle releases exactly one run, never a cascade.
    state.runRequested = false
    armNextPoll(state)
    beginAttempt(state)

    return
  }
  if (!unchanged) {
    // The streak moved, so the pending tick is armed with a stale backoff.
    armNextPoll(state)
  }
}

function beginAttempt(state: ISchedulerState): void {
  const { sync, shouldRun } = state

  if (!shouldRun()) {
    return
  }
  state.attemptCount += 1
  state.inFlight = state.attemptCount
  state.ticksWaitingOnAttempt = 0
  state.stallReported = false

  try {
    void sync().then(
      () => finishAttempt(state, null),
      (error: unknown) => finishAttempt(state, error),
    )
  } catch (error) {
    // A sync that throws synchronously (not every caller hands us an async function) must free the slot now. Waiting two ticks would look wedged.
    finishAttempt(state, error)
  }
}

function onTick(state: ISchedulerState): void {
  // Re-arm FIRST. Everything below may throw, hang, or never settle; none of it is allowed to decide whether there is a next tick.
  armNextPoll(state)
  const { logger, observer } = state
  const wasWake = state.wakePending

  state.wakePending = false

  if (state.inFlight === null) {
    state.runRequested = false
    beginAttempt(state)

    return
  }

  // Busy: never start a second run. A plain poll tick is dropped: the run already under way does the same work, and booking a catch-up for it would turn a sync that merely takes longer than the interval into a continuous back-to-back loop. Only two things earn a catch-up run: a wake (fresh external evidence the in-flight run may predate) and a stall (the attempt is presumed wedged, so its eventual settlement is not progress).
  state.ticksWaitingOnAttempt += 1
  const stalled = state.ticksWaitingOnAttempt >= STALLED_ATTEMPT_TICKS

  if (wasWake || stalled) {
    state.runRequested = true
  }
  if (stalled && !state.stallReported) {
    state.stallReported = true
    state.consecutiveFailures += 1
    logger.warn('sync.stalled', { attempt: state.inFlight, ticks: state.ticksWaitingOnAttempt })
    observer?.stalled()
    // Re-arm with the grown backoff so a wedged client stops ticking at full rate while it waits; the timer armed above used the old streak.
    armNextPoll(state)

    return
  }
  logger.debug('sync.skipped', { reason: 'in-flight', attempt: state.inFlight })
}

// MARK: - Controls

function wake(state: ISchedulerState, reason: TWakeReason): void {
  const { logger, observer, shouldRun } = state

  if (state.disposed || state.wakePending || !shouldRun()) {
    return
  }
  state.wakePending = true

  if (state.consecutiveFailures > 0) {
    logger.info('sync.woken', { reason, clearedFailures: state.consecutiveFailures })
    state.consecutiveFailures = 0
  }
  observer?.woken()
  armIn(state, WAKE_DEBOUNCE_MS)
}

function dispose(state: ISchedulerState): void {
  const { clearTimer, observer } = state

  state.disposed = true

  if (state.timer !== undefined) {
    clearTimer(state.timer)
    state.timer = undefined
  }
  observer?.armed(null)
}
