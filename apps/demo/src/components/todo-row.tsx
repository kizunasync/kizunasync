import { Icon } from '@/components/icon'
import { Tip } from '@/components/tip'
import type { ITodo } from '@/lib/todo'
import { FOREIGN_OWNER } from '@/runtime/demo-config'

/** The three per-row icon buttons are identical but for their glyph and intent. */
const ROW_ACTION_CLASS =
  'grid size-5.5 shrink-0 place-items-center rounded-sm border-none bg-transparent p-0 text-sm text-site-muted enabled:hover:text-site-accent disabled:cursor-not-allowed disabled:opacity-35'

interface ITodoRowProps {
  todo: ITodo
  onToggle: (todo: ITodo) => void
  onArchive: (todo: ITodo) => void
  onRestore: (todo: ITodo) => void
  onDelete: (todo: ITodo) => void
}

export function TodoRow({ todo, onToggle, onArchive, onRestore, onDelete }: ITodoRowProps) {
  const isForeign = todo.user_id === FOREIGN_OWNER.id
  const isArchived = todo.archivedAt !== null

  return (
    <li
      className={`flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 ${
        isArchived
          ? 'border-dashed border-site-faint bg-site-background opacity-70'
          : 'border-site-border bg-site-raised'
      } ${isForeign ? 'opacity-60' : ''}`}
    >
      <TodoDoneToggle todo={todo} isForeign={isForeign} onToggle={onToggle} />
      {isArchived ? (
        <span className="shrink-0 rounded-full border border-site-faint px-1.5 py-px text-xs font-bold tracking-wide text-site-muted uppercase">
          archived
        </span>
      ) : null}
      {isForeign ? (
        <span className="shrink-0 rounded-full border border-site-border px-1.5 py-px text-xs font-bold tracking-wide text-site-muted uppercase">
          not yours
        </span>
      ) : null}
      {isArchived ? (
        <Tip text="Clear the soft delete, archived_at back to null">
          <button
            className={ROW_ACTION_CLASS}
            type="button"
            disabled={isForeign}
            aria-label={`Restore ${todo.title}`}
            onClick={() => onRestore(todo)}
          >
            <Icon name="restore" />
          </button>
        </Tip>
      ) : (
        <Tip text="Archive the row: a column write, not a removal">
          <button
            className={ROW_ACTION_CLASS}
            type="button"
            disabled={isForeign}
            aria-label={`Soft delete ${todo.title}`}
            onClick={() => onArchive(todo)}
          >
            <Icon name="deleteSoft" />
          </button>
        </Tip>
      )}
      <Tip text="Delete the row for good: a real DELETE">
        <button
          className={ROW_ACTION_CLASS}
          type="button"
          disabled={isForeign}
          aria-label={`Delete ${todo.title} for good`}
          onClick={() => onDelete(todo)}
        >
          <Icon name="deleteHard" />
        </button>
      </Tip>
    </li>
  )
}

function TodoDoneToggle({
  todo,
  isForeign,
  onToggle,
}: {
  todo: ITodo
  isForeign: boolean
  onToggle: (todo: ITodo) => void
}) {
  return (
    <Tip text="Mark done, syncs as a column write">
      <button
        className="group flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent p-0 text-left text-inherit disabled:cursor-not-allowed"
        type="button"
        disabled={isForeign}
        aria-label={`Toggle ${todo.title}`}
        onClick={() => onToggle(todo)}
      >
        <span
          className={`grid size-4.5 shrink-0 place-items-center rounded-sm border-2 text-xs transition-colors ${
            todo.done
              ? 'border-site-accent bg-site-accent text-site-accent-foreground'
              : 'border-site-border text-transparent group-enabled:group-hover:border-site-accent'
          }`}
        >
          <Icon name="check" />
        </span>
        <span className={`min-w-0 flex-1 truncate text-sm ${todo.done ? 'text-site-muted line-through' : ''}`}>
          {todo.title}
        </span>
      </button>
    </Tip>
  )
}
