/**
 * When an anonymous visitor's user is gone (a demo reaper deleted it, or its
 * session was lost), session recovery mints a new one while the local store
 * still belongs to the old one, and the engine soft-blocks with
 * `identity_changed` rather than push one user's rows as another. Every
 * example recovers the same way: wipe the store, then sync as the new user.
 * `reset_required` is left to the app: the server refused the client, which a
 * silent reset would hide.
 */

import { ESoftBlockReason, type IKizunaSync, type ISyncHealth } from 'kizunasync'

// MARK: - resetOnIdentityChange

/** What an app tells the user once `onRecovered` reports the rebuilt local database. */
export const IDENTITY_RECOVERED_MESSAGE = "This device's local data belonged to a previous session, so it was rebuilt for the current one."

export interface IResetOnIdentityChangeParams {
  client: Pick<IKizunaSync, 'getSyncHealth' | 'onSyncHealth' | 'getOutboxDepth'>

  /** The app's own local wipe, the one its reset control runs. */
  reset: () => Promise<void>

  sync: () => Promise<void>

  /**
   * Leave the block in place while the outbox holds writes, so the app's reset
   * control lets the user decide to drop them. Writes queued under the old
   * user cannot be pushed as the new one either way.
   */
  keepQueuedWrites: boolean

  onRecovered: () => void

  /** Receives a failed outbox read, reset, or sync; nothing is thrown. */
  onFailed: (cause: unknown) => void
}

/**
 * Watch `client`'s sync health and recover from each `identity_changed` latch,
 * one recovery at a time, including a latch already in place when the watch
 * starts. Returns the unsubscribe.
 */
export function resetOnIdentityChange(params: IResetOnIdentityChangeParams): () => void {
  const { client, reset, sync, keepQueuedWrites, onRecovered, onFailed } = params
  let isRecovering = false

  const recover = async (): Promise<void> => {
    isRecovering = true

    try {
      if (keepQueuedWrites && (await client.getOutboxDepth()) > 0) {
        return
      }
      await reset()
      await sync()
      onRecovered()
    } catch (cause) {
      onFailed(cause)
    } finally {
      isRecovering = false
    }
  }

  const onHealth = (health: ISyncHealth): void => {
    if (isRecovering || health.softBlockReason !== ESoftBlockReason.identityChanged) {
      return
    }
    void recover()
  }
  const unsubscribe = client.onSyncHealth(onHealth)

  onHealth(client.getSyncHealth())

  return unsubscribe
}
