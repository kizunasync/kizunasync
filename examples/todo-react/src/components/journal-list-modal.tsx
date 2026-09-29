import { Button, Modal } from '@heroui/react'
import type { ReactNode } from 'react'
import { AppModalFooter } from './app-modal-footer'

// MARK: - Journal list modal

/**
 * The shell shared by OverwritesModal and RejectionsModal: both read a
 * dismissible journal that survives reloads until dismissed, and render it as
 * a titled list of verdict rows with a per-row Dismiss action.
 */
export function JournalListModal<TRow>({
  title,
  rows,
  emptyMessage,
  getKey,
  renderRow,
  onDismiss,
  onClose,
}: {
  title: string
  rows: TRow[]
  emptyMessage: string
  getKey: (row: TRow) => string | number
  renderRow: (row: TRow) => ReactNode
  onDismiss: (row: TRow) => void
  onClose: () => void
}) {
  return (
    <Modal.Root isOpen onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Heading>{title}</Modal.Heading>
            <Modal.Body>
              {rows.length === 0 ? (
                <p>{emptyMessage}</p>
              ) : (
                <ul className="rejections-list">
                  {rows.map((row) => (
                    <li key={getKey(row)} className="verdict-row">
                      {renderRow(row)}
                      <div className="modal-actions">
                        <Button variant="outline" size="sm" onPress={() => onDismiss(row)}>
                          Dismiss
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Modal.Body>
            <AppModalFooter>
              <Button variant="outline" onPress={onClose}>
                Close
              </Button>
            </AppModalFooter>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  )
}
