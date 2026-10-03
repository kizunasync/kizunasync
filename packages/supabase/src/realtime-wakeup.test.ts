// MARK: - Realtime doorbell survival

/**
 * A doorbell that dies is INVISIBLE by construction: no signal is exactly what a
 * quiet table looks like. If the channel drops on an expired token and this
 * adapter does not re-subscribe, the client never hears about a change again.
 *
 * These tests pin that: every terminal subscribe status re-opens the channel
 * with capped exponential backoff, a re-opened channel still rings, a success
 * resets the backoff, and disposing cancels a retry in flight. Timers are
 * injected; every delay assertion is exact.
 */

import { describe, expect, test } from 'bun:test'
import type { ILogger } from '@kizunasync/core'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRealtimeWakeup } from './realtime-wakeup'

// MARK: - Virtual clock

type TVirtualClock = {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void

  /**
   * Fire every timer due within the window, in time order, letting callbacks
   * re-arm as they go. The reconnect path is fully synchronous.
   */
  advance: (ms: number) => void

  armedCount: () => number
}

const createVirtualClock = (): TVirtualClock => {
  const pending = new Map<number, { at: number; callback: () => void }>()
  let nowMs = 0
  let nextHandle = 0

  return {
    setTimer: (callback, delayMs) => {
      nextHandle += 1
      pending.set(nextHandle, { at: nowMs + delayMs, callback })

      return nextHandle
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
    advance: (ms) => {
      const target = nowMs + ms

      for (;;) {
        let dueHandle: number | null = null
        let dueAt = Number.POSITIVE_INFINITY

        for (const [handle, entry] of pending) {
          if (entry.at <= target && entry.at < dueAt) {
            dueHandle = handle
            dueAt = entry.at
          }
        }
        if (dueHandle === null) {
          break
        }
        const entry = pending.get(dueHandle)!

        pending.delete(dueHandle)
        nowMs = entry.at
        entry.callback()
      }
      nowMs = target
    },
    armedCount: () => pending.size,
  }
}

// MARK: - Fake supabase realtime

type TStatusCallback = (status: string, error?: Error) => void

interface IFakeChannel {
  topic: string
  isPrivate: boolean

  /**
   * Drives the subscribe callback the adapter registered, i.e. plays the role
   * of the realtime server reporting a join result or a later drop.
   */
  report: TStatusCallback

  /** Delivers a 'changed' broadcast on this channel. */
  ring: () => void

  removed: boolean
}

interface IFakeRealtime {
  client: SupabaseClient
  channels: IFakeChannel[]

  /** Channels opened for a table, oldest first. */
  forTable: (table: string) => IFakeChannel[]

  latest: (table: string) => IFakeChannel

  /** Plays the auth client: emits an auth state change to the registered listener. */
  emitAuth: (event: string, session: object | null) => void

  authUnsubscribed: () => boolean
}

const makeFakeRealtime = (): IFakeRealtime => {
  const channels: IFakeChannel[] = []
  let authListener: (event: string, session: object | null) => void = () => undefined
  let authUnsubscribed = false
  const client = {
    auth: {
      onAuthStateChange: (callback: (event: string, session: object | null) => void) => {
        authListener = callback

        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authUnsubscribed = true
              },
            },
          },
        }
      },
    },
    channel: (topic: string, opts?: { config?: { private?: boolean } }) => {
      let onStatus: TStatusCallback = () => undefined
      let onBroadcast: () => void = () => undefined
      const entry: IFakeChannel = {
        topic,
        isPrivate: opts?.config?.private ?? false,
        report: (status, error) => {
          onStatus(status, error)
        },
        ring: () => {
          onBroadcast()
        },
        removed: false,
      }
      const handle = {
        on: (_type: string, _filter: unknown, callback: () => void) => {
          onBroadcast = callback

          return handle
        },
        subscribe: (callback: TStatusCallback) => {
          onStatus = callback

          return handle
        },
        // Identity back-reference so removeChannel can mark the right entry.
        __entry: entry,
      }

      channels.push(entry)

      return handle
    },
    removeChannel: (handle: { __entry: IFakeChannel }) => {
      handle.__entry.removed = true

      return Promise.resolve('ok')
    },
  } as unknown as SupabaseClient
  const forTable = (table: string): IFakeChannel[] => channels.filter((c) => c.topic.endsWith(`:${table}`))

  return {
    client,
    channels,
    forTable,
    latest: (table) => forTable(table).at(-1)!,
    emitAuth: (event, session) => {
      authListener(event, session)
    },
    authUnsubscribed: () => authUnsubscribed,
  }
}

