/**
 * The Cache tab's read/write test actions: ordered reads through the query
 * API, the bulk delete/edit-all sweeps, the predefined-set insert, and the
 * one recovery path from a soft-blocked checkpoint (reset + resync).
 */

import { ref, type Ref } from 'vue'
import { isTodoEditable, messageOf, predefinedTodoStamps, TODOS_TABLE, withEditAllSuffix } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../kizunasync'
import { boardOrder, settings } from '../settings'
import type { ITodo, TMutate } from './types'

export function useBoardActions({
  client,
  mutate,
  todos,
  myId,
  syncNow,
  onMessage,
}: {
  client: IKizunaSyncShim
  mutate: TMutate
  todos: Ref<ITodo[]>
  myId: Ref<string | null>
  syncNow: () => Promise<void>
  onMessage: (message: string) => void
}) {
  const isResetting = ref(false)
  const editableTodos = (): ITodo[] =>
    todos.value.filter((todo) => isTodoEditable(todo, { myId: myId.value, editAnyone: settings.editAnyone }))

  // Run a real ordered local read, log it as an 'app' SELECT, and set the shared board order so the visible list re-sorts immediately. "mine first" reads all then leaves the client-side mine-first pass to the `todos` computed.
  async function runRead(label: string, ascending: boolean, mineFirst: boolean): Promise<void> {
    const started = Date.now()
    const { data: rows } = await client.from(TODOS_TABLE).select().order('created_at', { ascending })

    client.queryLog.record({
      op: 'SELECT',
      label,
      rows: rows.length,
      ms: Date.now() - started,
    })
    boardOrder.ascending = ascending
    boardOrder.mineFirst = mineFirst
  }

  // Delete every row the current account may write (guest rows always, registered rows only with Edit-anyone), one DELETE mutation each: the list empties.
  async function deleteAll(): Promise<void> {
    for (const todo of editableTodos()) {
      await mutate((k) => k.from(TODOS_TABLE).delete().eq('id', todo.id), 'DELETE', 'todos · delete all')
    }
  }

  // Insert the predefined set, stamped newest-first so the rows sort to the top.
  async function createPredefined(): Promise<void> {
    const ownerId = myId.value

    if (ownerId === null) {
      return
    }
    for (const { title, createdAt } of predefinedTodoStamps(Date.now())) {
      await mutate(
        (k) => k.from(TODOS_TABLE).insert({ title, done: false, user_id: ownerId, image_path: null, created_at: createdAt }),
        'INSERT',
        'todos · create predefined',
      )
    }
  }

  // Append the heart suffix to every writable row's title, one UPDATE mutation each.
  async function editAll(): Promise<void> {
    for (const todo of editableTodos()) {
      await mutate(
        (k) => k.from(TODOS_TABLE).update({ title: withEditAllSuffix(todo.title) }).eq('id', todo.id),
        'UPDATE',
        'todos · edit all',
      )
    }
  }

  async function rebuildLocalDatabase(): Promise<void> {
    isResetting.value = true

    try {
      await client.reset()
      await syncNow()
    } catch (cause) {
      onMessage(messageOf(cause))
    } finally {
      isResetting.value = false
    }
  }

  return { isResetting, runRead, deleteAll, createPredefined, editAll, rebuildLocalDatabase }
}
