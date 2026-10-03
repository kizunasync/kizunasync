// MARK: - Sync scheduler invariants

/**
 * The engine's automatic sync loop must be impossible to stop and impossible
 * to double-run. Starting a second attempt is the cheap way to unstick a
 * wedged loop, and must never happen. These tests pin both sides:
 *
 *   1. mutual exclusion: sync() is never re-entered before the previous call
 *      settles, including across a stall and its late settlement, and a stale
 *      settle releases ONE coalesced run, not the backlog of ticks;
 *   2. liveness: a rejected attempt, and an attempt that never settles
 *      (a `fetch` with no timeout on a half-open socket), both leave the next
 *      tick armed, and progress resumes the instant the request settles;
 *   3. bounded backoff: consecutive failures slow the loop down, never past
 *      MAX_BACKOFF_MS. Recovery latency has a hard ceiling;
 *   4. reset: the first success returns the loop to its configured interval;
 *   5. wake: an external signal (reconnect, doorbell, local write) clears the
 *      streak and pulls the next attempt into the debounce window; a burst
 *      coalesces and a failure is left to the backoff.
 *
 * Virtual clock, injected jitter. Delay assertions are exact. Nothing depends
 * on wall time.
 */

import { describe, expect, test } from 'bun:test'
import { createSyncScheduler, MAX_BACKOFF_MS, STALLED_ATTEMPT_TICKS, WAKE_DEBOUNCE_MS, type ISyncSchedulerObserver, type ISyncSchedulerOptions } from './sync-scheduler'
import { noopLogger, type ILogger } from '../util/logger'

const INTERVAL_MS = 1_000

/**
 * Jitter pinned to the top of the window ⇒ the armed delay IS the backoff.
 * Timing assertions below are exact, not a range.
 */
const NO_JITTER = (): number => 1

// MARK: - Virtual clock

