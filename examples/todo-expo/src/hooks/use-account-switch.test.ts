/// <reference types="bun" />
/**
 * Boot-time recovery and an account switch can overlap: the visitor taps an
 * account pill while the persisted session is still being recovered. Once the
 * switch has signed in as its target, the recovery's late answers are stale
 * and must not clear the first-load gate the switch holds. The account adapter
 * reaches the native shim, which cannot load under Bun, so it is scripted, and
 * a one-render stand-in for React runs the hook as a plain function.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createDemoAccounts, type TAccountSwitchDecision } from '@kizunasync/utilities'

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
  useCallback: (callback: unknown) => callback,
}))

/** The hook's `firstLoadPending` state: its fourth `useState` cell. */
const FIRST_LOAD_CELL = 3

// MARK: - The scripted account adapter

interface IRecoveryPorts {
  isActive: () => boolean
}

interface ISwitchPorts {
  onIdentity: (userId: string | null) => void
  onFirstLoadPending: (pending: boolean) => void
}

const recoveries: IRecoveryPorts[] = []
let settleRecovery: () => void = () => undefined
let finishSwitch: () => void = () => undefined
let switchStopsOnOutbox = false

mock.module('../lib/account', () => ({
  ACCOUNTS: createDemoAccounts('Anonymous'),
  recoverSession: (ports: IRecoveryPorts): Promise<void> => {
    recoveries.push(ports)

    return new Promise<void>((resolve) => {
      settleRecovery = resolve
    })
  },
  performAccountSwitch: (_request: unknown, ports: ISwitchPorts): Promise<TAccountSwitchDecision> => {
    if (switchStopsOnOutbox) {
      ports.onFirstLoadPending(false)

      return Promise.resolve({ kind: 'outbox', depth: 2 })
    }
    ports.onIdentity('mary-uid')
    ports.onFirstLoadPending(true)

    return new Promise((resolve) => {
      finishSwitch = () => {
        ports.onFirstLoadPending(false)
        resolve({ kind: 'ok' })
      }
    })
  },
}))

const { useAccountSwitch } = await import('./use-account-switch')

const mountHook = () => {
  const hook = useAccountSwitch({
    ready: true,
    offline: false,
    outboxDepth: 0,
    runSync: () => Promise.resolve(),
    onMessage: () => undefined,
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
  test('the recovery stays live while nothing supersedes it and clears the first-load gate', async () => {
    const { recovery } = mountHook()

    expect(recovery.isActive()).toBe(true)
    settleRecovery()
    await flush()
    expect(cells[FIRST_LOAD_CELL]).toBe(false)
  })

  test('a switch that signed in as its target supersedes the recovery and keeps its first-load gate', async () => {
    const { hook, recovery } = mountHook()

    hook.requestSwitch('mary')
    await flush()
    expect(recovery.isActive()).toBe(false)
    settleRecovery()
    await flush()
    expect(cells[FIRST_LOAD_CELL]).toBe(true)
    finishSwitch()
    await flush()
    expect(cells[FIRST_LOAD_CELL]).toBe(false)
  })

  test('a switch the outbox stopped before any change leaves the recovery live', async () => {
    const { hook, recovery } = mountHook()

    switchStopsOnOutbox = true
    hook.requestSwitch('mary')
    await flush()
    expect(recovery.isActive()).toBe(true)
  })

  test('unmounting ends the recovery', () => {
    const { recovery, unmount } = mountHook()

    unmount()
    expect(recovery.isActive()).toBe(false)
  })
})
