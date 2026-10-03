import { useCallback } from 'react'
import type { IKizunaSync, TColumnValues } from 'kizunasync'
import { ARCHIVED_COLUMN, TODOS_TABLE, withEditAllSuffix } from '@kizunasync/utilities'
import { isEditable } from '../lib/account'
import { editTodo, getQueryLog, type ITodo } from '../kizunasync-shim'
import type { IBoardOrder } from '../../app/_layout'
import type { IReadAction } from '../components/actions-block'

const PREDEFINED_TITLES = ['Buy milk', 'Walk the dog', '絆 Read the Kizuna docs', 'Ship the demo']

/**
 * Every write the board issues: the per-row toggle/delete, the bulk actions
 * (delete/create/edit all, skipping rows the account cannot write), and the
 * Actions block's read tests, which run an ordered SELECT through the query
 * API and publish the board order so the visible list re-sorts. All of it
 * goes through the same mutate path as add/edit, so it queues, syncs,
 * reconciles, and shows in the Cache tab (@CONVENTIONS.md).
 */
export interface IBoardActions {
  runReadAction: (action: IReadAction) => Promise<void>
  deleteAll: () => void
  createPredefined: () => void
  editAll: () => void
  toggleTodo: (todo: ITodo) => void
  archiveTodo: (todo: ITodo) => void
  restoreTodo: (todo: ITodo) => void
  deleteTodo: (id: string) => void
}

export function useBoardActions({
  todos,
  myId,
  editAnyone,
  mutate,
  client,
  setBoardOrder,
}: {
  todos: ITodo[]
  myId: string | null
  editAnyone: boolean
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  client: IKizunaSync
  setBoardOrder: (value: IBoardOrder) => void
}): IBoardActions {
  const runReadAction = useCallback(
    async (action: IReadAction): Promise<void> => {
      const started = Date.now()
      const result = await client
        .from(TODOS_TABLE)
        .select()
        .order('created_at', { ascending: action.order.ascending })

      getQueryLog().record({
        op: 'SELECT',
        label: `todos · ${action.label.toLowerCase()}`,
        rows: result.data.length,
        ms: Date.now() - started,
      })
      setBoardOrder(action.order)
    },
    [client, setBoardOrder],
  )

  const deleteAll = useCallback(() => {
    const targets = todos.filter((todo) => isEditable(todo, myId, editAnyone))

    if (targets.length === 0) {
      return
    }
    getQueryLog().record({ op: 'DELETE', label: 'todos · delete all', rows: targets.length })

    for (const todo of targets) {
      void mutate((k) => k.from(TODOS_TABLE).delete().eq('id', todo.id))
    }
  }, [todos, myId, editAnyone, mutate])

  const createPredefined = useCallback(() => {
    const base = Date.now()

    getQueryLog().record({
      op: 'INSERT',
      label: 'todos · create predefined',
      rows: PREDEFINED_TITLES.length,
    })
    PREDEFINED_TITLES.forEach((predefinedTitle, index) => {
      // Stagger created_at so the set sorts newest-first in array order.
      const createdAt = new Date(base + (PREDEFINED_TITLES.length - index)).toISOString()
      const values: TColumnValues = {
        title: predefinedTitle,
        done: false,
        image_path: null,
        user_id: myId ?? '',
        created_at: createdAt,
      }

      void mutate((k) => k.from(TODOS_TABLE).insert(values))
    })
  }, [myId, mutate])

  const editAll = useCallback(() => {
    const targets = todos.filter((todo) => isEditable(todo, myId, editAnyone))

    if (targets.length === 0) {
      return
    }
    getQueryLog().record({ op: 'UPDATE', label: 'todos · edit all', rows: targets.length })

    for (const todo of targets) {
      void mutate((k) => editTodo(k, todo.id, { title: withEditAllSuffix(todo.title) }))
    }
  }, [todos, myId, editAnyone, mutate])

  // Every HomeTodoRow's toggle/delete: the single-row twins of deleteAll/editAll's bulk mutate path. Split out so this hook's own body stays readable alongside the bulk actions above (@CONVENTIONS.md).
  const { toggleTodo, archiveTodo, restoreTodo, deleteTodo } = useRowActions(mutate)

  return { runReadAction, deleteAll, createPredefined, editAll, toggleTodo, archiveTodo, restoreTodo, deleteTodo }
}

// MARK: - internal

/** `HomeTodoRow`'s per-row toggle/archive/restore/delete, one mutate + query-log entry each. */
function useRowActions(mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>): {
  toggleTodo: (todo: ITodo) => void
  archiveTodo: (todo: ITodo) => void
  restoreTodo: (todo: ITodo) => void
  deleteTodo: (id: string) => void
} {
  const toggleTodo = useCallback(
    (todo: ITodo) => {
      getQueryLog().record({ op: 'UPDATE', label: 'todos · toggle done', rows: 1 })
      void mutate((k) => k.from(TODOS_TABLE).update({ done: !todo.done }).eq('id', todo.id))
    },
    [mutate],
  )

  const archiveTodo = useCallback(
    (todo: ITodo) => {
      getQueryLog().record({ op: 'UPDATE', label: 'todos · archive', rows: 1 })
      void mutate((k) => k.from(TODOS_TABLE).update({ [ARCHIVED_COLUMN]: new Date().toISOString() }).eq('id', todo.id))
    },
    [mutate],
  )

  const restoreTodo = useCallback(
    (todo: ITodo) => {
      getQueryLog().record({ op: 'UPDATE', label: 'todos · restore', rows: 1 })
      void mutate((k) => k.from(TODOS_TABLE).update({ [ARCHIVED_COLUMN]: null }).eq('id', todo.id))
    },
    [mutate],
  )

  const deleteTodo = useCallback(
    (id: string) => {
      getQueryLog().record({ op: 'DELETE', label: 'todos · delete', rows: 1 })
      void mutate((k) => k.from(TODOS_TABLE).delete().eq('id', id))
    },
    [mutate],
  )

  return { toggleTodo, archiveTodo, restoreTodo, deleteTodo }
}
