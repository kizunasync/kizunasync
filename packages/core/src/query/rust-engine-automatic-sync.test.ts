/// <reference types="bun" />
// MARK: - The host's say over automatic sync

/**
 * Two hosts decide whether the automatic loop may run, and neither may stop an
 * explicit `sync()`. `shouldSyncAutomatically` is the app's switch (a live-sync
 * toggle the user turned off). A transport's `leadership` is the browser's: only
 * the tab that leads a database drives its loop, while a follower's manual sync
 * still reaches the leader through the transport. Either one answering no skips
 * every automatic wake with no attempt and no health change, and a promotion to
 * leader wakes the loop once. The loop itself starts with one attempt inside the
 * wake debounce, under the same two switches.
 *
 * A fake transport stands in for the engine: the wiring is under test, not the
 * Rust core. The timer pair and every signal port are injected, so each
 * assertion below is exact.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createRustEngine } from './rust-engine'
import { WAKE_DEBOUNCE_MS } from '../host/sync-scheduler'
import { noopLogger, type ILogger } from '../util/logger'
import type { IAppClientEngine } from './select-engine'
import type { IEngineLeadership, TEngineTransportFactory } from '../ports/engine-transport'
import type { IProtocolRemote } from '../ports/protocol-remote'
import { EEngineEventType, type TEngineConfig } from '../wire/types'

const CONFIG: TEngineConfig = {
  tables: { todos: { bucketColumn: 'owner_id', bucketParams: { owner_id: 'user-a' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'

const POLL_MS = 1_000

const UNBLOCKED_CHECKPOINT = { cursor: '0', soft_blocked: false, soft_block_reason: null }

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake transport never calls the remote')),
  push: () => Promise.reject(new Error('the fake transport never calls the remote')),
}

// MARK: - Harness

/** A leadership the test hands over and takes back, as the web driver's election does. */
type TFakeLeadership = IEngineLeadership & {
  set: (isLeader: boolean) => void
  subscribers: () => number
}

const fakeLeadership = (initial: boolean): TFakeLeadership => {
  let isLeader = initial
  const listeners = new Set<(leader: boolean) => void>()

  return {
    isLeader: () => isLeader,
    subscribe: (onChange) => {
      listeners.add(onChange)

      return () => {
        listeners.delete(onChange)
      }
    },
    set: (next) => {
      isLeader = next

      for (const listener of listeners) {
        listener(next)
      }
    },
    subscribers: () => listeners.size,
  }
}

