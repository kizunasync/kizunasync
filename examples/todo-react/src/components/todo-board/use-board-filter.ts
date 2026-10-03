/**
 * The visible todo list: "mine first" layering over the query's own order,
 * then the status segment and search box, both purely client-side over the
 * already-sorted rows.
 */

import { useState } from 'react'
import { matchesTodoFilter, sortTodosMineFirst, type TTodoStatusFilter } from '@kizunasync/utilities'
import type { IBoardOrder } from '../settings-context'
import type { ITodo } from './types'

export interface IUseBoardFilterParams {
  rows: ITodo[]
  boardOrder: IBoardOrder
  myId: string | null
}

export interface IUseBoardFilterResult {
  statusFilter: TTodoStatusFilter
  setStatusFilter: (value: TTodoStatusFilter) => void
  search: string
  setSearch: (value: string) => void
  todos: ITodo[]
  visibleTodos: ITodo[]
}

export function useBoardFilter({ rows, boardOrder, myId }: IUseBoardFilterParams): IUseBoardFilterResult {
  const [statusFilter, setStatusFilter] = useState<TTodoStatusFilter>('all')
  const [search, setSearch] = useState('')

  const todos = boardOrder.mineFirst ? sortTodosMineFirst(rows, myId) : rows
  const visibleTodos = todos.filter((todo) => matchesTodoFilter(todo, { status: statusFilter, search }))

  return { statusFilter, setStatusFilter, search, setSearch, todos, visibleTodos }
}
