/**
 * The edit modal's local draft target and its one commit path: a new title and
 * a removed image go as one update through the same mutate path as
 * toggle/add, so they sync and reconcile normally; a replaced image is written
 * onto the row by the attachment port's fromFile.
 */

import { useState } from 'react'
import type { IKizunaSync } from '@kizunasync/core'
import { messageOf, TODOS_TABLE } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../../kizunasync'
import { attachImage } from '../../utils'
import type { ITodo, TImageEdit } from './types'

export interface IUseEditTodoParams {
  client: IKizunaSyncShim
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  onMessage: (message: string) => void
}

export interface IUseEditTodoResult {
  editing: ITodo | null
  requestEdit: (todo: ITodo) => void
  cancelEdit: () => void
  saveEdit: (id: string, nextTitle: string, image: TImageEdit) => Promise<void>
}

export function useEditTodo({ client, mutate, onMessage }: IUseEditTodoParams): IUseEditTodoResult {
  const [editing, setEditing] = useState<ITodo | null>(null)

  // A replace imports the picked file via the attachment port, whose fromFile writes the resulting REF into image_path (a normal synced column); a remove clears image_path in the update. Empty titles are ignored (keep the current one).
  async function saveEdit(id: string, nextTitle: string, image: TImageEdit): Promise<void> {
    try {
      const trimmed = nextTitle.trim()
      const changes: Record<string, string | null> = {}

      if (trimmed.length > 0) {
        changes.title = trimmed
      }
      if (image.kind === 'replace') {
        await attachImage(client, { pk: id, uri: image.localUri })
      } else if (image.kind === 'remove') {
        changes.image_path = null
      }
      if (Object.keys(changes).length > 0) {
        const startedAt = Date.now()

        await mutate((k) => k.from(TODOS_TABLE).update(changes).eq('id', id))
        client.queryLog.record({
          op: 'UPDATE',
          label: 'todos · edit',
          rows: 1,
          ms: Date.now() - startedAt,
        })
      }
      setEditing(null)
    } catch (cause) {
      onMessage(messageOf(cause))
    }
  }

  return { editing, requestEdit: setEditing, cancelEdit: () => setEditing(null), saveEdit }
}
