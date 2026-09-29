import { useCallback, useEffect, useRef, useState } from 'react'
import { decideAccountSwitch, EAccountSwitchDecisionKind, type IAccountSwitchOptions } from '@kizunasync/utilities'
import { ACCOUNTS, performAccountSwitch, recoverSession, type TAccountKey } from '../lib/account'
import type { IPendingSwitch } from '../components/switch-guard-modal'

/**
 * Account identity and the switch flow: who is signed in, the pill selection,
 * the first-load gate, and the outbox-aware switch guard. Account switch wipes
 * local data and re-pulls under the new identity, both impossible offline, so
 * `requestSwitch` gates on offline FIRST, then on the outbox (@CONVENTIONS.md).
 */
export interface IAccountSwitch {
  account: TAccountKey
  myId: string | null
  pendingSwitch: IPendingSwitch | null
  firstLoadPending: boolean
  requestSwitch: (key: TAccountKey) => void
  syncThenSwitch: () => Promise<void>
  switchAnyway: () => void
  cancelSwitch: () => void
}

export function useAccountSwitch({
  ready,
  offline,
  outboxDepth,
  runSync,
  onMessage,
}: {
  ready: boolean
  offline: boolean
  outboxDepth: number
  runSync: () => Promise<void>
  onMessage: (message: string) => void
}): IAccountSwitch {
  const [account, setAccount] = useState<TAccountKey>('anon')
  const [myId, setMyId] = useState<string | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<IPendingSwitch | null>(null)
  const [firstLoadPending, setFirstLoadPending] = useState(true)
  const onSwitchedIdentity = useBootRecovery({ ready, runSync, onMessage, setMyId, setAccount, setFirstLoadPending })

  const runAccountSwitch = useCallback(
    async (key: TAccountKey, options: IAccountSwitchOptions = {}): Promise<void> => {
      const outcome = await performAccountSwitch(
        { key, discardQueuedWrites: options.discardQueuedWrites },
        { onMessage, onIdentity: onSwitchedIdentity, onAccount: setAccount, onFirstLoadPending: setFirstLoadPending },
      )

      // Writes the switch found queued (written after the request, or still there after the sync before it) raise the guard again instead of being wiped.
      if (outcome.kind === EAccountSwitchDecisionKind.outbox) {
        setPendingSwitch({ key, label: ACCOUNTS.find((candidate) => candidate.key === key)?.label ?? key, depth: outcome.depth })
      }
    },
    [onMessage, onSwitchedIdentity],
  )

  // Account switch wipes local data (resetLocal) and re-pulls under the new identity, both impossible offline. So gate on offline FIRST, before the unsynced-changes modal: while offline we refuse outright and explain why (no wipe, no modal). Then the outbox gate: empty ⇒ switch immediately; otherwise open the warning modal so the user chooses to sync first, drop the changes, or cancel.
  const requestSwitch = useCallback(
    (key: TAccountKey) => {
      if (key === account) {
        return
      }
      const target = ACCOUNTS.find((candidate) => candidate.key === key)

      if (target === undefined) {
        return
      }
      const decision = decideAccountSwitch({ isOnline: !offline, outboxDepth })

      if (decision.kind === 'offline') {
        onMessage(decision.message)

        return
      }
      if (decision.kind === 'outbox') {
        setPendingSwitch({ key, label: target.label, depth: decision.depth })

        return
      }
      void runAccountSwitch(key)
    },
    [account, offline, outboxDepth, onMessage, runAccountSwitch],
  )

  // The three ways the switch-guard modal resolves: sync first then switch, switch and drop the outbox, or back out. Split out of the main body so it can be reasoned about with SwitchGuardModal alone (@CONVENTIONS.md).
  const { syncThenSwitch, switchAnyway, cancelSwitch } = useSwitchGuardResolution({
    pendingSwitch,
    setPendingSwitch,
    runSync,
    runAccountSwitch,
  })

  return { account, myId, pendingSwitch, firstLoadPending, requestSwitch, syncThenSwitch, switchAnyway, cancelSwitch }
}

// MARK: - internal

/**
 * Boot-time recovery, split out so useAccountSwitch's own body stays under the
 * shape target. A stale answer (unmounted, or a switch that has since signed in
 * as its target) lands neither its identity nor its first-load clear. Answers
 * the identity callback a switch reports through: a switch supersedes the
 * recovery once it has signed in, while one the outbox stopped changed
 * nothing, so the recovery's answer still stands.
 */
function useBootRecovery({
  ready,
  runSync,
  onMessage,
  setMyId,
  setAccount,
  setFirstLoadPending,
}: {
  ready: boolean
  runSync: () => Promise<void>
  onMessage: (message: string) => void
  setMyId: (userId: string | null) => void
  setAccount: (key: TAccountKey) => void
  setFirstLoadPending: (pending: boolean) => void
}): (userId: string | null) => void {
  const signedInSwitches = useRef(0)

  useEffect(() => {
    // Gated on `ready` from the root layout: the Provider mounts with the booting placeholder (web warms the worker), then re-mounts with the live client, only then is recovering the session and syncing worth anything.
    if (!ready) {
      return
    }
    let active = true
    const switchesAtStart = signedInSwitches.current
    const isActive = (): boolean => active && signedInSwitches.current === switchesAtStart

    void recoverSession({
      isActive,
      onMessage,
      onIdentity: setMyId,
      onAccount: setAccount,
      runSync,
    }).finally(() => {
      if (isActive()) {
        setFirstLoadPending(false)
      }
    })

    return () => {
      active = false
    }
  }, [ready, runSync, onMessage])

  return useCallback(
    (userId: string | null) => {
      signedInSwitches.current += 1
      setMyId(userId)
    },
    [setMyId],
  )
}

/** The switch-guard modal's three actions: `SwitchGuardModal`'s onSyncNow/onSwitchAnyway/onCancel. */
function useSwitchGuardResolution({
  pendingSwitch,
  setPendingSwitch,
  runSync,
  runAccountSwitch,
}: {
  pendingSwitch: IPendingSwitch | null
  setPendingSwitch: (value: IPendingSwitch | null) => void
  runSync: () => Promise<void>
  runAccountSwitch: (key: TAccountKey, options?: IAccountSwitchOptions) => Promise<void>
}): { syncThenSwitch: () => Promise<void>; switchAnyway: () => void; cancelSwitch: () => void } {
  const syncThenSwitch = useCallback(async () => {
    const next = pendingSwitch

    if (next === null) {
      return
    }
    setPendingSwitch(null)
    await runSync()
    await runAccountSwitch(next.key)
  }, [pendingSwitch, setPendingSwitch, runSync, runAccountSwitch])

  const switchAnyway = useCallback(() => {
    const next = pendingSwitch

    if (next === null) {
      return
    }
    setPendingSwitch(null)
    void runAccountSwitch(next.key, { discardQueuedWrites: true })
  }, [pendingSwitch, setPendingSwitch, runAccountSwitch])

  const cancelSwitch = useCallback(() => {
    setPendingSwitch(null)
  }, [setPendingSwitch])

  return { syncThenSwitch, switchAnyway, cancelSwitch }
}
