/**
 * The board's row shape, the status-filter segment options, and the mutate
 * helper's type, shared by TodoView's composables and its template.
 */

import type { IKizunaSync, TColumnValues } from '@kizunasync/core'
import type { TTodoStatusFilter } from '@kizunasync/utilities'

// MARK: - Mutate

/**
 * TodoView's local write wrapper: runs `fn` against the live client, records
 * it in the query log under `op`/`label`, and captures a throw into the
 * shared writeError ref instead of raising. Owned by TodoView.vue itself
 * (every composable that writes takes it as a parameter) because `writeError`
 * feeds the top-level `error`/`note` computed alongside the query and sync
 * errors.
 */
export type TMutate = (fn: (kizunasync: IKizunaSync) => unknown, op: 'INSERT' | 'UPDATE' | 'DELETE', label: string) => Promise<void>

// MARK: - Row mapping

export interface ITodo {
  id: string
  user_id: string
  title: string
  done: boolean
  image_path: string | null
  created_at: string
}

export const toTodo = (columns: TColumnValues): ITodo => ({
  id: typeof columns.id === 'string' ? columns.id : '',
  user_id: typeof columns.user_id === 'string' ? columns.user_id : '',
  title: typeof columns.title === 'string' ? columns.title : '',
  done: columns.done === true || columns.done === 1,
  image_path: typeof columns.image_path === 'string' ? columns.image_path : null,
  created_at: typeof columns.created_at === 'string' ? columns.created_at : '',
})

// MARK: - Status filter

export const FILTER_OPTIONS: { value: TTodoStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'done', label: 'Done' },
]
