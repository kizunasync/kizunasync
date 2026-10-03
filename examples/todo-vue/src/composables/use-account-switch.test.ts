/// <reference types="bun" />
/**
 * Boot-time recovery and an account switch can overlap: the visitor taps an
 * account pill while the persisted session is still being recovered. Once the
 * switch has signed in as its target, or once the composable's scope has
 * stopped, the recovery's late answers are stale and must not land. The
 * composable runs inside an effectScope and the app's account adapter is
 * scripted, so the callbacks the recovery was handed are what is under test.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { effectScope, ref } from 'vue'
import type { TAccountSwitchDecision } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../kizunasync'
import type { IPerformAccountSwitchParams, IRecoverSessionParams } from '../lib/account'
import type { TAccountKey } from './use-account-switch'

// MARK: - The scripted account adapter

const recoveries: Array<IRecoverSessionParams<TAccountKey>> = []
let switchStopsOnOutbox = false

mock.module('../lib/account', () => ({
  recoverSession: (params: IRecoverSessionParams<TAccountKey>): Promise<void> => {
    recoveries.push(params)

    return new Promise<void>(() => undefined)
  },
  performAccountSwitch: (params: IPerformAccountSwitchParams<TAccountKey>): Promise<TAccountSwitchDecision> => {
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

const mountComposable = () => {
  const firstLoad: boolean[] = []
  const scope = effectScope()
  const composable = scope.run(() =>
    useAccountSwitch({
      client: {} as IKizunaSyncShim,
      isOnline: ref(true),
      outboxDepth: ref(0),
      syncNow: () => Promise.resolve(),
      onMessage: () => undefined,
      onFirstLoadPending: (pending) => {
        firstLoad.push(pending)
      },
    }),
  )
  const recovery = recoveries[0]

  if (composable === undefined || recovery === undefined) {
    throw new Error('the composable started no recovery')
  }
  return { composable, recovery, firstLoad, scope }
}

/** What the adapter does once the recovered session is known: report it, then clear the first-load gate. */
const answerRecovery = (recovery: IRecoverSessionParams<TAccountKey>): void => {
  recovery.onUserId('recovered-uid')
  recovery.onAccount('david')
  recovery.onFirstLoadPending(false)
}

beforeEach(() => {
  recoveries.length = 0
  switchStopsOnOutbox = false
})

describe('the boot recovery against an account switch', () => {
  test('a live recovery reports its identity and clears the first-load gate', () => {
    const { composable, recovery, firstLoad, scope } = mountComposable()

    answerRecovery(recovery)
    expect(composable.myId.value).toBe('recovered-uid')
    expect(composable.account.value).toBe('david')
    expect(firstLoad).toEqual([false])
    scope.stop()
  })

  test('a switch that signed in as its target supersedes the recovery', async () => {
    const { composable, recovery, firstLoad, scope } = mountComposable()

    await composable.performSwitch('mary')
    answerRecovery(recovery)
    expect(composable.myId.value).toBe('mary-uid')
    expect(composable.account.value).toBe('mary')
    expect(firstLoad).toEqual([true, false])
    scope.stop()
  })

  test('a switch the outbox stopped before any change leaves the recovery live', async () => {
    const { composable, recovery, scope } = mountComposable()

    switchStopsOnOutbox = true
    await composable.performSwitch('mary')
    answerRecovery(recovery)
    expect(composable.myId.value).toBe('recovered-uid')
    scope.stop()
  })

  test('a stopped scope ignores the recovery', () => {
    const { composable, recovery, firstLoad, scope } = mountComposable()

    scope.stop()
    answerRecovery(recovery)
    expect(composable.myId.value).toBeNull()
    expect(firstLoad).toEqual([])
  })
})
