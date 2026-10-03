/**
 * The board's row shape, the edit modal's image-change intent, and the small
 * static data (read actions, status filter labels) shared by TodoBoard's
 * hooks and render-region components.
 */

import type { TColumnValues } from '@kizunasync/core'
import type { TTodoStatusFilter } from '@kizunasync/utilities'
import type { IBoardOrder } from '../settings-context'

// MARK: - Row mapping

export interface ITodo {
  id: string
  user_id: string
  title: string
  done: boolean
  image_path: string | null
  archived_at: string | null
}

/**
 * What the edit modal decides for the image on Save: keep it untouched, replace
 * it with a freshly picked local uri (enqueued via the attachment port), or
 * remove it (image_path cleared).
 */
export type TImageEdit =
  | { kind: 'keep' }
  | { kind: 'replace'; localUri: string }
  | { kind: 'remove' }

export const toTodo = (columns: TColumnValues): ITodo => ({
  id: typeof columns.id === 'string' ? columns.id : '',
  user_id: typeof columns.user_id === 'string' ? columns.user_id : '',
  title: typeof columns.title === 'string' ? columns.title : '',
  done: columns.done === true || columns.done === 1,
  image_path: typeof columns.image_path === 'string' ? columns.image_path : null,
  archived_at: typeof columns.archived_at === 'string' ? columns.archived_at : null,
})

// MARK: - Read actions

/**
 * A read tap publishes the board order (the list re-sorts through useQuery) and
 * runs the matching ordered SELECT through the query API so it lands in the log.
 * "Sort mine first" is a client post-sort, so it fetches unordered then layers.
 */
export type TReadAction = {
  key: string
  label: string
  order: IBoardOrder
}

export const READ_ACTIONS: TReadAction[] = [
  { key: 'all', label: 'Fetch all', order: { orderBy: 'created_at', ascending: false, mineFirst: false } },
  { key: 'asc', label: 'Sort created ASC', order: { orderBy: 'created_at', ascending: true, mineFirst: false } },
  { key: 'desc', label: 'Sort created DESC', order: { orderBy: 'created_at', ascending: false, mineFirst: false } },
  { key: 'mine', label: 'Sort mine first', order: { orderBy: 'created_at', ascending: false, mineFirst: true } },
]

// MARK: - Status filter

export const STATUS_FILTER_LABELS: Record<TTodoStatusFilter, string> = {
  all: 'All',
  active: 'Active',
  done: 'Done',
}