/** A signal port the test rings by hand. */
const fakeSignal = (): { subscribe: (listener: () => void) => () => void; ring: () => void } => {
  const listeners = new Set<() => void>()

  return {
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    ring: () => {
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

type THarnessOptions = {
  shouldSyncAutomatically?: () => boolean
  leadership?: IEngineLeadership
  pollIntervalMs?: number
  logger?: ILogger

  /** What an engine `sync` call answers. */
  syncOutcome?: () => 'ok' | 'fail'
}

type TAutomaticHarness = {
  engine: IAppClientEngine

  /** How many `sync` calls reached the transport. */
  syncCalls: () => number

  /** Delays of every timer armed so far, in order. */
  armedDelays: number[]

  /** Run every timer due now, letting the callbacks re-arm as they go. */
  fire: () => Promise<void>

  /** Run the loop's start attempt, then clear the call and timer records. */
  settleStart: () => Promise<void>

  emit: (event: Record<string, unknown>) => void
  ringWakeup: () => void
  ringForeground: () => void
  goOnline: () => void
}

const opened: IAppClientEngine[] = []

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.dispose?.()
  }
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const harness = (options: THarnessOptions = {}): TAutomaticHarness => {
  const calls: string[] = []
  const armedDelays: number[] = []
  const pending = new Map<number, () => void>()
  let nextHandle = 0
  let emitEvent: (eventJson: string) => void = () => undefined
  const connectivityListeners = new Set<(online: boolean) => void>()
  const wakeup = fakeSignal()
  const foreground = fakeSignal()
  const { leadership } = options
  const engineFactory: TEngineTransportFactory = (_configJson, _databasePath, _pull, _push, onEvent) => {
    emitEvent = onEvent

    return {
      call: async (method) => {
        calls.push(method)

        if (method === 'sync' && options.syncOutcome?.() === 'fail') {
          return JSON.stringify({ ok: false, error: { kind: 'remote', message: 'remote unreachable' } })
        }
        return JSON.stringify({ ok: true, value: method === 'checkpoint' ? UNBLOCKED_CHECKPOINT : null })
      },
      close: () => undefined,
      ...(leadership === undefined ? {} : { leadership }),
    }
  }
  const engine = createRustEngine({
    engineFactory,
    databasePath: null,
    remote: idleRemote,
    config: CONFIG,
    clientId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    uuid: () => '00000000-0000-4000-8000-000000000002',
    logger: options.logger ?? noopLogger,
    deps: {
      connectivity: {
        isOnline: () => true,
        subscribe: (onChange) => {
          connectivityListeners.add(onChange)

          return () => {
            connectivityListeners.delete(onChange)
          }
        },
      },
      wakeup,
      foreground,
      pollIntervalMs: options.pollIntervalMs ?? 0,
      shouldSyncAutomatically: options.shouldSyncAutomatically,
      setTimer: (callback, delayMs) => {
        armedDelays.push(delayMs)
        nextHandle += 1
        pending.set(nextHandle, callback)

        return nextHandle
      },
      clearTimer: (handle) => {
        pending.delete(handle as number)
      },
    },
  })

  opened.push(engine)
  const fire = async (): Promise<void> => {
    const due = [...pending.values()]

    pending.clear()

    for (const callback of due) {
      callback()
    }
    await flush()
  }

  return {
    engine,
    syncCalls: () => calls.filter((method) => method === 'sync').length,
    armedDelays,
    fire,
    settleStart: async () => {
      await fire()
      calls.length = 0
      armedDelays.length = 0
    },
    emit: (event) => {
      emitEvent(JSON.stringify(event))
    },
    ringWakeup: wakeup.ring,
    ringForeground: foreground.ring,
    goOnline: () => {
      for (const listener of connectivityListeners) {
        listener(true)
      }
    },
  }
}

/** Every automatic wake the engine wires, rung the way its port rings it. */
const WAKES: Array<{ name: string; ring: (run: TAutomaticHarness) => void }> = [
  { name: 'a local write', ring: (run) => run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 }) },
  { name: 'a wakeup', ring: (run) => run.ringWakeup() },
  { name: 'a foreground signal', ring: (run) => run.ringForeground() },
  { name: 'a return to connectivity', ring: (run) => run.goOnline() },
]

// MARK: - shouldSyncAutomatically

describe('rust engine: shouldSyncAutomatically', () => {
  test('a poll tick starts no attempt while it answers false', async () => {
    const run = harness({ pollIntervalMs: POLL_MS, shouldSyncAutomatically: () => false })
    const before = run.engine.getSyncHealth()

    await run.fire()
    await run.fire()

    const after = run.engine.getSyncHealth()

    expect(run.syncCalls()).toBe(0)
    expect(after.attemptStartedAt).toBeNull()
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt)
    expect(after.consecutiveFailures).toBe(0)
    expect(after.phase).toBe(before.phase)
  })

  test.each(WAKES)('$name starts no attempt and leaves sync health as it was while it answers false', async ({ ring }) => {
    const run = harness({ shouldSyncAutomatically: () => false })

    await flush()
    const before = run.engine.getSyncHealth()

    ring(run)
    expect(run.armedDelays).toEqual([])

    await run.fire()
    expect(run.syncCalls()).toBe(0)
    expect(run.engine.getSyncHealth()).toEqual(before)
  })

  test('a manual sync still runs while it answers false', async () => {
    const run = harness({ shouldSyncAutomatically: () => false })

    await run.engine.sync()

    expect(run.syncCalls()).toBe(1)
    expect(run.engine.getSyncHealth().lastSuccessAt).not.toBeNull()
  })

  test('once it answers true again the next wake goes through', async () => {
    let isLive = false
    const run = harness({ shouldSyncAutomatically: () => isLive })

    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await run.fire()
    expect(run.syncCalls()).toBe(0)

    isLive = true
    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 2 })
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    expect(run.syncCalls()).toBe(1)
  })
})

