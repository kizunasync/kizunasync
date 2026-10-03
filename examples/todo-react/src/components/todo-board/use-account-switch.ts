/**
 * Account identity and the switch/recover flow: which demo account is active,
 * the signed-in user id, and the outbox guard that raises SwitchGuardModal
 * before a switch would drop unsynced writes. lib/account.ts adapts the
 * shared @kizunasync/utilities flow to this app's Supabase client and catalog.
 */

import { useEffect, useRef, useState } from 'react'
import { decideAccountSwitch, EAccountSwitchDecisionKind, type IAccountSwitchOptions } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../../kizunasync'
import { performAccountSwitch, recoverSession, type TAccountKey } from '../../lib/account'

export interface IUseAccountSwitchParams {
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  isOnline: boolean
  outboxDepth: number
  onMessage: (message: string) => void
  onFirstLoadPending: (pending: boolean) => void
}

export interface IUseAccountSwitchResult {
  account: TAccountKey
  myId: string | null
  pendingSwitch: TAccountKey | null
  performSwitch: (key: TAccountKey, options?: IAccountSwitchOptions) => Promise<void>
  requestSwitch: (key: TAccountKey) => void
  confirmSyncThenSwitch: () => Promise<void>
  confirmSwitchAnyway: () => void
  cancelSwitch: () => void
}

/** What the boot recovery reports into: the board's callbacks and the hook's identity setters. */
interface IBootRecoveryParams {
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  onMessage: (message: string) => void
  onFirstLoadPending: (pending: boolean) => void
  setMyId: (id: string | null) => void
  setAccount: (key: TAccountKey) => void
}

/**
 * Boot-time recovery, split out so useAccountSwitch's own body stays under the
 * shape target. A stale response (unmounted, or a switch that has since signed
 * in as its target) must not clobber later state, so onUserId/onAccount and
 * the finally both gate on `isLive()`. Answers the identity callback a switch
 * reports through: a switch supersedes the recovery once it has signed in,
 * while one the outbox stopped changed nothing, so the recovery's answer still
 * stands.
 */
function useBootRecovery(params: IBootRecoveryParams): (id: string | null) => void {
  const { client, syncNow, onMessage, onFirstLoadPending, setMyId, setAccount } = params
  const signedInSwitches = useRef(0)

  useEffect(() => {
    let live = true
    const switchesAtStart = signedInSwitches.current
    const isLive = (): boolean => live && signedInSwitches.current === switchesAtStart
    const recovery = recoverSession({ client, syncNow, isLive, onMessage, onUserId: setMyId, onAccount: setAccount })

    void recovery.finally(() => {
      if (isLive()) {
        onFirstLoadPending(false)
      }
    })

    return () => {
      live = false
    }
  }, [client, syncNow])

  return (id) => {
    signedInSwitches.current += 1
    setMyId(id)
  }
}

export function useAccountSwitch({
  client,
  syncNow,
  isOnline,
  outboxDepth,
  onMessage,
  onFirstLoadPending,
}: IUseAccountSwitchParams): IUseAccountSwitchResult {
  const [account, setAccount] = useState<TAccountKey>('anon')
  const [myId, setMyId] = useState<string | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<TAccountKey | null>(null)
  const onSwitchedUserId = useBootRecovery({ client, syncNow, onMessage, onFirstLoadPending, setMyId, setAccount })

  async function performSwitch(key: TAccountKey, options: IAccountSwitchOptions = {}): Promise<void> {
    const outcome = await performAccountSwitch({
      key,
      client,
      syncNow,
      discardQueuedWrites: options.discardQueuedWrites,
      onMessage,
      onUserId: onSwitchedUserId,
      onFirstLoadPending,
      onAccount: setAccount,
    })

    // Writes the switch found queued (written after the request, or still there after the sync before it) raise the guard again instead of being wiped.
    if (outcome.kind === EAccountSwitchDecisionKind.outbox) {
      setPendingSwitch(key)
    }
  }

  // reset() wipes local data, so an unsynced outbox is lost on switch. Offline is blocked outright (switching needs a sync first) BEFORE the outbox guard; then switch directly when the outbox is empty, otherwise raise the modal.
  function requestSwitch(key: TAccountKey): void {
    if (key === account) {
      return
    }
    const decision = decideAccountSwitch({ isOnline, outboxDepth })

    if (decision.kind === 'offline') {
      onMessage(decision.message)

      return
    }
    if (decision.kind === 'outbox') {
      setPendingSwitch(key)

      return
    }
    void performSwitch(key)
  }

  async function confirmSyncThenSwitch(): Promise<void> {
    const key = pendingSwitch

    if (key === null) {
      return
    }
    setPendingSwitch(null)
    await syncNow()
    await performSwitch(key)
  }

  function confirmSwitchAnyway(): void {
    const key = pendingSwitch

    if (key === null) {
      return
    }
    setPendingSwitch(null)
    void performSwitch(key, { discardQueuedWrites: true })
  }

  function cancelSwitch(): void {
    setPendingSwitch(null)
  }

  return {
    account,
    myId,
    pendingSwitch,
    performSwitch,
    requestSwitch,
    confirmSyncThenSwitch,
    confirmSwitchAnyway,
    cancelSwitch,
  }
}
