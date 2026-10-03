import { useCallback, useState, useSyncExternalStore } from 'react'
import { useKizunaSync, useSyncStatus, type ISyncStatusResult } from '@kizunasync/react'
import { messageOf } from '@kizunasync/utilities'
import { getBootNotice, getLastSyncAt, subscribeLastSync, supabase, sync } from '../kizunasync-shim'
import { t } from '../i18n'

/**
 * The connection strip's live state: the engine's sync status (its outbox depth
 * comes from useSyncStatus, which re-reads it after every queue or sync event),
 * the manual sync/reset actions, and the status line they report through
 * `message`. Both the SyncBar and the ResetBanner render off this one source
 * (@CONVENTIONS.md).
 */
export interface IPendingWrites {
  pendingWrites: number
  syncStatus: ISyncStatusResult
  note: string | null
  lastSyncAt: number | null
  syncing: boolean
  isResetting: boolean
  setMessage: (message: string) => void
  runSync: () => Promise<void>
  rebuildLocalDatabase: () => Promise<void>
}

export function usePendingWrites(): IPendingWrites {
  const client = useKizunaSync()
  const syncStatus = useSyncStatus()
  const [message, setMessage] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const lastSyncAt = useSyncExternalStore(subscribeLastSync, getLastSyncAt, getLastSyncAt)

  const pendingWrites = syncStatus.outboxDepth

  const runSync = useCallback(async () => {
    setSyncing(true)

    try {
      setMessage(t('sync.syncing'))
      await sync(supabase)
      setMessage(client.connectivity.isOnline() ? 'synced ✓' : t('sync.waitingForNetwork'))
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setSyncing(false)
    }
  }, [client])

  // The one recovery from a soft-blocked checkpoint: reset() drops the local database, then a sync rehydrates it from the server.
  const rebuildLocalDatabase = useCallback(async () => {
    setIsResetting(true)

    try {
      await client.reset()
      await runSync()
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setIsResetting(false)
    }
  }, [client, runSync])

  const note = message ?? syncStatus.lastError?.message ?? getBootNotice()

  return { pendingWrites, syncStatus, note, lastSyncAt, syncing, isResetting, setMessage, runSync, rebuildLocalDatabase }
}
