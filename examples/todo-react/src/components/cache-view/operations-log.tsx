import type { IQueryLogEntry } from '@kizunasync/utilities'
import { onActivate, OP_BADGE_CLASS } from './badges'
import type { TDialogContent } from './detail-modal'

// MARK: - Operations log

const LOG_RENDER_CAP = 150

export function OperationsLog({
  log,
  onOpenDialog,
}: {
  log: readonly IQueryLogEntry[]
  onOpenDialog: (content: TDialogContent) => void
}) {
  const visibleLog = log.slice(-LOG_RENDER_CAP).reverse()

  return (
    <>
      <div className="log-header">
        <p className="section-title">all operations</p>
      </div>
      {visibleLog.length === 0 ? (
        <p className="cache-empty">no operations recorded yet.</p>
      ) : (
        visibleLog.map((entry) => {
          const opRows: [string, string][] = [
            ['op', entry.op],
            ['label', entry.label],
            ['rows', entry.rows === null ? 'n/a' : String(entry.rows)],
            ['duration', `${entry.ms}ms`],
            ['seq', String(entry.seq)],
          ]

          return (
            <div
              key={entry.seq}
              className="log-row cache-clickable"
              role="button"
              tabIndex={0}
              onClick={() => onOpenDialog({ title: 'Operation', rows: opRows })}
              onKeyDown={onActivate(() => onOpenDialog({ title: 'Operation', rows: opRows }))}
            >
              <span className={OP_BADGE_CLASS[entry.op]}>{entry.op}</span>
              <span className="log-label">{entry.label}</span>
              <span className="log-meta">
                {entry.rows === null ? 'n/a' : `${entry.rows} rows`} · {entry.ms}ms
              </span>
            </div>
          )
        })
      )}
    </>
  )
}
