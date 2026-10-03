import { EditTodoModal } from '../edit-todo-modal'
import type { ITodo, TImageEdit } from './types'

// MARK: - Edit modal region

export function EditModalRegion({
  editing,
  onSave,
  onCancel,
}: {
  editing: ITodo | null
  onSave: (id: string, title: string, image: TImageEdit) => Promise<void>
  onCancel: () => void
}) {
  if (editing === null) {
    return null
  }
  return <EditTodoModal todo={editing} onSave={onSave} onCancel={onCancel} />
}
