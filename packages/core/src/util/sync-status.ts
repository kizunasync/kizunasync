/**
 * The sync-status observation protocol, owned once here so the React hook and
 * the Vue composable are adapters over it.
 *
 * getOutboxDepth / getCheckpoint are async (the driver may run off the main
 * thread), so a queue or sync event (`isQueueOrSyncEvent`) re-reads the pair
 * and a monotonic sequence token discards a stale resolution. Until the first
 * read resolves the state holds its defaults: outbox depth 0 and a
 * placeholder checkpoint. COLUMN_OVERWRITTEN is the one event excluded: it
 * rides the same commit as a LOCAL_CHANGED that already triggered a refresh,
 * and can fire once per conflicting column, so refreshing on it too would
 * re-query storm a multi-column conflict.
 *
 * `lastError` is the action-and-verdict channel: a verdict whose level is
 * `error` (MUTATION_REJECTED, BATCH_ABORTED, DEAD_LETTER, CHECKPOINT_EXPIRED,
 * RESET_REQUIRED, per verdictToMessage), a failed read, or a failed syncNow.
 * The automatic loop's own failures stay in `health.lastError`: they are
 * diagnostics, not something to raise at the user as an action error.
 *
 * `health` is the automatic sync loop's phase, failure streak, and next
 * attempt. `isSyncing` tracks syncNow only, so a button's spinner does not
 * flicker with every background poll.
 *
 * Connectivity is deliberately absent: it is a separate port the bindings own,
 * not something the client publishes.
 */
// MARK: - Sync-status session

import { EVerdictLevel, verdictToMessage } from './verdict-message'
import { EEngineEventType, INITIAL_CHECKPOINT_STATE, type TCheckpointState, type TEngineEvent } from '../wire/types'
import type { ISyncHealth } from '../host/sync-health'
import type { IKizunaSync } from '../query/kizunasync'

/**
 * The events that can change outbox depth or the checkpoint: every event but
 * COLUMN_OVERWRITTEN. QUEUE_DEPTH follows a local write joining the outbox;
 * the rest (LOCAL_CHANGED, the verdict events, RESET_REQUIRED,
 * CHECKPOINT_EXPIRED) follow a push or pull settling, which is the only
 * signal for a push that applies cleanly (no verdict event of its own) or a
 * pull that commits with no conflict.
 */
function isQueueOrSyncEvent(event: TEngineEvent): boolean {
  return event.type !== EEngineEventType.COLUMN_OVERWRITTEN
}

export interface ISyncStatusState {
  outboxDepth: number
  checkpoint: TCheckpointState

  /** An in-flight `syncNow`, never a background poll. */
  isSyncing: boolean

  lastError: Error | null
  health: ISyncHealth
}

export interface ISyncStatusSessionOptions {
  client: Pick<IKizunaSync, 'on' | 'sync' | 'getSyncHealth' | 'onSyncHealth' | 'getOutboxDepth' | 'getCheckpoint'>
  onChange: (state: ISyncStatusState) => void
}

export interface ISyncStatusSession {
  /**
   * The state as of now, for a reader seeding its own storage before the first
   * `onChange` arrives. Until the first read resolves this is the defaults
   * plus the health the client reported at construction.
   */
  getState(): ISyncStatusState

  /**
   * Clear the prior error, sync, then re-read the snapshot so it is current
   * when the promise settles. The error is cleared BEFORE the sync so a verdict
   * emitted DURING it is preserved, not wiped. A thrown sync lands in
   * `lastError` rather than rejecting: the state is the reporting surface.
   */
  syncNow(): Promise<void>

  /** Unsubscribe and invalidate any in-flight read. */
  dispose(): void
}

/** The single owner of what a status reader shows before anything has resolved. */
export const initialSyncStatusState = (health: ISyncHealth): ISyncStatusState => ({
  outboxDepth: 0,
  checkpoint: INITIAL_CHECKPOINT_STATE,
  isSyncing: false,
  lastError: null,
  health,
})

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export const createSyncStatusSession = (options: ISyncStatusSessionOptions): ISyncStatusSession => {
  const { client, onChange } = options

  let state = initialSyncStatusState(client.getSyncHealth())
  let seq = 0

  const emit = (next: Partial<ISyncStatusState>): void => {
    state = { ...state, ...next }
    onChange(state)
  }

  const refresh = (): Promise<void> => {
    const token = (seq += 1)

    return Promise.all([client.getOutboxDepth(), client.getCheckpoint()])
      .then(([outboxDepth, checkpoint]) => {
        if (token !== seq) {
          return
        }
        emit({ outboxDepth, checkpoint })
      })
      .catch((cause: unknown) => {
        if (token !== seq) {
          return
        }
        emit({ lastError: toError(cause) })
      })
  }

  void refresh()
  const unsubscribeEvents = client.on((event) => {
    if (isQueueOrSyncEvent(event)) {
      void refresh()
    }
    const verdict = verdictToMessage(event)

    if (verdict !== null && verdict.level === EVerdictLevel.error) {
      emit({ lastError: new Error(`${verdict.title}: ${verdict.message}`) })
    }
  })
  const unsubscribeHealth = client.onSyncHealth((health) => {
    emit({ health })
  })

  const syncNow = async (): Promise<void> => {
    emit({ isSyncing: true, lastError: null })

    try {
      await client.sync()
    } catch (cause) {
      emit({ lastError: toError(cause) })
    } finally {
      emit({ isSyncing: false })
    }
    await refresh()
  }

  const dispose = (): void => {
    unsubscribeEvents()
    unsubscribeHealth()
    seq += 1
  }

  return { getState: () => state, syncNow, dispose }
}
