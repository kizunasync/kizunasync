import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { EEngineEventType } from '@kizunasync/core'
import { useKizunaSync, useSyncStatus, type ISyncStatusResult } from '@kizunasync/react'
import { messageOf } from '@kizunasync/utilities'
import { getBootNotice, getLastSyncAt, subscribeLastSync, supabase, sync } from '../kizunasync-shim'
import { t } from '../i18n'

/**
 * The connection strip's live state: the engine's sync status, the QUEUE_DEPTH
 * event (which supersedes the outbox read once it first arrives), the manual
 * sync/reset actions, and the status line they report through `message`. Both
 * the SyncBar and the ResetBanner render off this one source
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
  const [queueDepth, setQueueDepth] = useState<number | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const lastSyncAt = useSyncExternalStore(subscribeLastSync, getLastSyncAt, getLastSyncAt)

  // The engine's QUEUE_DEPTH signal takes over once it arrives; until then the outbox read stands in.
  const pendingWrites = queueDepth ?? syncStatus.outboxDepth

  const runSync = useCallback(async () => {
    setSyncing(true)

    try {
      setMessage(t('sync.syncing'))
      await sync(supabase)
      setMessage('synced ✓')
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setSyncing(false)
    }
  }, [])

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

  // The engine emits QUEUE_DEPTH after local writes.
  useEffect(() => {
    return client.on((event) => {
      if (event.type === EEngineEventType.QUEUE_DEPTH) {
        setQueueDepth(event.depth)
      }
    })
  }, [client])

  const note = message ?? syncStatus.lastError?.message ?? getBootNotice()

  return { pendingWrites, syncStatus, note, lastSyncAt, syncing, isResetting, setMessage, runSync, rebuildLocalDatabase }
}
