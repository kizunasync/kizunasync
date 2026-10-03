/// <reference types="bun" />
/** @kizunasync/expo foreground: the AppState subscription lifecycle. */

import { describe, expect, mock, test } from 'bun:test'

let addCalls = 0
let removeCalls = 0
/** Boxed so resetting between tests does not narrow the callback to `null`. */
const listener: { cb: ((state: string) => void) | null } = { cb: null }
let currentState: string | null | undefined = 'active'

mock.module('react-native', () => ({
  AppState: {
    get currentState() {
      return currentState
    },
    addEventListener: (_type: string, cb: (state: string) => void) => {
      addCalls += 1
      listener.cb = cb

      return {
        remove: () => {
          removeCalls += 1
        },
      }
    },
  },
}))

const { createExpoForeground } = await import('./foreground')

/** Deliver one AppState change to whatever the adapter registered. */
const emit = (state: string): void => {
  const cb = listener.cb

  if (cb === null) {
    throw new Error(`expected an AppState listener before "${state}"`)
  }
  cb(state)
}

describe('createExpoForeground AppState lifecycle', () => {
  test('subscribes and unsubscribes, firing only on return to active', () => {
    addCalls = 0
    removeCalls = 0
    currentState = 'active'
    listener.cb = null
    const seen: number[] = []
    const stop = createExpoForeground().subscribe(() => {
      seen.push(1)
    })

    expect(addCalls).toBe(1)
    emit('background')
    expect(seen).toEqual([])
    emit('active')
    expect(seen).toEqual([1])
    emit('active')
    expect(seen).toEqual([1])
    stop()
    expect(removeCalls).toBe(1)
  })

  test('an unseeded currentState still fires on the first return to active', () => {
    for (const seed of [null, undefined]) {
      currentState = seed
      listener.cb = null
      const seen: number[] = []
      const stop = createExpoForeground().subscribe(() => {
        seen.push(1)
      })

      emit('active')
      expect(seen).toEqual([1])
      stop()
    }
  })

  test('inactive to active is a return to the foreground', () => {
    currentState = 'inactive'
    listener.cb = null
    const seen: number[] = []
    const stop = createExpoForeground().subscribe(() => {
      seen.push(1)
    })

    emit('active')
    expect(seen).toEqual([1])
    emit('inactive')
    emit('active')
    expect(seen).toEqual([1, 1])
    stop()
  })
})
