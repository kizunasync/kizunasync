// MARK: - Sync health tracker

/**
 * Pins the derivation rules and the notification contract in isolation:
 * injected epoch clock, injected connectivity. No wall time, no real engine.
 * A UI can then tell blocked from waiting from offline.
 */

import { describe, expect, test } from 'bun:test'
import { createSyncHealthTracker, ESyncPhase, type ISyncHealth } from './sync-health'

type TFixture = {
  tracker: ReturnType<typeof createSyncHealthTracker>
  setNow: (ms: number) => void
  setOnline: (online: boolean) => void
}

const fixture = (): TFixture => {
  let nowMs = 1_000
  let online = true

  return {
    tracker: createSyncHealthTracker({ now: () => nowMs, isOnline: () => online }),
    setNow: (ms) => {
      nowMs = ms
    },
    setOnline: (next) => {
      online = next
    },
  }
}

const codedError = (code: string, message: string): Error => {
  const error = new Error(message)

  ;(error as { code?: string }).code = code

  return error
}

describe('sync health: phase derivation', () => {
  test('a fresh tracker is idle with nothing recorded', () => {
    const { tracker } = fixture()

    expect(tracker.snapshot()).toEqual({
      phase: ESyncPhase.idle,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      attemptStartedAt: null,
      lastSuccessAt: null,
      lastError: null,
      softBlockReason: null,
    })
  })

  test('an attempt in flight is syncing, and a success returns it to idle', () => {
    const { tracker, setNow } = fixture()

    setNow(5_000)
    const attempt = tracker.attemptStarted()

    expect(tracker.snapshot().phase).toBe(ESyncPhase.syncing)
    expect(tracker.snapshot().attemptStartedAt).toBe(5_000)

    setNow(6_000)
    tracker.attemptSettled(attempt, null)
    const health = tracker.snapshot()

    expect(health.phase).toBe(ESyncPhase.idle)
    expect(health.attemptStartedAt).toBeNull()
    expect(health.lastSuccessAt).toBe(6_000)
    expect(health.consecutiveFailures).toBe(0)
  })

  test('a failed attempt is backoff, and records the code and message', () => {
    const { tracker, setNow } = fixture()

    setNow(9_000)
    tracker.attemptSettled(tracker.attemptStarted(), codedError('AUTH_SESSION_TIMEOUT', 'auth.getSession() timed out'))
    const health = tracker.snapshot()

    expect(health.phase).toBe(ESyncPhase.backoff)
    expect(health.consecutiveFailures).toBe(1)
    expect(health.lastError).toEqual({
      code: 'AUTH_SESSION_TIMEOUT',
      message: 'auth.getSession() timed out',
      at: 9_000,
    })
  })

  test('a failure with no code records null rather than inventing one', () => {
    const { tracker } = fixture()

    tracker.attemptSettled(tracker.attemptStarted(), new Error('network unreachable'))
    expect(tracker.snapshot().lastError?.code).toBeNull()
  })

  test('a thrown non-Error is stringified rather than dropped', () => {
    const { tracker } = fixture()

    tracker.attemptSettled(tracker.attemptStarted(), 'socket hung up')
    expect(tracker.snapshot().lastError?.message).toBe('socket hung up')
  })

  test('a stalled attempt outranks syncing and counts one failure per attempt', () => {
    const { tracker } = fixture()

    const wedged = tracker.attemptStarted()

    tracker.stalled()
    tracker.stalled()
    tracker.stalled()
    const health = tracker.snapshot()

    expect(health.phase).toBe(ESyncPhase.stalled)
    expect(health.consecutiveFailures).toBe(1)

    // The next attempt starts clean: the stall belonged to the wedged one.
    tracker.attemptSettled(wedged, new Error('connection reset'))
    tracker.attemptStarted()
    expect(tracker.snapshot().phase).toBe(ESyncPhase.syncing)
  })

  test('offline outranks every other phase, in flight or not', () => {
    const { tracker, setOnline } = fixture()

    tracker.attemptStarted()
    tracker.stalled()
    setOnline(false)
    expect(tracker.snapshot().phase).toBe(ESyncPhase.offline)

    setOnline(true)
    expect(tracker.snapshot().phase).toBe(ESyncPhase.stalled)
  })

  test('a wake clears the streak the way the scheduler does', () => {
    const { tracker } = fixture()

    tracker.attemptSettled(tracker.attemptStarted(), new Error('network unreachable'))
    tracker.attemptSettled(tracker.attemptStarted(), new Error('network unreachable'))
    expect(tracker.snapshot().consecutiveFailures).toBe(2)

    tracker.woken()
    expect(tracker.snapshot().consecutiveFailures).toBe(0)
    expect(tracker.snapshot().phase).toBe(ESyncPhase.idle)
    // The wake says the failures are stale, not that they never happened.
    expect(tracker.snapshot().lastError).not.toBeNull()
  })

  test('armed carries the next attempt time and dispose clears it', () => {
    const { tracker } = fixture()

    tracker.armed(42_000)
    expect(tracker.snapshot().nextAttemptAt).toBe(42_000)
    tracker.armed(null)
    expect(tracker.snapshot().nextAttemptAt).toBeNull()
  })
})

