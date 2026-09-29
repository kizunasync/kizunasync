import { useCallback, useState } from 'react'
import type { IKizunaSync } from '@kizunasync/core'
import { useQuery } from '@kizunasync/react'
import { TODOS_TABLE } from '@kizunasync/utilities'
import type { IBoardOrder } from '../../app/_layout'
import { sortMineFirst, toTodo } from '../lib/todos'
import { ETodoFilter, filterTodos, type TTodoFilter } from '../components/todo-filter'
import type { ITodo } from '../kizunasync-shim'

/**
 * The board's rows: the ordered query (re-run when the order's sort column
 * flips), "mine first" client-sort, and the segment + search narrowing shown
 * by `TodoFilter`. The narrowing is display-only: every write action still
 * operates on `todos`, the unfiltered list (@CONVENTIONS.md).
 */
export interface IBoardFilter {
  filter: TTodoFilter
  search: string
  setFilter: (value: TTodoFilter) => void
  setSearch: (value: string) => void
  todos: ITodo[]
  visibleTodos: ITodo[]
  isLoading: boolean
}

export function useBoardFilter({ boardOrder, myId }: { boardOrder: IBoardOrder; myId: string | null }): IBoardFilter {
  const { ascending, mineFirst } = boardOrder
  const buildList = useCallback(
    (k: IKizunaSync) => k.from(TODOS_TABLE).select().order('created_at', { ascending }),
    [ascending],
  )
  // useQuery only re-reads on engine events, so a board-order change needs deps to re-run.
  const todoQuery = useQuery(buildList, { deps: [ascending] })
  const [filter, setFilter] = useState<TTodoFilter>(ETodoFilter.all)
  const [search, setSearch] = useState('')

  const todos = sortMineFirst(todoQuery.data.map(toTodo), mineFirst ? myId : null)
  const visibleTodos = filterTodos(todos, { filter, search })

  return { filter, search, setFilter, setSearch, todos, visibleTodos, isLoading: todoQuery.isLoading }
}
