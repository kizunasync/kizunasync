import type { TColumnValues } from '@kizunasync/core'
import { ARCHIVED_COLUMN } from '../runtime/demo-config'

export interface ITodo {
  id: string
  user_id: string
  title: string
  done: boolean

  /**
   * null ⇒ live. A timestamp ⇒ soft-deleted: still a real row, still carrying
   * every other column, still editable and restorable.
   */
  archivedAt: string | null
}

export const toTodo = (columns: TColumnValues): ITodo => ({
  id: typeof columns.id === 'string' ? columns.id : '',
  user_id: typeof columns.user_id === 'string' ? columns.user_id : '',
  title: typeof columns.title === 'string' ? columns.title : '',
  done: columns.done === true || columns.done === 1,
  archivedAt: typeof columns[ARCHIVED_COLUMN] === 'string' ? columns[ARCHIVED_COLUMN] : null,
})
