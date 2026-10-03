/**
 * React adapter over `createSyncStatusSession`. The snapshot reads, the verdict
 * mapping, and the syncNow ordering live in `@kizunasync/core`; this file turns the
 * session's state callback into component state and adds the one signal the
 * session does not carry, connectivity. `isOnline` follows the app client's own
 * `connectivity`, the port its sync loop follows, unless the caller passes one.
 *
 * `needsReset` is read from `checkpoint.softBlocked`, which only RESET_REQUIRED
 * latches: a CHECKPOINT_EXPIRED rehydrates on its own. It is deliberately not
 * derived from `lastError`, which also carries verdicts a reset would not fix.
 *
 * `isSyncing` tracks syncNow only, so a button's spinner does not flicker with
 * every background poll.
 */
// MARK: - useSyncStatus

import { useCallback, useEffect, useRef, useState } from 'react'
import { createSyncStatusSession, ESyncPhase, initialSyncStatusState, type IConnectivity, type ISyncHealth, type ISyncStatusSession, type ISyncStatusState, type TCheckpointState, type TSoftBlockReason } from '@kizunasync/core'
import { useKizunaSync, type IClientOption } from './provider'

export interface ISyncStatusOption extends IClientOption {
  /** Replaces the app client's `connectivity` for `isOnline` only; the sync loop keeps following its own. */
  connectivity?: IConnectivity
}

export interface ISyncStatusResult {
  outboxDepth: number
  isSyncing: boolean
  lastError: Error | null
  checkpoint: TCheckpointState
  isOnline: boolean

  /** The sync loop's phase, failure streak, attempt timestamps, and last error. */
  health: ISyncHealth

  /** The current attempt has not settled for two poll ticks. */
  isStalled: boolean

  /** Epoch ms of the next armed automatic attempt, or null when none is armed. */
  nextRetryAt: number | null

  /**
   * The server refused this client and sync is blocked until `reset()` runs.
   * Read from `checkpoint.softBlocked`, which only RESET_REQUIRED latches: a
   * CHECKPOINT_EXPIRED rehydrates on its own and needs no reset. A UI that shows
   * a reset action shows it on this, never on `lastError`, which also carries
   * verdicts a reset would not fix.
   */
  needsReset: boolean

  /**
   * Why sync is blocked, read from `health.softBlockReason`: `reset_required`
   * when the server's schema gate refused this client, `identity_changed` when
   * a token of another user than the one the local store belongs to reached
   * the engine. Null while sync is not soft-blocked.
   */
  softBlockReason: TSoftBlockReason | null

  syncNow: () => Promise<void>
}

export const useSyncStatus = (opts?: ISyncStatusOption): ISyncStatusResult => {
  const client = useKizunaSync(opts)
  const connectivity = opts?.connectivity ?? client.connectivity

  const [state, setState] = useState<ISyncStatusState>(() => initialSyncStatusState(client.getSyncHealth()))
  const [isOnline, setIsOnline] = useState<boolean>(() => connectivity.isOnline())

  const sessionRef = useRef<ISyncStatusSession | null>(null)

  useEffect(() => {
    const session = createSyncStatusSession({ client, onChange: setState })

    sessionRef.current = session

    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [client])

  useEffect(() => {
    setIsOnline(connectivity.isOnline())

    return connectivity.subscribe((online) => {
      setIsOnline(online)
    })
  }, [connectivity])

  const syncNow = useCallback(
    // Before the session mounts there is nothing to report the result into.
    (): Promise<void> => sessionRef.current?.syncNow() ?? client.sync(),
    [client],
  )

  return {
    outboxDepth: state.outboxDepth,
    isSyncing: state.isSyncing,
    lastError: state.lastError,
    checkpoint: state.checkpoint,
    isOnline,
    health: state.health,
    isStalled: state.health.phase === ESyncPhase.stalled,
    nextRetryAt: state.health.nextAttemptAt,
    needsReset: state.checkpoint.softBlocked,
    softBlockReason: state.health.softBlockReason ?? null,
    syncNow,
  }
}
