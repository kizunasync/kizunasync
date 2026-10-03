import { TodoAddForm } from '@/components/todo-add-form'
import { TodoRow } from '@/components/todo-row'
import { useTodos } from '@/lib/use-todos'
import type { IPaneClient } from '@/runtime/kizunasync'

/** The board's two empty states differ only in wording, so they share the run. */
const EMPTY_CLASS = 'm-0 py-3.5 text-center text-sm text-site-muted'

export function TodoBoard({ client }: { client: IPaneClient }) {
  const { todos, error, isLoading, addTodo, toggleTodo, archiveTodo, restoreTodo, deleteTodo } = useTodos(client)

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <TodoAddForm pane={client.pane} onAdd={addTodo} />

      {error !== null ? (
        <p className="m-0 rounded-lg border border-site-danger px-3 py-2 text-xs text-site-danger">{error.message}</p>
      ) : null}

      {isLoading ? (
        <p className={EMPTY_CLASS}>Opening the local database…</p>
      ) : todos.length === 0 ? (
        <p className={EMPTY_CLASS}>Not synced yet; add a todo, or sync to pull the board.</p>
      ) : (
        <ul className="m-0 grid max-h-72 min-w-0 list-none gap-1.5 overflow-y-auto p-0">
          {todos.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              onToggle={toggleTodo}
              onArchive={archiveTodo}
              onRestore={restoreTodo}
              onDelete={deleteTodo}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