// MARK: - The start attempt

describe('rust engine: the loop starts with one attempt', () => {
  test('the first attempt runs inside the wake debounce, not a poll interval later', async () => {
    const run = harness({ pollIntervalMs: POLL_MS })

    expect(run.armedDelays.at(-1)).toBe(WAKE_DEBOUNCE_MS)
    expect(run.syncCalls()).toBe(0)

    await run.fire()
    expect(run.syncCalls()).toBe(1)
  })

  test('without a poll the start attempt is the only one owed', async () => {
    const run = harness()

    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    await run.fire()
    expect(run.syncCalls()).toBe(1)
  })
})

// MARK: - Transport leadership

describe('rust engine: transport leadership', () => {
  test('a follower transport starts no attempt on a poll tick or on any wake', async () => {
    const run = harness({ pollIntervalMs: POLL_MS, leadership: fakeLeadership(false) })

    for (const { ring } of WAKES) {
      ring(run)
    }
    await run.fire()
    await run.fire()

    expect(run.syncCalls()).toBe(0)
  })

  test('a manual sync on a follower still reaches the transport', async () => {
    const run = harness({ leadership: fakeLeadership(false) })

    await run.engine.sync()

    expect(run.syncCalls()).toBe(1)
  })

  test('a promotion to leader wakes the loop once', async () => {
    const leadership = fakeLeadership(false)
    const run = harness({ leadership })

    leadership.set(true)
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    expect(run.syncCalls()).toBe(1)

    await run.fire()
    expect(run.syncCalls()).toBe(1)
  })

  test('the promotion wake names its reason', async () => {
    const woken: unknown[] = []
    const logger: ILogger = {
      debug: () => undefined,
      info: (message, meta) => {
        if (message === 'sync.woken') {
          woken.push(meta)
        }
      },
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
    }
    const leadership = fakeLeadership(true)
    let outcome: 'ok' | 'fail' = 'ok'
    const run = harness({ leadership, logger, syncOutcome: () => outcome })

    await run.settleStart()
    outcome = 'fail'
    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await run.fire()
    expect(run.syncCalls()).toBe(1)

    leadership.set(false)
    leadership.set(true)
    expect(woken).toEqual([{ reason: 'promotion', clearedFailures: 1 }])
  })

  test('losing leadership arms nothing, and the automatic wakes stop with it', async () => {
    const leadership = fakeLeadership(true)
    const run = harness({ leadership })

    await run.settleStart()
    leadership.set(false)
    expect(run.armedDelays).toEqual([])

    run.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await run.fire()
    expect(run.syncCalls()).toBe(0)
  })

  test('a promotion still skips the wake while shouldSyncAutomatically answers false', async () => {
    const leadership = fakeLeadership(false)
    const run = harness({ leadership, shouldSyncAutomatically: () => false })

    leadership.set(true)
    expect(run.armedDelays).toEqual([])
    await run.fire()
    expect(run.syncCalls()).toBe(0)
  })

  test('dispose stops listening to the leadership', () => {
    const leadership = fakeLeadership(false)
    const run = harness({ leadership })

    expect(leadership.subscribers()).toBe(1)
    run.engine.dispose?.()
    expect(leadership.subscribers()).toBe(0)

    leadership.set(true)
    expect(run.armedDelays).toEqual([])
  })
})
