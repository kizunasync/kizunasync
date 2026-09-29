/**
 * Account identity and the switch/recover flow: which demo account is active,
 * the signed-in user id, and the outbox guard that raises SwitchGuardModal
 * before a switch would drop unsynced writes. lib/account.ts adapts the
 * shared @kizunasync/utilities flow to this app's Supabase client and catalog.
 */

import { computed, onScopeDispose, ref, type Ref } from 'vue'
import { accountKeyForUserId, createDemoAccounts, decideAccountSwitch, DEMO_PASSWORD, EAccountSwitchDecisionKind, type IAccountSwitchOptions, type IDemoAccount, type TDemoAccountKey } from '@kizunasync/utilities'
import { t } from '../i18n'
import type { IKizunaSyncShim } from '../kizunasync'
import { performAccountSwitch, recoverSession } from '../lib/account'

// MARK: - Demo accounts

export type TAccountKey = TDemoAccountKey
export type IAccount = IDemoAccount

export const ACCOUNTS: IAccount[] = createDemoAccounts(t('account.anonymous'))

/** What every switch signs in against: the demo catalog, its password, and the uid to account mapping. */
const SWITCH_CATALOG = { accounts: ACCOUNTS, password: DEMO_PASSWORD, resolveAccountKey: accountKeyForUserId }

interface IAccountCallbacks {
  onMessage: (message: string) => void
  onUserId: (id: string | null) => void
  onAccount: (key: TAccountKey) => void
  onFirstLoadPending: (pending: boolean) => void
}

/**
 * Boot-time recovery, split out so useAccountSwitch's own body stays under the
 * shape target. A stale answer (the scope stopped, or a switch that has since
 * signed in as its target) must not clobber later state, so every callback
 * the recovery reports through gates on `isLive()`. Answers the identity
 * callback a switch reports through: a switch supersedes the recovery once it
 * has signed in, while one the outbox stopped changed nothing, so the
 * recovery's answer still stands.
 */
function useBootRecovery(params: {
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  callbacks: IAccountCallbacks
}): (id: string | null) => void {
  const { client, syncNow, callbacks } = params
  let signedInSwitches = 0
  let isScopeLive = true
  const isLive = (): boolean => isScopeLive && signedInSwitches === 0
  const whileLive =
    <TValue>(apply: (value: TValue) => void) =>
    (value: TValue): void => {
      if (isLive()) {
        apply(value)
      }
    }

  void recoverSession({
    client,
    accounts: ACCOUNTS,
    syncNow,
    resolveAccountKey: accountKeyForUserId,
    onMessage: whileLive(callbacks.onMessage),
    onUserId: whileLive(callbacks.onUserId),
    onAccount: whileLive(callbacks.onAccount),
    onFirstLoadPending: whileLive(callbacks.onFirstLoadPending),
  })
  onScopeDispose(() => {
    isScopeLive = false
  })

  return (id) => {
    signedInSwitches += 1
    callbacks.onUserId(id)
  }
}

/** A ref's `.value` setter, shaped as the plain callback performAccountSwitch/recoverSession expect. */
function refSetter<TValue>(target: Ref<TValue>): (value: TValue) => void {
  return (value) => {
    target.value = value
  }
}

/** Read and clear pendingSwitch in one step: both switch-guard resolutions consume the target before acting on it. */
function takePendingSwitch(pendingSwitch: Ref<TAccountKey | null>): TAccountKey | null {
  const key = pendingSwitch.value

  if (key !== null) {
    pendingSwitch.value = null
  }
  return key
}

export function useAccountSwitch({
  client,
  isOnline,
  outboxDepth,
  syncNow,
  onMessage,
  onFirstLoadPending,
}: {
  client: IKizunaSyncShim
  isOnline: Ref<boolean>
  outboxDepth: Ref<number>
  syncNow: () => Promise<void>
  onMessage: (message: string) => void
  onFirstLoadPending: (pending: boolean) => void
}) {
  const account = ref<TAccountKey>('anon')
  const myId = ref<string | null>(null)
  const pendingSwitch = ref<TAccountKey | null>(null)
  const pendingLabel = computed(() => ACCOUNTS.find((candidate) => candidate.key === pendingSwitch.value)?.label ?? '')

  const callbacks: IAccountCallbacks = { onMessage, onUserId: refSetter(myId), onAccount: refSetter(account), onFirstLoadPending }
  // A switch reports its new identity through the boot recovery, which that report makes stale.
  const switchCallbacks: IAccountCallbacks = { ...callbacks, onUserId: useBootRecovery({ client, syncNow, callbacks }) }

  async function performSwitch(key: TAccountKey, options: IAccountSwitchOptions = {}): Promise<void> {
    const request = { client, key, syncNow, ...SWITCH_CATALOG, ...options, ...switchCallbacks }
    const outcome = await performAccountSwitch(request)

    // Writes the switch found queued (written after the request, or still there after the sync before it) raise the guard again instead of being wiped.
    if (outcome.kind === EAccountSwitchDecisionKind.outbox) {
      pendingSwitch.value = key
    }
  }

  // reset() wipes local data, so an unsynced outbox is lost on switch. Offline is blocked outright (switching needs a sync first) BEFORE the outbox guard; then switch directly when the outbox is empty, otherwise raise the modal.
  function requestSwitch(key: TAccountKey): void {
    if (key === account.value) {
      return
    }
    const decision = decideAccountSwitch({ isOnline: isOnline.value, outboxDepth: outboxDepth.value })

    if (decision.kind === 'offline') {
      onMessage(decision.message)

      return
    }
    if (decision.kind === 'outbox') {
      pendingSwitch.value = key

      return
    }
    void performSwitch(key)
  }

  async function confirmSyncThenSwitch(): Promise<void> {
    const key = takePendingSwitch(pendingSwitch)

    if (key === null) {
      return
    }
    await syncNow()
    await performSwitch(key)
  }

  function confirmSwitchAnyway(): void {
    const key = takePendingSwitch(pendingSwitch)

    if (key === null) {
      return
    }
    void performSwitch(key, { discardQueuedWrites: true })
  }

  function cancelSwitch(): void {
    pendingSwitch.value = null
  }

  return {
    account,
    myId,
    pendingSwitch,
    pendingLabel,
    performSwitch,
    requestSwitch,
    confirmSyncThenSwitch,
    confirmSwitchAnyway,
    cancelSwitch,
  }
}
