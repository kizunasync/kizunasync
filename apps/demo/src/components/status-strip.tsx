import { useSyncStatus } from '@kizunasync/react'
import { Button } from '@/components/button'
import { Tip } from '@/components/tip'
import type { IPaneClient } from '@/runtime/kizunasync'
import { formatClockTime } from '@kizunasync/utilities'

// MARK: - Status strip

/**
 * Online dot, queued-write count, last successful sync, and which core answers
 * the pane. The dot is sourced from the pane's own connectivity, so the
 * simulated-offline switch moves it. A dot that read the browser's real state
 * would lie about what the engine is doing.
 *
 * `needsReset` replaces the line outright when the server has refused this
 * pane. Showing "online, nothing queued" next to a client that cannot sync
 * would be a lie. Recovery is the pane's own "Wipe & rehydrate" control.
 */
export function StatusStrip({ client }: { client: IPaneClient }) {
  // MARK: - Variables
  const { outboxDepth, isSyncing, isOnline, needsReset, health, syncNow } = useSyncStatus()

  // MARK: - render

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-site-border bg-site-background px-3 py-2.5">
      <span
        className={
          isOnline
            ? 'size-2.5 shrink-0 rounded-full bg-site-ok animate-[site-pulse_2.2s_ease-out_infinite] motion-reduce:animate-none'
            : 'size-2.5 shrink-0 rounded-full bg-site-accent'
        }
        aria-hidden="true"
      />
      <span
        className={
          needsReset
            ? 'min-w-0 flex-1 truncate text-xs text-site-accent'
            : 'min-w-0 flex-1 truncate text-xs text-site-muted'
        }
        role={needsReset ? 'alert' : undefined}
      >
        {needsReset
          ? 'Sync is blocked: the server refused this pane. Wipe & rehydrate rebuilds it.'
          : statusText({
              isOnline,
              isSyncing,
              outboxDepth,
              lastSyncedAt: health.lastSuccessAt,
              engine: client.engine,
            })}
      </span>
      <Tip text="Pushes the outbox, then pulls, the same round trip as the next scheduled sync">
        <Button type="button" disabled={!isOnline || isSyncing} onClick={() => void syncNow()}>
          Sync now
        </Button>
      </Tip>
    </div>
  )
}

// MARK: - internal

interface IStatusTextParams {
  isOnline: boolean
  isSyncing: boolean
  outboxDepth: number
  lastSyncedAt: number | null
  engine: IPaneClient['engine']
}

/**
 * One line, in priority order: what is happening now, then what is waiting,
 * then when the last round trip landed, then which core answered it.
 */
function statusText(params: IStatusTextParams): string {
  const { isOnline, isSyncing, outboxDepth, lastSyncedAt, engine } = params
  const queued = outboxDepth === 0 ? 'nothing queued' : `${String(outboxDepth)} queued`
  const core = `${engine} engine`

  if (isSyncing) {
    return `Catching up… · ${queued} · ${core}`
  }
  if (!isOnline) {
    return `Offline · ${queued} · ${core}`
  }
  if (lastSyncedAt === null) {
    return `Online · Not synced yet · ${queued} · ${core}`
  }
  return `Online · last sync ${formatClockTime(lastSyncedAt)} · ${queued} · ${core}`
}