describe('sync health: subscription', () => {
  test('every transition notifies with the new snapshot', () => {
    const { tracker } = fixture()
    const seen: ISyncHealth[] = []

    tracker.subscribe((health) => seen.push(health))

    tracker.armed(3_000)
    tracker.attemptSettled(tracker.attemptStarted(), null)
    expect(seen.map((health) => health.phase)).toEqual(['idle', 'syncing', 'idle'])
    expect(seen[0]?.nextAttemptAt).toBe(3_000)
  })

  test('a connectivity change publishes even though nothing else moved', () => {
    const { tracker, setOnline } = fixture()
    const seen: ISyncHealth[] = []

    tracker.subscribe((health) => seen.push(health))

    setOnline(false)
    tracker.connectivityChanged()
    expect(seen.map((health) => health.phase)).toEqual(['offline'])
  })

  test('unsubscribing stops the listener', () => {
    const { tracker } = fixture()
    let count = 0
    const stop = tracker.subscribe(() => {
      count += 1
    })

    const attempt = tracker.attemptStarted()

    stop()
    tracker.attemptSettled(attempt, null)
    expect(count).toBe(1)
  })

  test('a throwing listener is isolated from the others and from the loop', () => {
    const { tracker } = fixture()
    const seen: string[] = []

    tracker.subscribe(() => {
      throw new Error('app callback blew up')
    })
    tracker.subscribe((health) => seen.push(health.phase))

    expect(() => tracker.attemptStarted()).not.toThrow()
    expect(seen).toEqual(['syncing'])
  })

  test('a snapshot is frozen, so a listener cannot mutate shared state', () => {
    const { tracker } = fixture()
    const health = tracker.snapshot()

    expect(Object.isFrozen(health)).toBe(true)
  })

  // MARK: - Server signals

  test('a signal survives the successful attempt it arrived on', () => {
    const { tracker, setNow } = fixture()

    const attempt = tracker.attemptStarted()

    setNow(2_000)
    tracker.signalled({ code: 'RESET_REQUIRED', message: 'sync is blocked until reset() runs' })
    tracker.attemptSettled(attempt, null)

    const health = tracker.snapshot()

    expect(health.lastError).toEqual({
      code: 'RESET_REQUIRED',
      message: 'sync is blocked until reset() runs',
      at: 2_000,
    })
    // The attempt completed, so the streak and the success stamp are untouched: the backoff has nothing to back off from.
    expect(health.consecutiveFailures).toBe(0)
    expect(health.lastSuccessAt).toBe(2_000)
  })

  test('a signal that lands after the settle is recorded all the same', () => {
    const { tracker } = fixture()

    tracker.attemptSettled(tracker.attemptStarted(), null)
    tracker.signalled({ code: 'CHECKPOINT_EXPIRED', message: 'the cursor fell behind' })

    expect(tracker.snapshot().lastError?.code).toBe('CHECKPOINT_EXPIRED')
  })

  test('the next clean attempt clears a signal nothing repeated', () => {
    const { tracker } = fixture()

    const signalledAttempt = tracker.attemptStarted()

    tracker.signalled({ code: 'CHECKPOINT_EXPIRED', message: 'the cursor fell behind' })
    tracker.attemptSettled(signalledAttempt, null)
    expect(tracker.snapshot().lastError).not.toBeNull()

    tracker.attemptSettled(tracker.attemptStarted(), null)

    expect(tracker.snapshot().lastError).toBeNull()
  })

  test('a signal notifies subscribers', () => {
    const { tracker } = fixture()
    const seen: Array<ISyncHealth['lastError']> = []

    tracker.subscribe((health) => seen.push(health.lastError))

    tracker.signalled({ code: 'RESET_REQUIRED', message: 'sync is blocked' })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.code).toBe('RESET_REQUIRED')
  })
})

// MARK: - Overlapping attempts

/**
 * A manual `sync()` can run while the scheduler's own attempt is still in
 * flight. Each settle belongs to the attempt that started it, the snapshot
 * reports the oldest attempt still in flight, and a stall or a signal is
 * judged against that oldest attempt.
 */
