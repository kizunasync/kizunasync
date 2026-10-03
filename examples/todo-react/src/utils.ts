import { TODOS_TABLE } from '@kizunasync/utilities'
import type { IKizunaSyncShim } from './kizunasync'

/**
 * Browser file picker → a device-local object URL the attachment port imports
 * on Save (fromFile fetches the blob, hashes it, enqueues the upload, and
 * writes the ref onto the row).
 */
export function pickImageFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')

    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null

      resolve(file === null ? null : URL.createObjectURL(file))
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

/** Attaches a picked image to a todo: fromFile writes its ref into image_path, and the query log shows that write. */
export async function attachImage(client: IKizunaSyncShim, target: { pk: string; uri: string }): Promise<void> {
  const startedAt = Date.now()

  await client.attachments.fromFile({ table: TODOS_TABLE, column: 'image_path', pk: target.pk, uri: target.uri })
  client.queryLog.record({ op: 'UPDATE', label: 'todos · attach image', rows: 1, ms: Date.now() - startedAt })
}
