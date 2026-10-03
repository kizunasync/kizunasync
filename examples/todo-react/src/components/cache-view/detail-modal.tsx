import { Button, Modal } from '@heroui/react'
import { AppModalFooter } from '../app-modal-footer'

// MARK: - Dialog content type

export type TDialogContent = {
  title: string
  body?: string
  value?: string
  rows?: [string, string][]
}

export function DetailModal({ content, onClose }: { content: TDialogContent; onClose: () => void }) {
  const hasDetail = content.value !== undefined || (content.rows !== undefined && content.rows.length > 0)

  return (
    <Modal.Root isOpen onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Heading>{content.title}</Modal.Heading>
            <Modal.Body>
              {content.body !== undefined ? <p>{content.body}</p> : null}
              {hasDetail ? (
                <dl className="detail-list">
                  {content.value !== undefined ? (
                    <div>
                      <dt>current value</dt>
                      <dd>{content.value}</dd>
                    </div>
                  ) : null}
                  {content.rows?.map(([label, val]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{val}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
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