describe('sync health: overlapping attempts', () => {
  test('the snapshot reports the oldest attempt still in flight', () => {
    const { tracker, setNow } = fixture()

    setNow(1_000)
    const scheduled = tracker.attemptStarted()

    setNow(2_000)
    const manual = tracker.attemptStarted()

    expect(tracker.snapshot().attemptStartedAt).toBe(1_000)

    tracker.attemptSettled(scheduled, null)
    expect(tracker.snapshot()).toMatchObject({ phase: ESyncPhase.syncing, attemptStartedAt: 2_000 })

    tracker.attemptSettled(manual, null)
    expect(tracker.snapshot()).toMatchObject({ phase: ESyncPhase.idle, attemptStartedAt: null })
  })

  test('a settle pairs with its own attempt, whichever settles first', () => {
    const { tracker, setNow } = fixture()

    setNow(1_000)
    const scheduled = tracker.attemptStarted()

    setNow(2_000)
    const manual = tracker.attemptStarted()

    tracker.attemptSettled(manual, new Error('network unreachable'))
    expect(tracker.snapshot()).toMatchObject({
      phase: ESyncPhase.syncing,
      attemptStartedAt: 1_000,
      consecutiveFailures: 1,
    })

    tracker.attemptSettled(scheduled, null)
    expect(tracker.snapshot()).toMatchObject({ phase: ESyncPhase.idle, consecutiveFailures: 0 })
  })

  test('a stall is judged against the oldest attempt in flight', () => {
    const { tracker } = fixture()
    const scheduled = tracker.attemptStarted()

    tracker.attemptStarted()
    tracker.stalled()
    expect(tracker.snapshot()).toMatchObject({ phase: ESyncPhase.stalled, consecutiveFailures: 1 })

    // The stall belonged to the settled attempt: the one still running has not stalled yet.
    tracker.attemptSettled(scheduled, new Error('connection reset'))
    expect(tracker.snapshot()).toMatchObject({ phase: ESyncPhase.syncing, consecutiveFailures: 2 })

    tracker.stalled()
    expect(tracker.snapshot()).toMatchObject({ phase: ESyncPhase.stalled, consecutiveFailures: 3 })
  })

  test('a signal belongs to the oldest attempt in flight and survives a clean settle of another one', () => {
    const { tracker } = fixture()
    const scheduled = tracker.attemptStarted()
    const manual = tracker.attemptStarted()

    tracker.signalled({ code: 'RESET_REQUIRED', message: 'sync is blocked' })
    tracker.attemptSettled(manual, null)
    expect(tracker.snapshot().lastError?.code).toBe('RESET_REQUIRED')

    tracker.attemptSettled(scheduled, null)
    expect(tracker.snapshot().lastError?.code).toBe('RESET_REQUIRED')

    tracker.attemptSettled(tracker.attemptStarted(), null)
    expect(tracker.snapshot().lastError).toBeNull()
  })

  test('a settle for an attempt that already settled changes nothing', () => {
    const { tracker } = fixture()
    const attempt = tracker.attemptStarted()

    tracker.attemptSettled(attempt, null)
    tracker.attemptSettled(attempt, new Error('late'))

    expect(tracker.snapshot()).toMatchObject({ consecutiveFailures: 0, lastError: null })
  })
})

// MARK: - Soft-block reason

/**
 * Why sync is soft-blocked until `reset()`. The engine names it on the
 * `RESET_REQUIRED` that latches the block and in the checkpoint a store opens
 * with, so the tracker holds it beside the loop state: a banner reading health
 * alone can tell a schema reset from a change of signed-in account.
 */
describe('sync health: soft-block reason', () => {
  test.each(['reset_required', 'identity_changed'] as const)('the snapshot carries %s once it is recorded', (reason) => {
    const { tracker } = fixture()

    tracker.softBlockChanged(reason)

    expect(tracker.snapshot().softBlockReason).toBe(reason)
  })

  test('clearing the reason returns the snapshot to null', () => {
    const { tracker } = fixture()

    tracker.softBlockChanged('identity_changed')
    tracker.softBlockChanged(null)

    expect(tracker.snapshot().softBlockReason).toBeNull()
  })

  test('a change notifies subscribers, and an unchanged reason does not', () => {
    const { tracker } = fixture()
    const seen: Array<ISyncHealth['softBlockReason']> = []

    tracker.subscribe((health) => seen.push(health.softBlockReason))

    tracker.softBlockChanged('reset_required')
    tracker.softBlockChanged('reset_required')
    tracker.softBlockChanged(null)
    tracker.softBlockChanged(null)

    expect(seen).toEqual(['reset_required', null])
  })

  test('a clean attempt leaves the reason in place: only a reset clears it', () => {
    const { tracker } = fixture()

    tracker.softBlockChanged('reset_required')
    tracker.attemptSettled(tracker.attemptStarted(), null)
    tracker.attemptSettled(tracker.attemptStarted(), null)

    expect(tracker.snapshot().softBlockReason).toBe('reset_required')
  })
})
