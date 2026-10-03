import type { TOverwriteRecord, TRejectionRecord, TUuid } from 'kizunasync'
import { EditTodoModal } from '../edit-todo-modal'
import { OverwritesModal } from '../overwrites'
import { RejectionsModal } from '../rejections'
import { SwitchGuardModal, type IPendingSwitch } from '../switch-guard-modal'
import type { ITodo } from '../../kizunasync-shim'

/**
 * Every dialog the home screen can raise: the account-switch guard, the
 * title/image editor, and the rejections/overwrites journals. Grouped so
 * `TodoScreen`'s own render stays the board plus this one region
 * (@CONVENTIONS.md).
 */
export function HomeModals({
  pendingSwitch,
  onSyncNow,
  onSwitchAnyway,
  onCancelSwitch,
  editing,
  canAttachImages,
  onSaveEdit,
  onCancelEdit,
  rejectionsOpen,
  rejections,
  onDismissRejection,
  onCloseRejections,
  overwritesOpen,
  overwrites,
  onDismissOverwrite,
  onCloseOverwrites,
}: {
  pendingSwitch: IPendingSwitch | null
  onSyncNow: () => void
  onSwitchAnyway: () => void
  onCancelSwitch: () => void
  editing: ITodo | null
  canAttachImages: boolean
  onSaveEdit: (edit: { title?: string; image?: string | null }) => void
  onCancelEdit: () => void
  rejectionsOpen: boolean
  rejections: TRejectionRecord[]
  onDismissRejection: (mutationId: TUuid) => void
  onCloseRejections: () => void
  overwritesOpen: boolean
  overwrites: TOverwriteRecord[]
  onDismissOverwrite: (id: number) => void
  onCloseOverwrites: () => void
}) {
  return (
    <>
      <SwitchGuardModal pending={pendingSwitch} onSyncNow={onSyncNow} onSwitchAnyway={onSwitchAnyway} onCancel={onCancelSwitch} />
      <EditTodoModal todo={editing} canAttachImages={canAttachImages} onSave={onSaveEdit} onCancel={onCancelEdit} />
      <RejectionsModal
        visible={rejectionsOpen}
        rejections={rejections}
        onDismiss={onDismissRejection}
        onClose={onCloseRejections}
      />
      <OverwritesModal
        visible={overwritesOpen}
        overwrites={overwrites}
        onDismiss={onDismissOverwrite}
        onClose={onCloseOverwrites}
      />
    </>
  )
}
