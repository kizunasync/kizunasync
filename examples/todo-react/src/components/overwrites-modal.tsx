import type { TOverwriteRecord } from '@kizunasync/core'
import { formatRelativeTime } from '@kizunasync/utilities'
import { JournalListModal } from './journal-list-modal'

// MARK: - Overwrites modal

/**
 * The other half of "what happened to my writes": a rejection is a write the
 * server refused, an overwrite is a write it accepted whose column another
 * device had already won. `useOverwrites` reads the journal, which survives
 * reloads until dismissed. Shares JournalListModal's shell and styling with
 * RejectionsModal so the two read as one surface.
 */

/** A column value is any JSON, and a long one would swamp the row. */
const LOSER_VALUE_MAX_LENGTH = 60

function describeLoser(value: unknown): string {
  if (value === null || value === undefined) {
    return 'an empty value'
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)

  if (rendered === undefined || rendered.length > LOSER_VALUE_MAX_LENGTH) {
    return 'your value'
  }
  return `"${rendered}"`
}

export function OverwritesModal({
  overwrites,
  onDismiss,
  onClose,
}: {
  overwrites: TOverwriteRecord[]
  onDismiss: (id: number) => void
  onClose: () => void
}) {
  return (
    <JournalListModal
      title="Overwrites"
      rows={overwrites}
      emptyMessage="No overwrites. Columns another device won will appear here."
      getKey={(overwrite) => overwrite.id}
      renderRow={(overwrite) => (
        <>
          <div className="queue-head">
            <span className="verdict-chip">{overwrite.conflictMode}</span>
            <span className="verdict-id">
              {overwrite.table}.{overwrite.column} · {formatRelativeTime(overwrite.at)}
            </span>
          </div>
          <p className="verdict-reason">
            Another device won this column, so {describeLoser(overwrite.loserValue)} was replaced.
          </p>
        </>
      )}
      onDismiss={(overwrite) => onDismiss(overwrite.id)}
      onClose={onClose}
    />
  )
}