// MARK: - Capturing logger

type TRecord = { level: string; message: string; meta?: unknown }

const makeLogger = (): { logger: ILogger; records: TRecord[] } => {
  const records: TRecord[] = []
  const at =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      records.push({ level, message, meta })
    }
  const logger: ILogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }

  return { logger, records }
}

// MARK: - Harness

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

const setup = (tables: readonly string[] = ['todos']) => {
  const realtime = makeFakeRealtime()
  const clock = createVirtualClock()
  const { logger, records } = makeLogger()
  const signals: number[] = []
  const wakeup = createRealtimeWakeup(realtime.client, {
    tables,
    logger,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  const unsubscribe = wakeup.subscribe(() => {
    signals.push(signals.length)
  })

  return { realtime, clock, records, signals, unsubscribe }
}

// MARK: - Tests

describe('realtime doorbell', () => {
  test('opens one private channel per table on the kizunasync prefix', () => {
    const { realtime } = setup(['todos', 'lists'])

    expect(realtime.channels.map((c) => c.topic)).toEqual(['kizunasync:todos', 'kizunasync:lists'])
    expect(realtime.channels.every((c) => c.isPrivate)).toBe(true)
  })

  test('a broadcast rings the doorbell, and the payload never reaches the caller', () => {
    const { realtime, signals } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').ring()
    realtime.latest('todos').ring()
    // The adapter's handler takes no argument at all: a doorbell carries no data by construction.
    expect(signals).toHaveLength(2)
  })

  test.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])('a %s channel is re-subscribed', (status) => {
    const { realtime, clock } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').report(status)

    // Nothing is re-opened synchronously: the retry is a scheduled reconnect, not a hot loop against a server that refused us.
    expect(realtime.forTable('todos')).toHaveLength(1)

    clock.advance(RECONNECT_BASE_MS)
    expect(realtime.forTable('todos')).toHaveLength(2)
    // The dead handle is unregistered, otherwise every retry leaks a channel on the client's socket.
    expect(realtime.forTable('todos')[0]!.removed).toBe(true)
  })

  test('a CLOSED reported by the replaced channel is ignored: no drop, nothing scheduled', () => {
    const { realtime, clock, records } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').report('CLOSED')
    clock.advance(RECONNECT_BASE_MS)

    // The replaced channel still holds the adapter's old subscribe callback; supabase-js reports its own CLOSED to it as the socket tears it down. That must not re-trigger the reopen loop.
    const stale = realtime.forTable('todos')[0]!
    const recordsBefore = records.length

    stale.report('CLOSED')

    expect(records.slice(recordsBefore)).toEqual([])
    expect(clock.armedCount()).toBe(0)
    expect(realtime.forTable('todos')).toHaveLength(2)
  })

  test('a CLOSED reported by the current channel still reopens', () => {
    const { realtime, clock } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').report('CLOSED')
    clock.advance(RECONNECT_BASE_MS)
    realtime.latest('todos').report('SUBSCRIBED')

    realtime.latest('todos').report('CLOSED')
    clock.advance(RECONNECT_BASE_MS)

    expect(realtime.forTable('todos')).toHaveLength(3)
    expect(realtime.forTable('todos')[1]!.removed).toBe(true)
  })

  test('SUBSCRIBED clears a pending retry timer so it cannot reopen a healthy channel', () => {
    const { realtime, clock } = setup()

    realtime.latest('todos').report('CHANNEL_ERROR')
    expect(clock.armedCount()).toBe(1)

    realtime.latest('todos').report('SUBSCRIBED')
    expect(clock.armedCount()).toBe(0)

    clock.advance(RECONNECT_MAX_MS * 4)
    expect(realtime.forTable('todos')).toHaveLength(1)
  })

  test('a non-terminal status is not treated as a drop', () => {
    const { realtime, clock } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    clock.advance(RECONNECT_MAX_MS * 4)
    expect(realtime.forTable('todos')).toHaveLength(1)
    expect(clock.armedCount()).toBe(0)
  })

  test('a re-opened channel rings again: the recovery is real, not just a join', () => {
    const { realtime, clock, signals } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').report('CLOSED')
    clock.advance(RECONNECT_BASE_MS)
    realtime.latest('todos').report('SUBSCRIBED')

    realtime.latest('todos').ring()
    expect(signals).toHaveLength(1)
  })

  test('consecutive drops back off exponentially and stop at the ceiling', () => {
    const { realtime, clock } = setup()
    const delays: number[] = []

    // Nine consecutive failures: 1s, 2s, 4s … the 6th would be 32s and must be clamped, so the tail pins the ceiling rather than the doubling.
    for (let index = 0; index < 9; index += 1) {
      const before = realtime.forTable('todos').length

      realtime.latest('todos').report('CHANNEL_ERROR')
      // Step the clock until the retry fires: the delay we observe is the delay the adapter chose. Bounded past the ceiling so a doorbell that never reconnects FAILS this test instead of hanging it.
      let waited = 0

      while (realtime.forTable('todos').length === before && waited <= RECONNECT_MAX_MS * 2) {
        clock.advance(500)
        waited += 500
      }
      delays.push(waited)
    }
    expect(delays.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(delays.slice(5)).toEqual([RECONNECT_MAX_MS, RECONNECT_MAX_MS, RECONNECT_MAX_MS, RECONNECT_MAX_MS])
  })

  test('a successful join resets the backoff, so the next drop retries fast again', () => {
    const { realtime, clock } = setup()

    for (let index = 0; index < 4; index += 1) {
      realtime.latest('todos').report('CHANNEL_ERROR')
      clock.advance(RECONNECT_MAX_MS)
    }
    realtime.latest('todos').report('SUBSCRIBED')

    const before = realtime.forTable('todos').length

    realtime.latest('todos').report('CHANNEL_ERROR')
    clock.advance(RECONNECT_BASE_MS)
    expect(realtime.forTable('todos')).toHaveLength(before + 1)
  })

  test('a burst of drops on one channel collapses into a single pending retry', () => {
    const { realtime, clock } = setup()
    const before = realtime.forTable('todos').length

    realtime.latest('todos').report('CHANNEL_ERROR')
    realtime.latest('todos').report('CHANNEL_ERROR')
    realtime.latest('todos').report('CHANNEL_ERROR')
    expect(clock.armedCount()).toBe(1)
    clock.advance(RECONNECT_BASE_MS)
    expect(realtime.forTable('todos')).toHaveLength(before + 1)
  })

  test('tables reconnect independently: one dead channel does not disturb the others', () => {
    const { realtime, clock } = setup(['todos', 'lists'])

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('lists').report('SUBSCRIBED')
    realtime.latest('todos').report('CHANNEL_ERROR')
    clock.advance(RECONNECT_BASE_MS)

    expect(realtime.forTable('todos')).toHaveLength(2)
    expect(realtime.forTable('lists')).toHaveLength(1)
    expect(realtime.forTable('lists')[0]!.removed).toBe(false)
  })

  test('every transition is reported through the injected logger', () => {
    const { realtime, clock, records } = setup()

    realtime.latest('todos').report('CHANNEL_ERROR', new Error('socket closed'))
    clock.advance(RECONNECT_BASE_MS)
    realtime.latest('todos').report('SUBSCRIBED')

    const messages = records.map((entry) => entry.message)

    expect(messages).toEqual(['doorbell.dropped', 'doorbell.reconnecting', 'doorbell.recovered'])
    expect(records[1]!.meta).toMatchObject({ table: 'todos', attempt: 1, delayMs: RECONNECT_BASE_MS })
  })

  test('a healthy channel logs nothing: diagnostics report transitions, not heartbeats', () => {
    const { realtime, records } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').ring()
    expect(records).toEqual([])
  })

  test('unsubscribing cancels a retry in flight and opens nothing afterwards', () => {
    const { realtime, clock, unsubscribe } = setup()

    realtime.latest('todos').report('CHANNEL_ERROR')
    expect(clock.armedCount()).toBe(1)

    unsubscribe()
    expect(clock.armedCount()).toBe(0)
    clock.advance(RECONNECT_MAX_MS * 4)
    expect(realtime.forTable('todos')).toHaveLength(1)
    expect(realtime.forTable('todos')[0]!.removed).toBe(true)
  })

  test('a status arriving after unsubscribe is ignored', () => {
    const { realtime, clock, unsubscribe, signals } = setup()

    unsubscribe()
    // supabase-js can deliver a final CLOSED as the socket tears down; that must not resurrect a doorbell the caller has already shut.
    realtime.latest('todos').report('CLOSED')
    clock.advance(RECONNECT_MAX_MS * 4)
    expect(realtime.forTable('todos')).toHaveLength(1)
    expect(clock.armedCount()).toBe(0)
    expect(signals).toEqual([])
  })

  test.each(['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION'])(
    'a dead channel re-opens on %s with a session, before its backoff fires',
    (event) => {
      const { realtime, clock, records } = setup()

      realtime.latest('todos').report('CHANNEL_ERROR')
      realtime.emitAuth(event, {})
      // Deferred: the auth callback itself must not touch the client.
      expect(realtime.forTable('todos')).toHaveLength(1)

      clock.advance(0)
      expect(realtime.forTable('todos')).toHaveLength(2)
      expect(realtime.forTable('todos')[0]!.removed).toBe(true)
      expect(clock.armedCount()).toBe(0)
      expect(records.some((entry) => entry.message === 'doorbell.reopening')).toBe(true)
      expect(records.find((entry) => entry.message === 'doorbell.reopening')!.meta).toEqual({
        table: 'todos',
        reason: 'session',
      })
    },
  )

  test('SIGNED_OUT or a null session re-opens nothing', () => {
    const { realtime, clock } = setup()

    realtime.latest('todos').report('CHANNEL_ERROR')
    realtime.emitAuth('SIGNED_OUT', null)
    realtime.emitAuth('SIGNED_IN', null)
    realtime.emitAuth('SIGNED_OUT', {})
    clock.advance(0)
    expect(realtime.forTable('todos')).toHaveLength(1)
    expect(clock.armedCount()).toBe(1)
  })

  test('a healthy channel is not re-opened by a session', () => {
    const { realtime, clock } = setup()

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.emitAuth('TOKEN_REFRESHED', {})
    clock.advance(0)
    expect(realtime.forTable('todos')).toHaveLength(1)
    expect(realtime.forTable('todos')[0]!.removed).toBe(false)
  })

  test('unsubscribing drops the auth listener and a deferred re-open opens nothing', () => {
    const { realtime, clock, unsubscribe } = setup()

    realtime.latest('todos').report('CHANNEL_ERROR')
    realtime.emitAuth('SIGNED_IN', {})
    unsubscribe()
    expect(realtime.authUnsubscribed()).toBe(true)

    clock.advance(0)
    expect(realtime.forTable('todos')).toHaveLength(1)
  })

  test('soak: 500 drops in a row never exhaust the retries or leak a live channel', () => {
    const { realtime, clock } = setup()

    for (let index = 0; index < 500; index += 1) {
      realtime.latest('todos').report('CHANNEL_ERROR')
      clock.advance(RECONNECT_MAX_MS)
    }
    // Still trying after 500 consecutive failures, and each attempt left exactly one live channel behind.
    expect(realtime.forTable('todos')).toHaveLength(501)
    const live = realtime.forTable('todos').filter((channel) => !channel.removed)

    expect(live).toHaveLength(1)

    realtime.latest('todos').report('SUBSCRIBED')
    realtime.latest('todos').ring()
    expect(clock.armedCount()).toBe(0)
  })
})
