/**
 * The conflict lab's server-side edit: write directly to the server, bypassing
 * the client, so a later local edit and sync demonstrates last-write-wins.
 */

import type { IKizunaSync, TColumnValues } from '@kizunasync/core'
import { messageOf } from './errors'

// MARK: - Remote surface this drill needs

/**
 * The narrow slice of a supabase-js `from().update().eq()` chain this drill
 * drives, typed structurally rather than importing `@supabase/supabase-js` so
 * `@kizunasync/utilities` stays free of a Supabase dependency.
 */
export interface IConflictDrillRemote {
  from(table: string): {
    update(values: Record<string, unknown>): {
      /**
       * `PromiseLike`, not `Promise`: supabase-js's filter builder is a
       * thenable query, not a real `Promise` instance.
       */
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>
    }
  }
}

// MARK: - forceServerConflict

/**
 * Read the top row through the local store, then edit its title DIRECTLY on
 * the server via `supabase`, bypassing the client entirely. A later local edit
 * plus sync then races the two writes, and the example shows who won. Returns
 * a human-readable status line rather than throwing, so the caller can render
 * it without a try/catch.
 */
export async function forceServerConflict(
  supabase: IConflictDrillRemote,
  client: Pick<IKizunaSync, 'from'>,
  table: string,
): Promise<string> {
  let top: TColumnValues | undefined

  try {
    top = (await client.from(table).select()).data[0]
  } catch (cause) {
    return `local read failed: ${messageOf(cause)}`
  }
  if (top === undefined) {
    return 'add a todo first'
  }
  const id = typeof top.id === 'string' ? top.id : ''
  const title = typeof top.title === 'string' ? top.title : ''
  const { error } = await supabase.from(table).update({ title: `${title} (edited on server)` }).eq('id', id)

  if (error !== null) {
    return `server edit failed: ${error.message}`
  }
  return 'the server now disagrees with the device: edit locally, then sync, and watch who wins'
}
