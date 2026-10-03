import type { IInspectorSnapshot } from 'kizunasync'
import { onActivate, QUEUE_BADGE_CLASS } from './badges'
import type { TDialogContent } from './detail-modal'

// MARK: - Queued mutations

export function QueuedMutations({
  snapshot,
  onOpenDialog,
}: {
  snapshot: IInspectorSnapshot | null
  onOpenDialog: (content: TDialogContent) => void
}) {
  const queued = snapshot === null ? [] : [...snapshot.queued].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <>
      <p className="section-title">queued mutations</p>
      {queued.length === 0 ? (
        <p className="cache-empty">outbox empty: nothing waiting to push.</p>
      ) : (
        queued.map((entry) => {
          const queuedRows: [string, string][] = [
            ['op', entry.op],
            ['table', entry.table],
            ['pk', entry.pk],
            ['mutation id', entry.mutationId],
            ['seq', String(entry.seq)],
            ['created at', entry.createdAt],
            ['in-flight', entry.inFlight ? 'yes' : 'no'],
            ['batch id', entry.batchId ?? 'n/a'],
            ['hlc', entry.hlc ?? 'n/a'],
            ['columns', JSON.stringify(entry.columns)],
            ['precondition', entry.precondition !== null ? JSON.stringify(entry.precondition) : 'n/a'],
          ]

          return (
            <div
              key={entry.seq}
              className="queue-row cache-clickable"
              role="button"
              tabIndex={0}
              onClick={() => onOpenDialog({ title: 'Queued mutation', rows: queuedRows })}
              onKeyDown={onActivate(() => onOpenDialog({ title: 'Queued mutation', rows: queuedRows }))}
            >
              <div className="queue-head">
                <span className={QUEUE_BADGE_CLASS[entry.op] ?? 'op-badge is-neutral'}>{entry.op}</span>
                <span className="queue-table">{entry.table}</span>
                {entry.inFlight ? <span className="inflight-chip">in-flight</span> : null}
              </div>
              <p className="queue-pk">pk {entry.pk}</p>
            </div>
          )
        })
      )}
    </>
  )
}
