/**
 * The public barrel's type surface. Types leave no trace at runtime, so the
 * package type-check is what fails when one of these exports goes missing.
 */

import { describe, expect, test } from 'bun:test'
import type { TTusUploadOptions, TTusUploadResult } from './index'

describe('@kizunasync/supabase type exports', () => {
  test('TTusUploadResult names what tusUpload resolves', () => {
    const result: TTusUploadResult = { uploadUrl: 'https://abc.supabase.co/storage/v1/upload/resumable/1', bytesUploaded: 0 }

    expect(result.bytesUploaded).toBe(0)
  })

  test('TTusUploadOptions names what tusUpload takes', () => {
    const options: TTusUploadOptions = {
      endpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
      accessToken: 'token',
      bucket: 'todos',
      objectName: 'owner/row/upload.png',
      contentType: 'image/png',
      data: new Uint8Array(0),
    }

    expect(options.bucket).toBe('todos')
  })
})
