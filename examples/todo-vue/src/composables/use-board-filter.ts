/**
 * The visible todo list: the query's raw rows sorted by created_at and
 * "mine first" layered on top, then the status segment and search box, both
 * purely client-side over the already-sorted rows.
 */

import { computed, ref, type Ref } from 'vue'
import type { TColumnValues } from '@kizunasync/core'
import { matchesTodoFilter, sortTodosMineFirst, type TTodoStatusFilter } from '@kizunasync/utilities'
import { boardOrder } from '../settings'
import { toTodo, type ITodo } from './types'

export function useBoardFilter({ data, myId }: { data: Ref<TColumnValues[]>; myId: Ref<string | null> }) {
  // Reactive on `boardOrder` (set by the Cache read-test buttons) and `myId`, so it re-sorts immediately without a re-read. useQuery only re-runs on engine events, so the column + mine-first pass lives here.
  const todos = computed(() => {
    const rows = data.value.map(toTodo)

    rows.sort((left, right) => {
      const ordering = left.created_at.localeCompare(right.created_at)

      return boardOrder.ascending ? ordering : -ordering
    })

    return boardOrder.mineFirst ? sortTodosMineFirst(rows, myId.value) : rows
  })

  const statusFilter = ref<TTodoStatusFilter>('all')
  const search = ref('')

  // Purely client-side, over the already-sorted `todos`: the segmented control filters by done flag, the search box filters by case-insensitive title substring, and both combine; the 4 sort actions above are unaffected.
  const visibleTodos = computed<ITodo[]>(() =>
    todos.value.filter((row) => matchesTodoFilter(row, { status: statusFilter.value, search: search.value })),
  )

  return { todos, statusFilter, search, visibleTodos }
}
