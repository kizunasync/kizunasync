/**
 * Vue adapter over `createSyncStatusSession`. The snapshot reads, the verdict
 * mapping, and the syncNow ordering live in `@kizunasync/core`; this file spreads
 * the session's state callback into refs and adds the one signal the session
 * does not carry, connectivity. `isOnline` follows the app client's own
 * `connectivity`, the port its sync loop follows, unless the caller passes one.
 * onScopeDispose unsubscribes both.
 *
 * `needsReset` is read from `checkpoint.softBlocked`, which only RESET_REQUIRED
 * latches: a CHECKPOINT_EXPIRED rehydrates on its own. It is deliberately not
 * derived from `lastError`, which also carries verdicts a reset would not fix.
 *
 * `isSyncing` tracks syncNow only, so a button's spinner does not flicker with
 * every background poll.
 */
// MARK: - useSyncStatus

import { type ComputedRef, type Ref, computed, onScopeDispose, ref } from 'vue'
import { createSyncStatusSession, ESyncPhase, type IConnectivity, type ISyncHealth, type ISyncStatusState, type TCheckpointState, type TSoftBlockReason } from '@kizunasync/core'
import { type IUseKizunaSyncOptions, useKizunaSync } from './provide'

export interface IUseSyncStatusOptions extends IUseKizunaSyncOptions {
  /** Replaces the app client's `connectivity` for `isOnline` only; the sync loop keeps following its own. */
  connectivity?: IConnectivity
}

export interface IUseSyncStatusResult {
  outboxDepth: Ref<number>
  isSyncing: Ref<boolean>
  lastError: Ref<Error | null>
  checkpoint: Ref<TCheckpointState>
  isOnline: Ref<boolean>

  /** What the automatic sync loop is doing right now. */
  health: Ref<ISyncHealth>

  /** The current attempt has not settled for two poll ticks. */
  isStalled: ComputedRef<boolean>

  /** Epoch ms of the next armed automatic attempt, or null when none is armed. */
  nextRetryAt: ComputedRef<number | null>

  /**
   * The server refused this client and sync is blocked until `reset()` runs.
   * Read from `checkpoint.softBlocked`, which only RESET_REQUIRED latches: a
   * CHECKPOINT_EXPIRED rehydrates on its own and needs no reset. A UI that shows
   * a reset action shows it on this, never on `lastError`, which also carries
   * verdicts a reset would not fix.
   */
  needsReset: ComputedRef<boolean>

  /**
   * Why sync is blocked, read from `health.softBlockReason`: `reset_required`
   * when the server's schema gate refused this client, `identity_changed` when
   * a token of another user than the one the local store belongs to reached
   * the engine. Null while sync is not soft-blocked.
   */
  softBlockReason: ComputedRef<TSoftBlockReason | null>

  syncNow: () => Promise<void>
}

export const useSyncStatus = (opts?: IUseSyncStatusOptions): IUseSyncStatusResult => {
  const client = useKizunaSync(opts)
  const connectivity = opts?.connectivity ?? client.connectivity

  // A function declaration (hoisted) so the session can be built before the refs it writes into, and the refs can be seeded from its own state. The session never calls back synchronously: every `onChange` rides a promise continuation or an engine event, both strictly after this body returns.
  function apply(state: ISyncStatusState): void {
    outboxDepth.value = state.outboxDepth
    isSyncing.value = state.isSyncing
    lastError.value = state.lastError
    checkpoint.value = state.checkpoint
    health.value = state.health
  }

  const session = createSyncStatusSession({ client, onChange: apply })
  const seed = session.getState()
  const outboxDepth = ref(seed.outboxDepth)
  const isSyncing = ref(seed.isSyncing)
  const lastError = ref<Error | null>(seed.lastError)
  const checkpoint = ref<TCheckpointState>(seed.checkpoint) as Ref<TCheckpointState>
  const health = ref<ISyncHealth>(seed.health) as Ref<ISyncHealth>
  const isOnline = ref(connectivity.isOnline())
  const isStalled = computed(() => health.value.phase === ESyncPhase.stalled)
  const nextRetryAt = computed(() => health.value.nextAttemptAt)
  const needsReset = computed(() => checkpoint.value.softBlocked)
  const softBlockReason = computed(() => health.value.softBlockReason ?? null)

  const stopConnectivity = connectivity.subscribe((online) => {
    isOnline.value = online
  })

  onScopeDispose(() => {
    session.dispose()
    stopConnectivity()
  })

  return {
    outboxDepth,
    isSyncing,
    lastError,
    checkpoint,
    isOnline,
    health,
    isStalled,
    nextRetryAt,
    needsReset,
    softBlockReason,
    syncNow: session.syncNow,
  }
}
