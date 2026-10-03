import { useCallback, useRef, useState } from 'react'
import type { IKizunaSync, TColumnValues } from '@kizunasync/core'
import { TODOS_TABLE } from '@kizunasync/utilities'
import { editTodo, getQueryLog, type ITodo, type ITodoEdit } from '../kizunasync-shim'
import { pickImageUri } from '../lib/pick-image'
import { newTodoId } from '../lib/todos'

/**
 * Compose and edit a todo's title + image, both funneled through the same
 * mutate path as toggle/delete. `submit` mints the pk client-side so the
 * attachment port can reference the row before the insert round-trips, then
 * attaches a staged image; `saveEdit` sends a new title or a removed image as
 * one update, and a replaced image lands through fromFile. A guard ref stops `submit`'s double-fire (the field's
 * onSubmitEditing and the button's onPress can both land) from minting two
 * rows (@CONVENTIONS.md).
 */
export interface ITodoComposer {
  title: string
  setTitle: (value: string) => void
  imageUri: string | null
  pickImage: () => Promise<void>
  submit: () => Promise<void>
  editing: ITodo | null
  setEditing: (todo: ITodo | null) => void
  saveEdit: (edit: { title?: string; image?: string | null }) => Promise<void>
}

export function useTodoComposer({
  myId,
  mutate,
  client,
}: {
  myId: string | null
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  client: IKizunaSync
}): ITodoComposer {
  const [title, setTitle] = useState('')
  const [imageUri, setImageUri] = useState<string | null>(null)

  const pickImage = useCallback(async () => {
    const uri = await pickImageUri()

    if (uri !== null) {
      setImageUri(uri)
    }
  }, [])

  // EditTodoModal's own flow: the row being edited and committing its title/image. Split out so this hook's own body stays readable alongside the add flow above (@CONVENTIONS.md).
  const { editing, setEditing, saveEdit } = useEditTodoFlow({ mutate, client })

  // Guards a double-tap (the button's onPress + the field's onSubmitEditing both fire) from minting two ids and inserting two rows.
  const submittingRef = useRef(false)
  const submit = useCallback(async () => {
    const trimmed = title.trim()

    if (trimmed.length === 0 || submittingRef.current) {
      return
    }
    submittingRef.current = true
    // Mint the pk client-side so the attachment port can reference the row before the insert round-trips (insert-before-pick: fromFile reads the row's owner).
    const id = newTodoId()
    const pickedUri = imageUri
    // The fenced RPC push enforces RLS-with-check: the insert must carry user_id = the signed-in auth uid or the server rejects it.
    const values: TColumnValues = {
      id,
      title: trimmed,
      done: false,
      image_path: null,
      user_id: myId ?? '',
      created_at: new Date().toISOString(),
    }

    getQueryLog().record({ op: 'INSERT', label: 'todos · add', rows: 1 })
    await mutate(async (k) => {
      await k.from(TODOS_TABLE).insert(values)

      if (pickedUri !== null) {
        await attachImage(client, { pk: id, uri: pickedUri })
      }
    })
    setTitle('')
    setImageUri(null)
    submittingRef.current = false
  }, [title, imageUri, myId, mutate, client])

  return { title, setTitle, imageUri, pickImage, submit, editing, setEditing, saveEdit }
}

// MARK: - internal

/** Attaches a picked image to a todo: fromFile writes its ref into image_path, and the query log shows that write. */
async function attachImage(client: IKizunaSync, target: { pk: string; uri: string }): Promise<void> {
  await client.attachments.fromFile({ table: TODOS_TABLE, column: 'image_path', pk: target.pk, uri: target.uri })
  getQueryLog().record({ op: 'UPDATE', label: 'todos · attach image', rows: 1 })
}

/** `EditTodoModal`'s own flow: the row being edited and committing its title and image. */
function useEditTodoFlow({
  mutate,
  client,
}: {
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  client: IKizunaSync
}): {
  editing: ITodo | null
  setEditing: (todo: ITodo | null) => void
  saveEdit: (edit: { title?: string; image?: string | null }) => Promise<void>
} {
  const [editing, setEditing] = useState<ITodo | null>(null)

  // Commit a row's edited title and a removed image as one update through the same mutate path as toggle/add, so it syncs and reconciles normally. A replace imports the picked file via the attachment port, whose fromFile writes the resulting REF into image_path (a normal synced column). Empty titles are ignored (keep the current one).
  const saveEdit = useCallback(
    async (edit: { title?: string; image?: string | null }) => {
      const target = editing

      if (target === null) {
        return
      }
      setEditing(null)
      // A picked image lands first: fromFile writes its attachment REF into image_path, a normal synced column (the engine's sync() funnel uploads the bytes afterward).
      const todoEdit: ITodoEdit = {}

      if (edit.title !== undefined) {
        todoEdit.title = edit.title
      }
      if (edit.image === null) {
        todoEdit.imagePath = null
      } else if (typeof edit.image === 'string') {
        await attachImage(client, { pk: target.id, uri: edit.image })
      }
      if (Object.keys(todoEdit).length === 0) {
        return
      }
      await mutate((k) => editTodo(k, target.id, todoEdit))
    },
    [editing, mutate, client],
  )

  return { editing, setEditing, saveEdit }
}
