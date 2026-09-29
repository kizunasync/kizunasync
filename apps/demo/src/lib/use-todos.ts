import { useMutation, useQuery } from '@kizunasync/react'
import { toTodo, type ITodo } from '@/lib/todo'
import { ARCHIVED_COLUMN, TODOS_TABLE } from '@/runtime/demo-config'
import type { IPaneClient } from '@/runtime/kizunasync'

export interface IUseTodosResult {
  todos: ITodo[]
  error: Error | null
  isLoading: boolean
  addTodo: (title: string) => void
  toggleTodo: (todo: ITodo) => void
  archiveTodo: (todo: ITodo) => void
  restoreTodo: (todo: ITodo) => void
  deleteTodo: (todo: ITodo) => void
}

/**
 * Every data op goes through the pane's kizunasync client, never supabase.from().
 * useQuery drives the list and re-reads on every engine event, so a row arriving
 * from the other pane appears without any code here asking for it.
 */
export function useTodos(client: IPaneClient): IUseTodosResult {
  const { data, error: queryError, isLoading } = useQuery((kizunasync) =>
    kizunasync.from(TODOS_TABLE).select().order('created_at', { ascending: false }),
  )
  const { mutate, error: writeError } = useMutation()

  const todos = data.map(toTodo)
  const error = queryError ?? writeError

  function addTodo(title: string): void {
    const trimmed = title.trim()
    const ownerId = client.getOwnerId()

    if (trimmed === '' || ownerId === null) {
      return
    }
    void mutate((kizunasync) =>
      kizunasync.from(TODOS_TABLE).insert({
        title: trimmed,
        done: false,
        user_id: ownerId,
        created_at: new Date().toISOString(),
      }),
    )
  }

  function toggleTodo(todo: ITodo): void {
    void mutate((kizunasync) => kizunasync.from(TODOS_TABLE).update({ done: !todo.done }).eq('id', todo.id))
  }

  // Soft delete: an ordinary update of an ordinary column. No tombstone, so the row survives, keeps merging under column-LWW, and can be restored.
  function archiveTodo(todo: ITodo): void {
    void mutate((kizunasync) =>
      kizunasync
        .from(TODOS_TABLE)
        .update({ [ARCHIVED_COLUMN]: new Date().toISOString() })
        .eq('id', todo.id),
    )
  }

  function restoreTodo(todo: ITodo): void {
    void mutate((kizunasync) =>
      kizunasync
        .from(TODOS_TABLE)
        .update({ [ARCHIVED_COLUMN]: null })
        .eq('id', todo.id),
    )
  }

  // Hard delete: the real delete path. Writes a delete-wins tombstone, so the row is gone for good and a later edit to it is refused before RLS.
  function deleteTodo(todo: ITodo): void {
    void mutate((kizunasync) => kizunasync.from(TODOS_TABLE).delete().eq('id', todo.id))
  }

  return { todos, error, isLoading, addTodo, toggleTodo, archiveTodo, restoreTodo, deleteTodo }
}
