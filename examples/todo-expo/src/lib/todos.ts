import type { TColumnValues } from '@kizunasync/core'
import { sortTodosMineFirst } from '@kizunasync/utilities'
import type { ITodo } from '../kizunasync-shim'

/**
 * The board's pure row helpers: minting a pk, narrowing engine columns to the
 * UI's row shape, and the client-side "mine first" pass.
 */

/**
 * A UUID for a new row's pk. React Native has no global `crypto`, so fall back to
 * a Math.random v4 (mirrors @kizunasync/core's defaultUuid) instead of crashing.
 */
export function newTodoId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined

  if (cryptoApi?.randomUUID !== undefined) {
    return cryptoApi.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0

    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * Engine columns → the UI's ITodo. Every field is narrowed, never asserted: the
 * store hands back whatever the last pull wrote.
 */
export function toTodo(columns: TColumnValues): ITodo {
  return {
    id: typeof columns.id === 'string' ? columns.id : '',
    user_id: typeof columns.user_id === 'string' ? columns.user_id : '',
    title: typeof columns.title === 'string' ? columns.title : '',
    done: columns.done === true,
    image_path: typeof columns.image_path === 'string' ? columns.image_path : null,
  }
}

/**
 * Float the current account's rows ahead of the rest, preserving each group's
 * incoming (created-ordered) order. A null id leaves the list untouched; the
 * Actions block's "Sort mine first" drives this.
 */
export function sortMineFirst(todos: ITodo[], myId: string | null): ITodo[] {
  return sortTodosMineFirst(todos, myId)
}
