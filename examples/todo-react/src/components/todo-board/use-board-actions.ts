/**
 * The Cache tab's read/write test actions: ordered reads through the query
 * API, the bulk delete/edit-all sweeps, the predefined-set insert, and the
 * one recovery path from a soft-blocked checkpoint (reset + resync).
 */

import { useState } from 'react'
import type { IKizunaSync } from 'kizunasync'
import { isTodoEditable, messageOf, predefinedTodoStamps, TODOS_TABLE, withEditAllSuffix } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../../kizunasync'
import type { IBoardOrder } from '../settings-context'
import type { ITodo, TReadAction } from './types'

export interface IUseBoardActionsParams {
  client: IKizunaSyncShim
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  todos: ITodo[]
  myId: string | null
  editAnyone: boolean
  syncNow: () => Promise<void>
  setBoardOrder: (value: IBoardOrder) => void
  onMessage: (message: string) => void
}

export interface IUseBoardActionsResult {
  runReadAction: (action: TReadAction) => Promise<void>
  deleteAll: () => void
  createPredefined: () => void
  editAll: () => void
  rebuildLocalDatabase: () => Promise<void>
  isResetting: boolean
}

export function useBoardActions({
  client,
  mutate,
  todos,
  myId,
  editAnyone,
  syncNow,
  setBoardOrder,
  onMessage,
}: IUseBoardActionsParams): IUseBoardActionsResult {
  const [isResetting, setIsResetting] = useState(false)
  const editableTodos = (): ITodo[] => todos.filter((todo) => isTodoEditable(todo, { myId, editAnyone }))

  // Run the read action's ordered SELECT through the query API (so it lands in the log) and publish the board order, which re-sorts the visible list.
  async function runReadAction(action: TReadAction): Promise<void> {
    const startedAt = Date.now()
    const { data: rows } = action.order.mineFirst
      ? await client.from(TODOS_TABLE).select()
      : await client.from(TODOS_TABLE).select().order('created_at', { ascending: action.order.ascending })

    client.queryLog.record({
      op: 'SELECT',
      label: `todos · ${action.label.toLowerCase()}`,
      rows: rows.length,
      ms: Date.now() - startedAt,
    })
    setBoardOrder(action.order)
  }

  // Delete every editable todo as one delete mutation each (registered rows the account can't write are skipped, like the per-row delete), so the list empties through the same engine path and each removal shows in the queue + log.
  function deleteAll(): void {
    for (const todo of editableTodos()) {
      const startedAt = Date.now()

      void mutate((k) => k.from(TODOS_TABLE).delete().eq('id', todo.id))
      client.queryLog.record({ op: 'DELETE', label: 'todos · delete all', rows: 1, ms: Date.now() - startedAt })
    }
  }

  // Insert the fixed predefined set as one insert mutation each; predefinedTodoStamps stamps each with a descending offset so they sort newest-first immediately, matching the add flow's local stamp.
  function createPredefined(): void {
    if (myId === null) {
      return
    }
    for (const { title, createdAt } of predefinedTodoStamps(Date.now())) {
      const startedAt = Date.now()

      void mutate((k) => k.from(TODOS_TABLE).insert({ title, done: false, user_id: myId, created_at: createdAt }))
      client.queryLog.record({ op: 'INSERT', label: 'todos · create predefined', rows: 1, ms: Date.now() - startedAt })
    }
  }

  // Append a heart to every editable todo's title as one update mutation each (skipping rows the account can't write), so every visible row changes through the same engine path as a per-row edit.
  function editAll(): void {
    for (const todo of editableTodos()) {
      const startedAt = Date.now()

      void mutate((k) => k.from(TODOS_TABLE).update({ title: withEditAllSuffix(todo.title) }).eq('id', todo.id))
      client.queryLog.record({ op: 'UPDATE', label: 'todos · edit all', rows: 1, ms: Date.now() - startedAt })
    }
  }

  // The one recovery from a soft-blocked checkpoint: reset() drops the local database, then a sync rehydrates it from the server.
  async function rebuildLocalDatabase(): Promise<void> {
    setIsResetting(true)

    try {
      await client.reset()
      await syncNow()
    } catch (cause) {
      onMessage(messageOf(cause))
    } finally {
      setIsResetting(false)
    }
  }

  return { runReadAction, deleteAll, createPredefined, editAll, rebuildLocalDatabase, isResetting }
}