type TVirtualClock = {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void

  /**
   * Fire every timer due within the window, in time order, letting callbacks
   * re-arm as they go. Microtasks are drained after each one so a settled
   * attempt's continuation runs before the next timer.
   */
  advance: (ms: number) => Promise<void>

  now: () => number
  armedCount: () => number
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const createVirtualClock = (): TVirtualClock => {
  const pending = new Map<number, { at: number; callback: () => void }>()
  let nowMs = 0
  let nextHandle = 0
  const takeDue = (throughMs: number): (() => void) | null => {
    let dueHandle: number | null = null
    let dueAt = Number.POSITIVE_INFINITY

    for (const [handle, entry] of pending) {
      if (entry.at <= throughMs && entry.at < dueAt) {
        dueHandle = handle
        dueAt = entry.at
      }
    }
    if (dueHandle === null) {
      return null
    }
    const entry = pending.get(dueHandle)!

    pending.delete(dueHandle)
    nowMs = entry.at

    return entry.callback
  }
  return {
    setTimer: (callback, delayMs) => {
      nextHandle += 1
      pending.set(nextHandle, { at: nowMs + delayMs, callback })

      return nextHandle
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
    advance: async (ms) => {
      const target = nowMs + ms

      for (;;) {
        const callback = takeDue(target)

        if (callback === null) {
          break
        }
        callback()
        await flushMicrotasks()
      }
      nowMs = target
    },
    now: () => nowMs,
    armedCount: () => pending.size,
  }
}

// MARK: - Harness

type THarness = {
  clock: TVirtualClock

  /** Virtual timestamp of every attempt the loop started, in order. */
  attempts: number[]

  /** Gaps between consecutive attempts, the observable backoff. */
  gaps: () => number[]

  scheduler: ReturnType<typeof createSyncScheduler>
}

/**
 * Build a scheduler over the virtual clock. `outcome` decides, per attempt
 * number (1-based), what the sync does: resolve, reject, or hang forever.
 */
const harness = (
  outcome: (attempt: number) => 'hang' | 'ok' | 'fail',
  overrides: Partial<ISyncSchedulerOptions> = {},
): THarness => {
  const clock = createVirtualClock()
  const attempts: number[] = []
  const scheduler = createSyncScheduler({
    sync: () => {
      attempts.push(clock.now())
      const verdict = outcome(attempts.length)

      if (verdict === 'hang') {
        return new Promise<void>(() => undefined)
      }
      return verdict === 'ok' ? Promise.resolve() : Promise.reject(new Error('remote unreachable'))
    },
    intervalMs: INTERVAL_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: noopLogger,
    random: NO_JITTER,
    ...overrides,
  })

  return {
    clock,
    attempts,
    gaps: () => attempts.slice(1).map((at, index) => at - attempts[index]!),
    scheduler,
  }
}

type TGatedHarness = {
  clock: TVirtualClock

  /** How many times sync() has been entered. */
  started: () => number

  /** Most sync() bodies unsettled at the same instant, the overlap detector. */
  peakConcurrency: () => number

  /** sync() calls still waiting to be released. */
  outstanding: () => number

  /** Settle the oldest outstanding sync(), as a real request finally answering. */
  release: (outcome: 'ok' | 'fail') => void

  scheduler: ReturnType<typeof createSyncScheduler>
}

/**
 * A scheduler whose sync() hangs until the test releases it by hand. Nothing
 * else can expose an overlap: with auto-settling promises the loop is single-
 * threaded by construction, so the bug only shows while a call is suspended.
 */
const gatedHarness = (overrides: Partial<ISyncSchedulerOptions> = {}): TGatedHarness => {
  const clock = createVirtualClock()
  const pending: Array<(outcome: 'ok' | 'fail') => void> = []
  let started = 0
  let live = 0
  let peak = 0
  const scheduler = createSyncScheduler({
    sync: () => {
      started += 1
      live += 1
      peak = Math.max(peak, live)

      return new Promise<void>((resolve, reject) => {
        pending.push((outcome) => {
          live -= 1

          if (outcome === 'ok') {
            resolve()
          } else {
            reject(new Error('remote unreachable'))
          }
        })
      })
    },
    intervalMs: INTERVAL_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: noopLogger,
    random: NO_JITTER,
    ...overrides,
  })

  return {
    clock,
    started: () => started,
    peakConcurrency: () => peak,
    outstanding: () => pending.length,
    release: (outcome) => {
      const settle = pending.shift()

      settle?.(outcome)
    },
    scheduler,
  }
}

const recordingLogger = (): { logger: ILogger; events: string[] } => {
  const events: string[] = []
  const sink: ILogger = {
    debug: (message) => events.push(message),
    info: (message) => events.push(message),
    warn: (message) => events.push(message),
    error: (message) => events.push(message),
    child: () => sink,
  }

  return { logger: sink, events }
}

// MARK: - Tests

describe('sync scheduler: mutual exclusion', () => {
  test('sync is never re-entered before the previous call settles', async () => {
    // The engine's sync() reads the outbox and pushes it, so two overlapping runs would race on the same rows and send the same batch twice.
    const run = gatedHarness()

    await run.clock.advance(INTERVAL_MS)
    expect(run.started()).toBe(1)

    // Ten minutes of ticks, far past the stall threshold, against a request that has not answered: not one of them may start a second run.
    await run.clock.advance(10 * 60_000)
    expect(run.started()).toBe(1)
    expect(run.peakConcurrency()).toBe(1)

    // Catch-up starts only after the wedged call has settled. No overlap at that seam either.
    run.release('fail')
    await flushMicrotasks()
    await run.clock.advance(10 * 60_000)
    expect(run.started()).toBeGreaterThan(1)
    expect(run.peakConcurrency()).toBe(1)
    run.scheduler.dispose()
  })

  test('a stale settle releases exactly one coalesced run, not the skipped backlog', async () => {
    const run = gatedHarness()

    // An hour of ticks pile up behind one wedged request. A queue of them would fire back-to-back on settle: the stampede that hits a server as it comes back.
    await run.clock.advance(60 * 60_000)
    expect(run.started()).toBe(1)

    run.release('fail')
    await flushMicrotasks()
    expect(run.started()).toBe(2)
    expect(run.outstanding()).toBe(1)
    run.scheduler.dispose()
  })

  test('a wake during a run is honoured after it, still without overlapping', async () => {
    const run = gatedHarness()

    await run.clock.advance(INTERVAL_MS)
    expect(run.started()).toBe(1)

    // A doorbell that arrives mid-run refers to a change the running sync may have already passed, so it earns a follow-up run after that one settles, never a parallel one.
    run.scheduler.wake('wakeup')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.started()).toBe(1)

    run.release('ok')
    await flushMicrotasks()
    expect(run.started()).toBe(2)
    expect(run.peakConcurrency()).toBe(1)
    run.scheduler.dispose()
  })

  test('a merely slow sync is not turned into a continuous back-to-back loop', async () => {
    // A healthy sync that takes longer than the interval must keep its idle gap: if every skipped tick booked a catch-up, each settle would immediately start the next run and the client would sync without pause forever.
    const run = gatedHarness()

    await run.clock.advance(INTERVAL_MS)
    expect(run.started()).toBe(1)
    // One skipped tick only, still short of the stall threshold.
    await run.clock.advance(INTERVAL_MS)

    run.release('ok')
    await flushMicrotasks()
    expect(run.started()).toBe(1)
    run.scheduler.dispose()
  })
})

describe('sync scheduler: liveness', () => {
  test('a rejected attempt still leaves the next tick armed', async () => {
    const run = harness(() => 'fail')

    await run.clock.advance(10 * 60_000)
    expect(run.attempts.length).toBeGreaterThan(10)
    expect(run.clock.armedCount()).toBe(1)
    run.scheduler.dispose()
  })

  test('an attempt that never settles keeps the loop armed instead of unarming it', async () => {
    // The loop must keep ticking while an attempt hangs. It must NOT keep running syncs: only a request that can be cancelled could free the slot, and Promise.race cannot cancel one, so the honest guarantee is "armed and observant".
    const run = harness((attempt) => (attempt === 1 ? 'hang' : 'ok'))

    await run.clock.advance(60_000)
    expect(run.attempts).toHaveLength(1)
    expect(run.clock.armedCount()).toBe(1)
    run.scheduler.dispose()
  })

  test('the stall is reported at STALLED_ATTEMPT_TICKS without freeing the slot', async () => {
    const sink = recordingLogger()
    const run = harness((attempt) => (attempt === 1 ? 'hang' : 'ok'), { logger: sink.logger })

    // Tick 1 starts the hang, tick 2 skips it, tick 3 is the STALLED_ATTEMPT_TICKS'th tick to find it in flight and declares it wedged.
    await run.clock.advance(INTERVAL_MS * STALLED_ATTEMPT_TICKS)
    expect(sink.events).toContain('sync.skipped')
    expect(sink.events).not.toContain('sync.stalled')

    await run.clock.advance(INTERVAL_MS)
    expect(sink.events).toContain('sync.stalled')
    // Reported as unhealthy, but the request is still out there, so the slot stays taken and no second sync is started on top of it.
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test('progress resumes the moment a hung attempt settles, without waiting for a tick', async () => {
    const run = gatedHarness()

    await run.clock.advance(10 * 60_000)
    expect(run.started()).toBe(1)
    expect(run.clock.armedCount()).toBe(1)

    // The half-open socket answers. The stall already booked the catch-up run, so it goes out on the settle itself rather than after a capped backoff: the fastest recovery that keeps mutual exclusion.
    run.release('ok')
    await flushMicrotasks()
    expect(run.started()).toBe(2)

    // And a healthy settle puts the loop back on its plain interval: the stall counted as one failure, and the success cleared it.
    run.release('ok')
    await flushMicrotasks()
    const beforeIdle = run.started()

    await run.clock.advance(INTERVAL_MS)
    expect(run.started()).toBe(beforeIdle + 1)
    run.scheduler.dispose()
  })

  test('dispose stops the loop and releases the pending timer', async () => {
    const run = harness(() => 'ok')

    await run.clock.advance(INTERVAL_MS * 3)
    const seen = run.attempts.length

    run.scheduler.dispose()
    expect(run.clock.armedCount()).toBe(0)
    await run.clock.advance(10 * 60_000)
    expect(run.attempts).toHaveLength(seen)
  })
})

describe('sync scheduler: backoff', () => {
  test('consecutive failures double the interval and cap at MAX_BACKOFF_MS', async () => {
    const run = harness(() => 'fail')

    await run.clock.advance(300_000)
    expect(run.gaps().slice(0, 5)).toEqual([2_000, 4_000, 8_000, 16_000, MAX_BACKOFF_MS])
    expect(Math.max(...run.gaps())).toBe(MAX_BACKOFF_MS)
    run.scheduler.dispose()
  })

  test('no gap in a long outage ever exceeds the cap', async () => {
    const run = harness(() => 'fail')

    await run.clock.advance(6 * 60 * 60_000)

    for (const gap of run.gaps()) {
      expect(gap).toBeLessThanOrEqual(MAX_BACKOFF_MS)
    }
    run.scheduler.dispose()
  })

  test('the first success resets the loop to its configured interval', async () => {
    const failuresBeforeRecovery = 6
    const run = harness((attempt) => (attempt <= failuresBeforeRecovery ? 'fail' : 'ok'))

    await run.clock.advance(300_000)
    const gaps = run.gaps()

    expect(Math.max(...gaps)).toBe(MAX_BACKOFF_MS)
    // Once healthy the cadence is the plain configured interval again.
    expect(gaps.slice(-5)).toEqual([INTERVAL_MS, INTERVAL_MS, INTERVAL_MS, INTERVAL_MS, INTERVAL_MS])
    run.scheduler.dispose()
  })

  test('backoff never shortens a deliberately slow poll', async () => {
    const slowMs = MAX_BACKOFF_MS * 4
    const run = harness(() => 'fail', { intervalMs: slowMs })

    await run.clock.advance(slowMs * 10)

    for (const gap of run.gaps()) {
      expect(gap).toBe(slowMs)
    }
    run.scheduler.dispose()
  })
})

describe('sync scheduler: wake', () => {
  test('wake clears the failure streak and attempts within the debounce window', async () => {
    let healthy = false
    const run = harness(() => (healthy ? 'ok' : 'fail'))

    await run.clock.advance(300_000)
    // Deep in the capped backoff: without a wake the next attempt is 30s out.
    expect(run.gaps()[run.gaps().length - 1]).toBe(MAX_BACKOFF_MS)

    healthy = true
    const beforeWake = run.attempts.length

    run.scheduler.wake('connectivity')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(beforeWake + 1)
    // The failure streak is cleared, so the loop is back on its base interval.
    await run.clock.advance(INTERVAL_MS * 3)
    expect(run.gaps().slice(-2)).toEqual([INTERVAL_MS, INTERVAL_MS])
    run.scheduler.dispose()
  })

  test('a burst of wake signals coalesces into one attempt', async () => {
    const run = harness(() => 'ok')
    const beforeBurst = run.attempts.length

    for (let signal = 0; signal < 50; signal += 1) {
      run.scheduler.wake('wakeup')
    }
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(beforeBurst + 1)
    run.scheduler.dispose()
  })

  test('a foreground wake coalesces with other reasons into one attempt', async () => {
    const run = harness(() => 'ok')
    const beforeBurst = run.attempts.length

    run.scheduler.wake('foreground')
    run.scheduler.wake('wakeup')
    run.scheduler.wake('connectivity')
    run.scheduler.wake('foreground')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(beforeBurst + 1)
    run.scheduler.dispose()
  })

  test('a non-positive interval arms no timer and stays purely wake-driven', async () => {
    const run = harness(() => 'ok', { intervalMs: 0 })

    expect(run.clock.armedCount()).toBe(0)
    await run.clock.advance(10 * 60_000)
    expect(run.attempts).toHaveLength(0)

    run.scheduler.wake('wakeup')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(1)
    // Wake-driven only: no periodic follow-up was armed.
    await run.clock.advance(10 * 60_000)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test('wake after dispose does nothing', async () => {
    const run = harness(() => 'ok')

    run.scheduler.dispose()
    run.scheduler.wake('connectivity')
    await run.clock.advance(10 * 60_000)
    expect(run.clock.armedCount()).toBe(0)
  })
})

// MARK: - Queue wake

/**
 * The local-write wake: the engine rings this one on a QUEUE_DEPTH event with a
 * non-zero depth, so an outbox row leaves without a manual sync. It is an
 * ordinary wake reason, which is the point: the debounce, the in-flight guard,
 * and the backoff already own the burst, the overlap, and the retry, so the
 * caller adds no gate of its own.
 */
describe('sync scheduler: queue wake', () => {
  test('a local write leads to exactly one attempt after the debounce', async () => {
    const run = harness(() => 'ok', { intervalMs: 0 })

    run.scheduler.wake('queue')
    await run.clock.advance(WAKE_DEBOUNCE_MS - 1)
    expect(run.attempts).toHaveLength(0)

    await run.clock.advance(1)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test('a burst of local writes inside the debounce window leads to one attempt', async () => {
    const run = harness(() => 'ok', { intervalMs: 0 })

    for (let write = 0; write < 5; write += 1) {
      run.scheduler.wake('queue')
    }
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(1)
    // Wake-driven only: nothing follows the coalesced run on its own.
    await run.clock.advance(10 * 60_000)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test('a rejected attempt starts no second attempt from the same write', async () => {
    // The retry belongs to the backoff, which a wake-only scheduler does not arm: a failed push stays queued until the next real signal. Re-running it here would turn one refused write into a hot loop against the remote.
    const run = harness(() => 'fail', { intervalMs: 0 })

    run.scheduler.wake('queue')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(1)

    await run.clock.advance(10 * 60_000)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test('a rejected attempt under a poll leaves the retry to the backoff', async () => {
    const run = harness(() => 'fail')
    const beforeWake = run.attempts.length

    run.scheduler.wake('queue')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(beforeWake + 1)

    // The next attempt is the backed-off tick, not an immediate second try.
    await run.clock.advance(INTERVAL_MS - 1)
    expect(run.attempts).toHaveLength(beforeWake + 1)
    run.scheduler.dispose()
  })
})

// MARK: - Automatic switch

/** Counts what the observer hears, which is what sync health would publish. */
const countingObserver = (): { observer: ISyncSchedulerObserver; woken: () => number } => {
  let woken = 0

  return {
    observer: {
      armed: () => undefined,
      stalled: () => undefined,
      woken: () => {
        woken += 1
      },
    },
    woken: () => woken,
  }
}

/**
 * `shouldRun` is the host's say over the automatic loop: a live-sync switch the
 * user turned off, or a browser tab that does not lead its database. While it
 * answers false a tick and a wake start nothing and report nothing, and the
 * loop stays armed, so it resumes the moment the answer turns.
 */
describe('sync scheduler: automatic switch', () => {
  test('a poll tick starts no attempt while shouldRun answers false, and the loop stays armed', async () => {
    let isAllowed = false
    const run = harness(() => 'ok', { shouldRun: () => isAllowed })

    await run.clock.advance(INTERVAL_MS * 5)
    expect(run.attempts).toHaveLength(0)
    expect(run.clock.armedCount()).toBe(1)

    isAllowed = true
    await run.clock.advance(INTERVAL_MS)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test.each(['connectivity', 'wakeup', 'foreground', 'queue', 'promotion'] as const)(
    'a %s wake starts no attempt and reports nothing while shouldRun answers false',
    async (reason) => {
      const sink = countingObserver()
      const run = harness(() => 'ok', { intervalMs: 0, shouldRun: () => false, observer: sink.observer, now: () => 0 })

      run.scheduler.wake(reason)
      expect(run.clock.armedCount()).toBe(0)

      await run.clock.advance(10 * 60_000)
      expect(run.attempts).toHaveLength(0)
      expect(sink.woken()).toBe(0)
      run.scheduler.dispose()
    },
  )

  test('a wake skipped while shouldRun answers false does not hold back the next one', async () => {
    let isAllowed = false
    const run = harness(() => 'ok', { intervalMs: 0, shouldRun: () => isAllowed })

    run.scheduler.wake('queue')
    isAllowed = true
    run.scheduler.wake('queue')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })

  test('a wake armed before shouldRun turns false starts nothing when it fires', async () => {
    let isAllowed = true
    const run = harness(() => 'ok', { intervalMs: 0, shouldRun: () => isAllowed })

    run.scheduler.wake('wakeup')
    isAllowed = false
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(0)
    run.scheduler.dispose()
  })

  test('the catch-up run a wake booked during an attempt is skipped once shouldRun answers false', async () => {
    let isAllowed = true
    const run = gatedHarness({ shouldRun: () => isAllowed })

    await run.clock.advance(INTERVAL_MS)
    expect(run.started()).toBe(1)

    run.scheduler.wake('wakeup')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    isAllowed = false
    run.release('ok')
    await flushMicrotasks()
    expect(run.started()).toBe(1)
    run.scheduler.dispose()
  })

  test('a promotion wake attempts within the debounce window', async () => {
    const run = harness(() => 'ok', { intervalMs: 0 })

    run.scheduler.wake('promotion')
    await run.clock.advance(WAKE_DEBOUNCE_MS)
    expect(run.attempts).toHaveLength(1)
    run.scheduler.dispose()
  })
})

describe('sync scheduler: diagnostics', () => {
  test('every transition is reported: failure, recovery, stall and wake', async () => {
    const sink = recordingLogger()
    let script: 'fail' | 'hang' | 'ok' = 'fail'
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => {
        if (script === 'hang') {
          return new Promise<void>(() => undefined)
        }
        return script === 'ok' ? Promise.resolve() : Promise.reject(new Error('remote unreachable'))
      },
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: sink.logger,
      random: NO_JITTER,
    })

    await clock.advance(5_000)
    expect(sink.events).toContain('sync.failed')

    script = 'ok'
    await clock.advance(60_000)
    expect(sink.events).toContain('sync.recovered')

    script = 'hang'
    await clock.advance(60_000)
    expect(sink.events).toContain('sync.skipped')
    expect(sink.events).toContain('sync.stalled')

    script = 'ok'
    scheduler.wake('connectivity')
    await clock.advance(WAKE_DEBOUNCE_MS)
    expect(sink.events).toContain('sync.woken')
    scheduler.dispose()
  })
})

describe('sync scheduler: observer', () => {
  // The observer only ever receives what the logger already reported; these pin that it receives it at the same instants, with exact armed times.
  const observed = (): {
    observer: ISyncSchedulerObserver
    armedAt: Array<number | null>
    stalls: () => number
    wakes: () => number
  } => {
    const armedAt: Array<number | null> = []
    let stalls = 0
    let wakes = 0

    return {
      observer: {
        armed: (at) => armedAt.push(at),
        stalled: () => {
          stalls += 1
        },
        woken: () => {
          wakes += 1
        },
      },
      armedAt,
      stalls: () => stalls,
      wakes: () => wakes,
    }
  }

  test('armed reports the exact instant the next attempt is due', async () => {
    const sink = observed()
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => Promise.resolve(),
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      random: NO_JITTER,
      observer: sink.observer,
      now: clock.now,
    })

    // Jitter is pinned to the top of the window, so the first tick is due one whole interval out and the armed time is exact, not a range.
    expect(sink.armedAt).toEqual([INTERVAL_MS])

    await clock.advance(INTERVAL_MS)
    expect(sink.armedAt).toEqual([INTERVAL_MS, INTERVAL_MS * 2])
    scheduler.dispose()
  })

  test('a failing loop reports each armed time with the grown backoff', async () => {
    const sink = observed()
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => Promise.reject(new Error('remote unreachable')),
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      random: NO_JITTER,
      observer: sink.observer,
      now: clock.now,
    })

    await clock.advance(INTERVAL_MS * 4)

    // Every reported time is in the future relative to the tick that armed it, and the gaps grow, the same backoff the attempt gaps show.
    for (const at of sink.armedAt) {
      expect(at).not.toBeNull()
    }
    expect(sink.armedAt[sink.armedAt.length - 1]!).toBeGreaterThan(clock.now())
    scheduler.dispose()
  })

  test('stalled fires once for a wedged attempt, however many ticks it occupies', async () => {
    const sink = observed()
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => new Promise<void>(() => undefined),
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      random: NO_JITTER,
      observer: sink.observer,
      now: clock.now,
    })

    await clock.advance(INTERVAL_MS * STALLED_ATTEMPT_TICKS)
    expect(sink.stalls()).toBe(0)

    await clock.advance(10 * 60_000)
    expect(sink.stalls()).toBe(1)
    scheduler.dispose()
  })

  test('woken fires on every wake, including one that had no streak to clear', async () => {
    const sink = observed()
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => Promise.resolve(),
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      random: NO_JITTER,
      observer: sink.observer,
      now: clock.now,
    })

    scheduler.wake('connectivity')
    expect(sink.wakes()).toBe(1)
    // The burst still coalesces into one attempt, so the second signal is dropped before it reaches the observer.
    scheduler.wake('wakeup')
    expect(sink.wakes()).toBe(1)

    await clock.advance(WAKE_DEBOUNCE_MS)
    scheduler.wake('foreground')
    expect(sink.wakes()).toBe(2)
    scheduler.dispose()
  })

  test('dispose reports that nothing is armed any more', async () => {
    const sink = observed()
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => Promise.resolve(),
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      random: NO_JITTER,
      observer: sink.observer,
      now: clock.now,
    })

    await clock.advance(INTERVAL_MS * 2)
    scheduler.dispose()
    expect(sink.armedAt[sink.armedAt.length - 1]).toBeNull()
  })

  test('the corpus path reads no clock at all: no observer, no interval, no timer', async () => {
    let clockReads = 0
    const clock = createVirtualClock()
    const scheduler = createSyncScheduler({
      sync: () => Promise.resolve(),
      intervalMs: 0,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      now: () => {
        clockReads += 1

        return clock.now()
      },
    })

    await clock.advance(10 * 60_000)
    expect(clock.armedCount()).toBe(0)
    expect(clockReads).toBe(0)
    scheduler.dispose()
  })
})

describe('sync scheduler: soak', () => {
  test('1000+ attempts across a flapping network: the loop never stops and always recovers', async () => {
    // Six-minute outages alternating with six-minute healthy windows, long enough to drive well over a thousand attempts. Under test: the loop is armed at every instant, no retry gap exceeds the cap, and each healthy window is entered within one capped retry of it opening.
    const WINDOW_MS = 6 * 60_000
    const clock = createVirtualClock()
    const attempts: Array<{ at: number; healthy: boolean }> = []
    const isHealthy = (atMs: number): boolean => Math.floor(atMs / WINDOW_MS) % 2 === 1
    const scheduler = createSyncScheduler({
      sync: () => {
        const healthy = isHealthy(clock.now())

        attempts.push({ at: clock.now(), healthy })

        return healthy ? Promise.resolve() : Promise.reject(new Error('remote unreachable'))
      },
      intervalMs: INTERVAL_MS,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      logger: noopLogger,
      random: NO_JITTER,
    })

    const windows = 24

    for (let window = 0; window < windows; window += 1) {
      await clock.advance(WINDOW_MS)
      // Armed-count is checked on every window. A final check would miss a gap in the middle of the run.
      expect(clock.armedCount()).toBe(1)
    }

    expect(attempts.length).toBeGreaterThan(1_000)

    const gaps = attempts.slice(1).map((entry, index) => entry.at - attempts[index]!.at)

    expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_BACKOFF_MS)

    // Every healthy window was used, so the client resumes syncing on its own each time the network comes back, with no call from the app.
    const healthyWindows = new Set(
      attempts.filter((entry) => entry.healthy).map((entry) => Math.floor(entry.at / WINDOW_MS)),
    )

    expect(healthyWindows.size).toBe(windows / 2)

    // Recovery latency is bounded: the first successful attempt of a window lands within one capped retry of the window opening.
    for (const window of healthyWindows) {
      const first = attempts.find((entry) => entry.healthy && Math.floor(entry.at / WINDOW_MS) === window)!

      expect(first.at - window * WINDOW_MS).toBeLessThanOrEqual(MAX_BACKOFF_MS)
    }
    scheduler.dispose()
  })
})
