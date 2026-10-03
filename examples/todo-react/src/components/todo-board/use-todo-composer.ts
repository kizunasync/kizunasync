/**
 * The add-todo form: title + optional staged image. Submit mints the pk
 * client-side (so the attachment port can reference the row before the
 * insert round-trips), stamps created_at locally so the row sorts
 * newest-first before any sync, and attaches a staged image after the insert
 * (the row must exist first).
 */

import { useState } from 'react'
import type { IKizunaSync } from '@kizunasync/core'
import { TODOS_TABLE } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from '../../kizunasync'
import { attachImage } from '../../utils'

export interface IUseTodoComposerParams {
  client: IKizunaSyncShim
  myId: string | null
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
}

export interface IUseTodoComposerResult {
  title: string
  setTitle: (value: string) => void
  addImageUri: string | null
  setAddImageUri: (value: string | null) => void
  submit: () => void
}

export function useTodoComposer({ client, myId, mutate }: IUseTodoComposerParams): IUseTodoComposerResult {
  const [title, setTitle] = useState('')
  const [addImageUri, setAddImageUri] = useState<string | null>(null)

  function submit(): void {
    const trimmed = title.trim()

    if (trimmed.length === 0 || myId === null) {
      return
    }
    // Mint the pk client-side so the attachment port can reference the row before the insert round-trips (insert-then-attach: fromFile reads the row's owner).
    const id = crypto.randomUUID()
    const pickedUri = addImageUri
    const startedAt = Date.now()

    // RLS with-check requires user_id = the signed-in auth uid on insert. created_at is stamped locally so the row sorts newest-first immediately, before any sync (the server default only covers a push that omits it). A staged image attaches AFTER the insert (the row must exist first): fromFile imports the picked file via the attachment port and writes the REF into image_path, a normal synced column.
    void mutate(async (k) => {
      await k
        .from(TODOS_TABLE)
        .insert({ id, title: trimmed, done: false, user_id: myId, created_at: new Date().toISOString() })

      if (pickedUri !== null) {
        await attachImage(client, { pk: id, uri: pickedUri })
      }
    })
    client.queryLog.record({ op: 'INSERT', label: 'todos · add', rows: 1, ms: Date.now() - startedAt })
    setTitle('')
    setAddImageUri(null)
  }

  return { title, setTitle, addImageUri, setAddImageUri, submit }
}
