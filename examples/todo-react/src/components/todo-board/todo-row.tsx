import { Button } from '@heroui/react'
import { isTodoArchived, isTodoEditable, isTodoMine, REGISTERED_UID_NAMES } from '@kizunasync/utilities'
import { t } from '../../i18n'
import { TodoThumb } from '../todo-thumb'
import { RowIcon } from './row-icon'
import type { ITodo } from './types'

// MARK: - Todo row

/** One board row: the toggle-done main button, the owner badge, edit, archive or restore, and delete. */
export function TodoRow({
  todo,
  myId,
  editAnyone,
  onToggle,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  todo: ITodo
  myId: string | null
  editAnyone: boolean
  onToggle: (todo: ITodo) => void
  onEdit: (todo: ITodo) => void
  onArchive: (todo: ITodo) => void
  onRestore: (todo: ITodo) => void
  onDelete: (todo: ITodo) => void
}) {
  const mine = isTodoMine(todo, myId)
  // Any visitor's row is editable on the shared board; editAnyone lifts the guard on a registered user's row. When on, the non-owner write reaches the server, which returns RLS_DENIED with the current row, and the engine reverts the optimistic edit instead of dropping it.
  const editable = isTodoEditable(todo, { myId, editAnyone })

  const archived = isTodoArchived(todo)
  const className = ['item', editable ? '' : 'is-locked', archived ? 'is-archived' : ''].filter(Boolean).join(' ')

  return (
    <li className={className}>
      <button
        type="button"
        className="item-main"
        aria-pressed={todo.done}
        disabled={!editable}
        onClick={() => onToggle(todo)}
      >
        <span className={todo.done ? 'checkbox is-done' : 'checkbox'} aria-hidden="true">
          ✓
        </span>
        <TodoThumb imagePath={todo.image_path} />
        <span className={todo.done ? 'item-title is-done' : 'item-title'}>{todo.title}</span>
        <span className={mine ? 'owner-badge is-mine' : 'owner-badge'}>{ownerBadge(todo, myId)}</span>
        {archived ? <span className="archived-badge">{t('item.archived')}</span> : null}
      </button>
      <Button isIconOnly variant="outline" aria-label="Edit" isDisabled={!editable} onPress={() => onEdit(todo)}>
        <RowIcon name="edit" />
      </Button>
      <Button
        isIconOnly
        variant="outline"
        aria-label={archived ? t('item.restore') : t('item.archive')}
        isDisabled={!editable}
        onPress={() => (archived ? onRestore(todo) : onArchive(todo))}
      >
        <RowIcon name={archived ? 'restore' : 'archive'} />
      </Button>
      <Button
        isIconOnly
        variant="outline"
        aria-label={t('item.delete')}
        isDisabled={!editable}
        onPress={() => onDelete(todo)}
      >
        <RowIcon name="deleteForever" />
      </Button>
    </li>
  )
}

// MARK: - internal

/**
 * Owner badge text (display-only, never the editable rule): my row → "you", a
 * registered user's row → that user's display name (Mary/Samuel/David), an
 * anonymous/unknown owner → "visitor".
 */
function ownerBadge(todo: ITodo, myId: string | null): string {
  if (isTodoMine(todo, myId)) {
    return t('item.you')
  }
  return REGISTERED_UID_NAMES[todo.user_id] ?? t('item.shared')
}
