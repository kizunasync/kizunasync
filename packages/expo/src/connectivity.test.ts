/// <reference types="bun" />
/**
 * @kizunasync/expo connectivity: the NetInfo subscription lifecycle.
 *
 * @react-native-community/netinfo is mocked so we can count the internal
 * addEventListener/unsubscribe: the adapter must subscribe LAZILY (only with a
 * caller listener attached) and unsubscribe when the last one detaches, so it
 * cannot leak a permanent process-wide subscription per instance.
 */

import { describe, expect, mock, test } from 'bun:test'

let addCalls = 0
let unsubCalls = 0
let lastCb: ((state: unknown) => void) | null = null

mock.module('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: (cb: (state: unknown) => void) => {
      addCalls += 1
      lastCb = cb

      return () => {
        unsubCalls += 1
      }
    },
    fetch: async () => ({ isInternetReachable: true, isConnected: true }),
  },
}))

const { createExpoConnectivity } = await import('./connectivity')

describe('createExpoConnectivity NetInfo lifecycle', () => {
  test('subscribes lazily and unsubscribes when the last listener detaches', () => {
    addCalls = 0
    unsubCalls = 0
    const c = createExpoConnectivity()

    expect(addCalls).toBe(0) // no NetInfo subscription until a caller subscribes

    const un1 = c.subscribe(() => {})

    expect(addCalls).toBe(1) // lazy: one internal subscription on first listener
    const un2 = c.subscribe(() => {})

    expect(addCalls).toBe(1) // still exactly one internal subscription

    un1()
    expect(unsubCalls).toBe(0) // one listener remains, so the subscription stays
    un2()
    expect(unsubCalls).toBe(1) // last listener gone → NetInfo unsubscribed (no leak)
  })

  test('isOnline reflects NetInfo transitions fanned to caller listeners', () => {
    addCalls = 0
    const c = createExpoConnectivity()
    const seen: boolean[] = []

    c.subscribe((online) => {
      seen.push(online)
    })
    lastCb?.({ isInternetReachable: false, isConnected: false })
    expect(c.isOnline()).toBe(false)
    expect(seen.at(-1)).toBe(false)
    lastCb?.({ isInternetReachable: true, isConnected: true })
    expect(c.isOnline()).toBe(true)
    expect(seen.at(-1)).toBe(true)
  })
})

describe('createExpoConnectivity connectivity gate', () => {
  test("default gate ('connected'): isConnected true keeps online even when isInternetReachable is false", () => {
    const c = createExpoConnectivity()
    const seen: boolean[] = []

    c.subscribe((online) => {
      seen.push(online)
    })
    lastCb?.({ isInternetReachable: false, isConnected: true })
    expect(c.isOnline()).toBe(true)
    expect(seen.includes(false)).toBe(false)
  })

  test("default gate ('connected'): isConnected false goes offline even when isInternetReachable is true", () => {
    const c = createExpoConnectivity()
    const seen: boolean[] = []

    c.subscribe((online) => {
      seen.push(online)
    })
    lastCb?.({ isInternetReachable: true, isConnected: false })
    expect(c.isOnline()).toBe(false)
    expect(seen.at(-1)).toBe(false)
  })

  test("default gate ('connected'): an unknown isConnected reading is optimistic (online)", () => {
    const c = createExpoConnectivity()

    c.subscribe(() => {})
    lastCb?.({ isConnected: null, isInternetReachable: null })
    expect(c.isOnline()).toBe(true)
  })

  test("gate: 'internet-reachable' goes offline when isInternetReachable is false, even with isConnected true", () => {
    const c = createExpoConnectivity({ gate: 'internet-reachable' })
    const seen: boolean[] = []

    c.subscribe((online) => {
      seen.push(online)
    })
    lastCb?.({ isInternetReachable: false, isConnected: true })
    expect(c.isOnline()).toBe(false)
    expect(seen.at(-1)).toBe(false)
  })

  test("gate: 'internet-reachable' falls back to isConnected true when isInternetReachable is unknown", () => {
    const c = createExpoConnectivity({ gate: 'internet-reachable' })

    c.subscribe(() => {})
    lastCb?.({ isInternetReachable: null, isConnected: true })
    expect(c.isOnline()).toBe(true)
  })

  test("gate: 'internet-reachable' falls back to isConnected false when isInternetReachable is unknown", () => {
    const c = createExpoConnectivity({ gate: 'internet-reachable' })
    const seen: boolean[] = []

    c.subscribe((online) => {
      seen.push(online)
    })
    lastCb?.({ isInternetReachable: null, isConnected: false })
    expect(c.isOnline()).toBe(false)
    expect(seen.at(-1)).toBe(false)
  })
})
