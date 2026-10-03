import { useState } from 'react'
import { Button, Input, Modal, TextField } from '@heroui/react'
import { useAttachment } from 'kizunasync/react'
import { TITLE_MAX_LENGTH } from '@kizunasync/utilities'
import { pickImageFile } from '../utils'
import type { ITodo, TImageEdit } from './todo-board/types'
import { AppModalFooter } from './app-modal-footer'
import { Skeleton } from './skeleton'

// MARK: - Edit todo modal

/** The image preview (kept/replaced/removed) and its replace/remove actions, split out to keep EditTodoModal's own branching within the shape target. */
function EditImagePicker({
  preview,
  keptPending,
  onPick,
  onRemove,
}: {
  preview: string | null
  keptPending: boolean
  onPick: () => void
  onRemove: () => void
}) {
  return (
    <div className="edit-image">
      {preview !== null ? (
        <img className="edit-thumb" src={preview} alt="" />
      ) : keptPending ? (
        <Skeleton className="edit-thumb" />
      ) : (
        <span className="edit-thumb is-empty" aria-hidden="true">
          絆
        </span>
      )}
      <div className="edit-image-actions">
        <Button variant="outline" size="sm" onPress={onPick}>
          {preview !== null ? 'Replace image' : 'Add image'}
        </Button>
        {preview !== null ? (
          <Button variant="danger-soft" size="sm" onPress={onRemove}>
            Remove image
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Drafts a title + image change; Save commits both as ONE update through the
 * board's saveEdit (same mutate path as toggle/add, so it syncs and reconciles
 * normally). The kept image resolves lazily through the attachment port.
 */
export function EditTodoModal({
  todo,
  onSave,
  onCancel,
}: {
  todo: ITodo
  onSave: (id: string, title: string, image: TImageEdit) => Promise<void>
  onCancel: () => void
}) {
  // MARK: - Variables
  const [draftTitle, setDraftTitle] = useState(todo.title)
  const [image, setImage] = useState<TImageEdit>({ kind: 'keep' })

  // The kept image resolves through the attachment port (lazy-downloads a peer's bytes on first view); only call useAttachment while keeping it.
  const kept = useAttachment(image.kind === 'keep' ? todo.image_path : null)
  const preview =
    image.kind === 'replace'
      ? image.localUri
      : image.kind === 'remove'
        ? null
        : kept.localUri
  const keptPending =
    image.kind === 'keep' && todo.image_path !== null && kept.localUri === null && kept.error === null

  // MARK: - Methods

  async function pick(): Promise<void> {
    const uri = await pickImageFile()

    if (uri !== null) {
      setImage({ kind: 'replace', localUri: uri })
    }
  }

  // MARK: - render

  return (
    <Modal.Root isOpen onOpenChange={(open) => (open ? undefined : onCancel())}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Heading>Edit todo</Modal.Heading>
            <Modal.Body>
              <TextField fullWidth value={draftTitle} aria-label="Title" onChange={setDraftTitle}>
                <Input maxLength={TITLE_MAX_LENGTH} />
              </TextField>
              <EditImagePicker
                preview={preview}
                keptPending={keptPending}
                onPick={() => void pick()}
                onRemove={() => setImage({ kind: 'remove' })}
              />
            </Modal.Body>
            <AppModalFooter>
              <Button onPress={() => void onSave(todo.id, draftTitle, image)}>Save</Button>
              <Button variant="outline" onPress={onCancel}>
                Cancel
              </Button>
            </AppModalFooter>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  )
}
