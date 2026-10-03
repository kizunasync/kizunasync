/**
 * The add-todo form: title + optional staged image. Submit mints the pk
 * client-side (so the attachment port can reference the row before the
 * insert round-trips), stamps created_at locally so the row sorts
 * newest-first before any sync, and attaches a staged image after the insert
 * (the row must exist first).
 */

import { ref, type Ref } from 'vue'
import type { TColumnValues } from '@kizunasync/core'
import { TODOS_TABLE } from '@kizunasync/utilities'
import { previewUrlForFile, type IKizunaSyncShim } from '../kizunasync'
import type { TMutate } from './types'

export function useTodoComposer({
  client,
  myId,
  mutate,
}: {
  client: IKizunaSyncShim
  myId: Ref<string | null>
  mutate: TMutate
}) {
  const title = ref('')
  const addImageUri = ref<string | null>(null)
  const addFileInput = ref<HTMLInputElement | null>(null)

  // Mint the pk client-side so the attachment port can reference the row before the insert round-trips (insert-before-pick: fromFile reads the row's owner).
  async function submit(): Promise<void> {
    const trimmed = title.value.trim()
    const ownerId = myId.value

    if (trimmed.length === 0 || ownerId === null) {
      return
    }
    const id = crypto.randomUUID()
    const pickedUri = addImageUri.value
    const values: TColumnValues = {
      id,
      title: trimmed,
      done: false,
      user_id: ownerId,
      image_path: null,
      // Stamp locally so the row sorts newest-first immediately (local-first), before any sync round-trip fills it server-side.
      created_at: new Date().toISOString(),
    }

    // RLS with-check requires user_id = the signed-in auth uid on insert.
    await mutate(async (k) => {
      await k.from(TODOS_TABLE).insert(values)

      if (pickedUri !== null) {
        await client.attachments.fromFile({
          table: TODOS_TABLE,
          column: 'image_path',
          pk: id,
          uri: pickedUri,
        })
      }
    }, 'INSERT', 'todos · add')
    title.value = ''
    addImageUri.value = null
  }

  function pickAddImage(): void {
    addFileInput.value?.click()
  }

  function onAddImagePicked(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null

    if (file === null) {
      return
    }
    addImageUri.value = previewUrlForFile(file)
  }

  return { title, addImageUri, addFileInput, submit, pickAddImage, onAddImagePicked }
}
