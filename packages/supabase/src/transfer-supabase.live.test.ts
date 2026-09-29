// MARK: - Optional live TUS E2E against a real Supabase project

/**
 * Live dual-path smoke for createSupabaseTransfer against a real Storage
 * endpoint. Skipped unless all of the following are set:
 *
 *   SUPABASE_URL:               project URL (https://….supabase.co or local)
 *   SUPABASE_PUBLISHABLE_KEY:   publishable (or authenticated user JWT) key
 *   SUPABASE_ANON_KEY:          accepted alias of the publishable key
 *   KSYNC_TUS_E2E=1:            explicit opt-in so CI never hits live Storage
 *
 * Optional:
 *   KSYNC_TUS_E2E_BUCKET:  Storage bucket (default: "todos")
 *
 * Prerequisites on the target project:
 * - Bucket exists and the credential may upload (public or RLS policy).
 * - Network reachability to the project Storage TUS endpoint.
 *
 * Run:
 *   KSYNC_TUS_E2E=1 SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… bun test packages/supabase/src/transfer-supabase.live.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { IFileStore } from '@kizunasync/core'
import { createSupabaseTransfer } from './transfer-supabase'
import { SINGLE_SHOT_MAX_BYTES } from './tus-client'

const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY
const enabled =
  process.env.KSYNC_TUS_E2E === '1' &&
  typeof process.env.SUPABASE_URL === 'string' &&
  process.env.SUPABASE_URL.length > 0 &&
  typeof publishableKey === 'string' &&
  publishableKey.length > 0

if (!enabled) {
  console.warn(
    '[transfer-supabase.live] SKIPPED: set KSYNC_TUS_E2E=1, SUPABASE_URL, and SUPABASE_PUBLISHABLE_KEY to run live TUS E2E.',
  )
}

const BUCKET = process.env.KSYNC_TUS_E2E_BUCKET ?? 'todos'
const OBJECT_PREFIX = `kizunasync-tus-e2e/${Date.now()}`

const memoryFileStore = (files: Map<string, Uint8Array>): IFileStore =>
  ({
    capabilities: { atomicRename: true, streams: true, quota: false, contentUris: false },
    read: async (path: string) => {
      const bytes = files.get(path)

      if (bytes === undefined) {
        throw new Error(`missing file ${path}`)
      }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
    writeAtomic: async (path: string, data: ArrayBuffer) => {
      files.set(path, new Uint8Array(data))
    },
  }) as unknown as IFileStore

let client: SupabaseClient | null = null
const uploadedPaths: string[] = []

if (enabled) {
  client = createClient(process.env.SUPABASE_URL!, publishableKey!)
}

afterAll(async () => {
  if (client === null || uploadedPaths.length === 0) {
    return
  }
  // Best-effort cleanup: live bucket may deny delete under RLS.
  await client.storage.from(BUCKET).remove(uploadedPaths).catch(() => undefined)
})

describe.skipIf(!enabled)('createSupabaseTransfer live Storage (opt-in)', () => {
  test('single-shot path uploads a small object', async () => {
    const path = `${OBJECT_PREFIX}/small.bin`

    uploadedPaths.push(path)
    const bytes = new Uint8Array(128).fill(0xab)
    const files = new Map<string, Uint8Array>([['small.bin', bytes]])
    const transfer = createSupabaseTransfer({
      client: client!,
      fileStore: memoryFileStore(files),
    })

    const handle = await transfer.createUpload(
      'small.bin',
      { bucket: BUCKET, path, contentType: 'application/octet-stream' },
      { sha256: 'live-small' },
    )

    expect(handle.resumable).toBe(false)
    await handle.done
  })

  test(
    'TUS path uploads an object larger than the single-shot threshold',
    async () => {
      const path = `${OBJECT_PREFIX}/large.bin`

      uploadedPaths.push(path)
      // One KiB over SINGLE_SHOT_MAX_BYTES, so the real TUS path runs without a multi-GB payload.
      const size = SINGLE_SHOT_MAX_BYTES + 1024
      const bytes = new Uint8Array(size)

      for (let i = 0; i < size; i += 1) {
        bytes[i] = i % 251
      }
      const files = new Map<string, Uint8Array>([['large.bin', bytes]])
      const transfer = createSupabaseTransfer({
        client: client!,
        fileStore: memoryFileStore(files),
      })

      const handle = await transfer.createUpload(
        'large.bin',
        { bucket: BUCKET, path, contentType: 'application/octet-stream' },
        { sha256: 'live-large' },
      )

      expect(handle.resumable).toBe(true)
      await handle.done
      expect(handle.fingerprint.length).toBeGreaterThan(0)
      expect(handle.fingerprint).toMatch(/^https?:\/\//)
    },
    // TUS over a 6 MiB+ body needs headroom on slow links.
    120_000,
  )
})
