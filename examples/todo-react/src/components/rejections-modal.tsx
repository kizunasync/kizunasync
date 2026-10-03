import type { TRejectionRecord, TUuid } from '@kizunasync/core'
import { formatRelativeTime } from '@kizunasync/utilities'
import { JournalListModal } from './journal-list-modal'

// MARK: - Rejections modal

/**
 * Every write the server refused (rejected, superseded, batch-aborted, dead-
 * lettered), newest first: the useRejections journal survives reloads until
 * dismissed. Shares JournalListModal's shell and the Cache tab's verdict-row/
 * verdict-chip styling with OverwritesModal.
 */
export function RejectionsModal({
  rejections,
  onDismiss,
  onClose,
}: {
  rejections: TRejectionRecord[]
  onDismiss: (mutationId: TUuid) => void
  onClose: () => void
}) {
  return (
    <JournalListModal
      title="Rejections"
      rows={rejections}
      emptyMessage="No rejections. Writes that the server refuses will appear here."
      getKey={(rejection) => rejection.mutationId}
      renderRow={(rejection) => (
        <>
          <div className="queue-head">
            <span className="verdict-chip">{rejection.kind}</span>
            <span className="verdict-id">
              {rejection.table} · {formatRelativeTime(rejection.at)}
            </span>
          </div>
          <p className="verdict-reason">{rejection.reason}</p>
        </>
      )}
      onDismiss={(rejection) => onDismiss(rejection.mutationId)}
      onClose={onClose}
    />
  )
}
