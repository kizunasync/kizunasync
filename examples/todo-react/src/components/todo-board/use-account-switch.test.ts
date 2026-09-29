/// <reference types="bun" />
/**
 * Boot-time recovery and an account switch can overlap: the visitor taps an
 * account pill while the persisted session is still being recovered. Once the
 * switch has signed in as its target, the recovery's late answers are stale
 * and must not clear the first-load gate the switch owns. This workspace has no
 * DOM renderer, so a one-render stand-in for React runs the hook as a plain
 * function, and the app's account adapter is scripted: the liveness predicate
 * the hook hands the recovery is what is under test.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { TAccountSwitchDecision } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../../kizunasync'
import type { IPerformAccountSwitchParams, IRecoverSessionParams } from '../../lib/account'

// MARK: - A one-render React stand-in

const cells: unknown[] = []
const cleanups: Array<() => void> = []
let nextCell = 0

mock.module('react', () => ({
  useState: (initial: unknown) => {
    const index = nextCell

    nextCell += 1
    cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial

    return [
      cells[index],
      (next: unknown) => {
        cells[index] = next
      },
    ]
  },
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect()

    if (cleanup !== undefined) {
      cleanups.push(cleanup)
    }
  },
  useRef: (initial: unknown) => ({ current: initial }),
}))

// MARK: - The scripted account adapter

const recoveries: IRecoverSessionParams[] = []
let settleRecovery: () => void = () => undefined
let switchStopsOnOutbox = false

mock.module('../../lib/account', () => ({
  recoverSession: (params: IRecoverSessionParams): Promise<void> => {
    recoveries.push(params)

    return new Promise<void>((resolve) => {
      settleRecovery = resolve
    })
  },
  performAccountSwitch: (params: IPerformAccountSwitchParams): Promise<TAccountSwitchDecision> => {
    if (switchStopsOnOutbox) {
      params.onFirstLoadPending(false)

      return Promise.resolve({ kind: 'outbox', depth: 2 })
    }
    params.onUserId('mary-uid')
    params.onFirstLoadPending(true)
    params.onAccount(params.key)
    params.onFirstLoadPending(false)

    return Promise.resolve({ kind: 'ok' })
  },
}))

const { useAccountSwitch } = await import('./use-account-switch')

const mountHook = (firstLoad: boolean[]) => {
  const hook = useAccountSwitch({
    client: {} as IKizunaSyncShim,
    syncNow: () => Promise.resolve(),
    isOnline: true,
    outboxDepth: 0,
    onMessage: () => undefined,
    onFirstLoadPending: (pending) => {
      firstLoad.push(pending)
    },
  })
  const recovery = recoveries[0]

  if (recovery === undefined) {
    throw new Error('the hook started no recovery')
  }
  return { hook, recovery, unmount: () => cleanups.forEach((cleanup) => cleanup()) }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  cells.length = 0
  cleanups.length = 0
  recoveries.length = 0
  nextCell = 0
  switchStopsOnOutbox = false
})

describe('the boot recovery against an account switch', () => {
  test('the recovery stays live while nothing supersedes it', async () => {
    const firstLoad: boolean[] = []
    const { recovery } = mountHook(firstLoad)

    expect(recovery.isLive()).toBe(true)
    settleRecovery()
    await flush()
    expect(firstLoad).toEqual([false])
  })

  test('a switch that signed in as its target supersedes the recovery', async () => {
    const firstLoad: boolean[] = []
    const { hook, recovery } = mountHook(firstLoad)

    await hook.performSwitch('mary')
    expect(recovery.isLive()).toBe(false)
    settleRecovery()
    await flush()
    expect(firstLoad).toEqual([true, false])
  })

  test('a switch the outbox stopped before any change leaves the recovery live', async () => {
    const firstLoad: boolean[] = []
    const { hook, recovery } = mountHook(firstLoad)

    switchStopsOnOutbox = true
    await hook.performSwitch('mary')
    expect(recovery.isLive()).toBe(true)
  })

  test('unmounting ends the recovery', () => {
    const { recovery, unmount } = mountHook([])

    unmount()
    expect(recovery.isLive()).toBe(false)
  })
})
