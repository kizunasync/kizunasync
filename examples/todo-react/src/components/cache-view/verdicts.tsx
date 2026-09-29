import type { IInspectorVerdict } from '@kizunasync/core'
import { onActivate } from './badges'
import type { TDialogContent } from './detail-modal'

// MARK: - Recent verdicts

export function Verdicts({
  verdicts,
  onOpenDialog,
}: {
  verdicts: IInspectorVerdict[]
  onOpenDialog: (content: TDialogContent) => void
}) {
  return (
    <>
      <p className="section-title">recent verdicts</p>
      {verdicts.length === 0 ? (
        <p className="cache-empty">no rejected or aborted mutations.</p>
      ) : (
        verdicts
          .slice()
          .reverse()
          .map((verdict) => {
            const verdictRows: [string, string][] = [
              ['kind', verdict.kind],
              ['mutation id', verdict.mutationId],
              ['reason', String(verdict.reason)],
              ['at', verdict.at],
            ]

            return (
              <div
                key={`${verdict.mutationId}-${verdict.at}`}
                className="verdict-row cache-clickable"
                role="button"
                tabIndex={0}
                onClick={() => onOpenDialog({ title: 'Verdict', rows: verdictRows })}
                onKeyDown={onActivate(() => onOpenDialog({ title: 'Verdict', rows: verdictRows }))}
              >
                <div className="queue-head">
                  <span className="verdict-chip">{verdict.kind}</span>
                  <span className="verdict-id">{verdict.mutationId}</span>
                </div>
                <p className="verdict-reason">{verdict.reason}</p>
              </div>
            )
          })
      )}
    </>
  )
}
