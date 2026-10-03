/// <reference types="bun" />
/**
 * The two store calls the shared attachment queue needs from the Rust engine:
 * crash recovery and the shared-bytes count. Both cross the real NAPI bridge
 * here: a fake store would prove the queue's arithmetic, not that the real
 * `_kizunasync_attachments` answers to the `IAttachmentStore` contract.
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it there is no store to answer.
 */

import { describe, expect, test } from 'bun:test'
import { createAttachmentQueue } from '../host/attachment-queue'
import { createNapiAttachmentStore, type TEngineCall } from './napi-attachment-store'
import { loadNapiAddon, type INapiEngine } from './napi-loader'
import { sha256Hex } from '../util/sha256'
import type { IAttachmentStore } from '../host/attachment-queue'
import type { IFileStore } from '../ports/file-store'
import type { ITransfer } from '../ports/transfer'
import type { TAttachmentInsert } from '../host/attachment-queue'
import { EAttachmentState, type TEngineConfig } from '../wire/types'

const hasAddon = loadNapiAddon() !== null

const RUST_CONFIG = {
  tables: {
    items: {
      bucket_column: 'user_id',
      bucket_params: { user_id: 'u1' },
      attachments: { image_path: { storage_bucket: 'media', owner_column: 'user_id' } },
    },
  },
  schema_version: 1,
  default_limit: 500,
  client_id: 'napi-attachment-test',
}

const QUEUE_CONFIG: TEngineConfig = {
  schemaVersion: 1,
  tables: {
    items: {
      bucketColumn: 'user_id',
      attachments: { image_path: { storageBucket: 'media', ownerColumn: 'user_id' } },
    },
  },
}

/**
 * These tests never sync; a remote callback that is never called still has to
 * exist, so it answers with a refusal the engine never reads.
 */
const NO_REMOTE = JSON.stringify({ ok: false, message: 'no remote injected', retryable: false })

/** These queues never run fromFile, the one caller of the row write. */
const NO_ROW_WRITES = (): Promise<void> => Promise.reject(new Error('fromFile is not exercised here'))

type TCallEnvelope = { ok: true; value: unknown } | { ok: false; error: { message: string } }

type TBridge = {
  call: TEngineCall
  store: IAttachmentStore

  /**
   * The clock the ENGINE stamps rows with, the same envelope field
   * `createRustEngine` sets, moved by hand so a recovery can be dated.
   */
  setNow: (value: string) => void

  close: () => void
}

/** Unpadded base64url JSON, the encoding a JWT's header and claims take. */
const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The access token Supabase Auth issues to `sub`. The engine reads the claim and never checks the signature. */
const tokenOf = (sub: string): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub, role: 'authenticated' })}.c2lnbmF0dXJl`

const openBridge = async (): Promise<TBridge> => {
  const addon = loadNapiAddon()

  if (addon === null) {
    throw new Error('the native addon is required for this suite')
  }
  let now = '2020-01-01T00:00:00.000Z'
  const native: INapiEngine = new addon.KizunaSyncEngine(
    JSON.stringify(RUST_CONFIG),
    null,
    async () => NO_REMOTE,
    async () => NO_REMOTE,
    () => undefined,
  )
  const call: TEngineCall = async (method, params = {}) => {
    const raw = await native.call(
      method,
      JSON.stringify({ ...params, now, now_ms: Date.parse(now) }),
    )
    const envelope = JSON.parse(raw) as TCallEnvelope

    if (!envelope.ok) {
      throw new Error(envelope.error.message)
    }
    return envelope.value
  }

  // The store records the token's subject as its user, and only a ref under that user's segment is orphaned for the vacuum; a store that records no user evicts every ref and never asks Storage.
  await call('set_access_token', { token: tokenOf('u1') })

  return {
    call,
    store: createNapiAttachmentStore(call),
    setNow: (value) => {
      now = value
    },
    close: () => native.close(),
  }
}

const upload = (ref: string, localPath: string): TAttachmentInsert => ({
  ref,
  uploadId: ref,
  table: 'items',
  pk: 'p1',
  column: 'image_path',
  bucket: 'media',
  owner: 'u1',
  sha256: 'abc',
  contentType: 'image/png',
  size: 3,
  localPath,
  direction: 'upload',
  state: EAttachmentState.queued,
  createdAt: '2020-01-01T00:00:00.000Z',
})

// MARK: - Byte ports

const SHARED_BYTES = new Uint8Array([1, 2, 3])
const SHARED_PATH = `sandbox/${sha256Hex(SHARED_BYTES)}`

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)

  new Uint8Array(buffer).set(bytes)

  return buffer
}

const makeFileStore = (): { fileStore: IFileStore; files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>([[SHARED_PATH, SHARED_BYTES]])
  const fileStore: IFileStore = {
    capabilities: { atomicRename: true, streams: true, quota: false, contentUris: true },
    writeAtomic: async (path, data) => {
      files.set(path, new Uint8Array(data))
    },
    read: async (path) => toArrayBuffer(files.get(path) ?? new Uint8Array()),
    readRange: async (path, offset, length) =>
      toArrayBuffer((files.get(path) ?? new Uint8Array()).subarray(offset, offset + length)),
    exists: async (path) => files.has(path),
    stat: async (path) => {
      const bytes = files.get(path)

      return bytes === undefined ? null : { size: bytes.length, modifiedAt: 0 }
    },
    delete: async (path) => {
      files.delete(path)
    },
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
    sha256: async (path) => sha256Hex(files.get(path) ?? new Uint8Array()),
    importFromUri: async () => ({
      path: SHARED_PATH,
      sha256: sha256Hex(SHARED_BYTES),
      size: SHARED_BYTES.length,
      contentType: 'image/png',
    }),
    toUri: async (path) => `mem://${path}`,
  }

  return { fileStore, files }
}

const objectKey = (bucket: string, path: string): string => `${bucket}/${path}`

const makeTransfer = (
  files: Map<string, Uint8Array>,
): ITransfer & { objects: Map<string, Uint8Array>; removed: string[] } => {
  const objects = new Map<string, Uint8Array>()
  const removed: string[] = []

  return {
    objects,
    removed,
    createUpload: async (localPath, target) => {
      objects.set(objectKey(target.bucket, target.path), files.get(localPath) ?? new Uint8Array())

      return {
        resumable: false,
        fingerprint: '',
        progress: (async function* () {
          yield 100
        })(),
        done: Promise.resolve(),
        abort: async () => undefined,
      }
    },
    download: async () => undefined,
    confirm: async () => undefined,
    metadata: async () => null,
    remove: async (target) => {
      removed.push(objectKey(target.bucket, target.path))
      objects.delete(objectKey(target.bucket, target.path))
    },
  }
}

describe.skipIf(!hasAddon)('the Rust attachment store over NAPI', () => {
  // MARK: - Re-enqueue

  // A re-enqueue of the same ref is a FRESH job on the shipped store: every piece of transfer bookkeeping resets and only `created_at` survives, so a retry never resumes into the previous job's progress.
  test('enqueueing the same ref twice resets the job and keeps created_at', async () => {
    const bridge = await openBridge()

    try {
      const first = upload('u1/p1/a.png', SHARED_PATH)

      await bridge.store.enqueueAttachment(first)
      expect(await bridge.store.claimAttachment('u1/p1/a.png', 'uploading', 'T')).toBe(true)
      await bridge.store.updateAttachment(
        'u1/p1/a.png',
        { progress: 60, attempts: 3, error: 'network down', fingerprint: 'tus-1' },
        '2020-01-01T00:00:05.000Z',
      )

      bridge.setNow('2020-01-01T00:00:09.000Z')
      await bridge.store.enqueueAttachment({ ...first, createdAt: '2999-01-01T00:00:00.000Z' })

      expect(await bridge.store.getAttachment('u1/p1/a.png')).toMatchObject({
        state: EAttachmentState.queued,
        progress: 0,
        attempts: 0,
        error: null,
        inFlight: false,
        fingerprint: null,
        createdAt: first.createdAt,
      })
      expect((await bridge.store.pendingAttachments('upload')).map((entry) => entry.ref)).toEqual([
        'u1/p1/a.png',
      ])
    } finally {
      bridge.close()
    }
  })

  // MARK: - Crash recovery

  test('recoverInFlightAttachments releases a claim its process never finished', async () => {
    const bridge = await openBridge()

    try {
      await bridge.store.enqueueAttachment(upload('u1/p1/a.png', SHARED_PATH))
      expect(await bridge.store.claimAttachment('u1/p1/a.png', 'uploading', 'T')).toBe(true)

      // A claimed row is invisible to the drive AND unclaimable: the exact state a crashed transfer leaves behind forever.
      expect(await bridge.store.pendingAttachments('upload')).toEqual([])
      expect(await bridge.store.claimAttachment('u1/p1/a.png', 'uploading', 'T')).toBe(false)

      bridge.setNow('2020-01-01T00:00:09.000Z')
      // The argument is deliberately NOT the engine's clock: the bridge ignores it and the Rust store stamps the pinned envelope value instead.
      await bridge.store.recoverInFlightAttachments('1999-01-01T00:00:00.000Z')

      const recovered = await bridge.store.getAttachment('u1/p1/a.png')

      expect(recovered).toMatchObject({
        state: EAttachmentState.queued,
        inFlight: false,
        attempts: 0,
        updatedAt: '2020-01-01T00:00:09.000Z',
      })
      expect((await bridge.store.pendingAttachments('upload')).map((entry) => entry.ref)).toEqual([
        'u1/p1/a.png',
      ])
      expect(await bridge.store.claimAttachment('u1/p1/a.png', 'uploading', 'T')).toBe(true)
    } finally {
      bridge.close()
    }
  })

  test('a queue constructed over an existing engine recovers on construction', async () => {
    const bridge = await openBridge()

    try {
      await bridge.call('apply', {
        table: 'items',
        pk: 'p1',
        op: 'insert',
        mutation_id: 'm1',
        columns: { id: 'p1', user_id: 'u1', image_path: 'u1/p1/a.png' },
      })
      await bridge.store.enqueueAttachment(upload('u1/p1/a.png', SHARED_PATH))
      expect(await bridge.store.claimAttachment('u1/p1/a.png', 'uploading', 'T')).toBe(true)

      const { fileStore, files } = makeFileStore()
      const queue = createAttachmentQueue({
        store: bridge.store,
        config: QUEUE_CONFIG,
        fileStore,
        transfer: makeTransfer(files),
        apply: NO_ROW_WRITES,
        now: () => '2020-01-01T00:00:09.000Z',
        uuid: () => 'up-1',
      })

      // drive() reads the candidates AFTER the constructor's recovery call, so the row it could not see a moment ago is drainable again.
      await queue.drive()

      expect(await bridge.store.getAttachment('u1/p1/a.png')).toMatchObject({ state: EAttachmentState.synced })
    } finally {
      bridge.close()
    }
  })

  // MARK: - Shared bytes

  test('countLiveAttachmentsAtLocalPath counts live rows and honors the exclusion', async () => {
    const bridge = await openBridge()

    try {
      await bridge.store.enqueueAttachment(upload('u1/p1/a.png', SHARED_PATH))
      await bridge.store.enqueueAttachment(upload('u1/p1/b.png', SHARED_PATH))

      expect(await bridge.store.countLiveAttachmentsAtLocalPath(SHARED_PATH)).toBe(2)
      expect(await bridge.store.countLiveAttachmentsAtLocalPath(SHARED_PATH, 'u1/p1/a.png')).toBe(1)

      await bridge.store.markAttachmentOrphaned('u1/p1/b.png', 'T')
      expect(await bridge.store.countLiveAttachmentsAtLocalPath(SHARED_PATH)).toBe(1)
      expect(await bridge.store.countLiveAttachmentsAtLocalPath(SHARED_PATH, 'u1/p1/a.png')).toBe(0)
      expect(await bridge.store.countLiveAttachmentsAtLocalPath('sandbox/absent')).toBe(0)
    } finally {
      bridge.close()
    }
  })

  test('vacuum keeps content-addressed bytes a live row still shares', async () => {
    const bridge = await openBridge()

    try {
      const { fileStore, files } = makeFileStore()
      const transfer = makeTransfer(files)
      const queue = createAttachmentQueue({
        store: bridge.store,
        config: QUEUE_CONFIG,
        fileStore,
        transfer,
        apply: NO_ROW_WRITES,
        now: () => '2020-01-01T00:00:00.000Z',
        uuid: () => 'up-1',
      })

      // Two refs, ONE sandbox file: identical bytes imported twice is the whole point of content addressing.
      await bridge.store.enqueueAttachment(upload('u1/p1/a.png', SHARED_PATH))
      await bridge.store.enqueueAttachment(upload('u1/p1/b.png', SHARED_PATH))
      transfer.objects.set(objectKey('media', 'u1/p1/a.png'), SHARED_BYTES)
      transfer.objects.set(objectKey('media', 'u1/p1/b.png'), SHARED_BYTES)

      await bridge.store.markAttachmentOrphaned('u1/p1/a.png', 'T')
      await queue.vacuum()

      expect(transfer.objects.has(objectKey('media', 'u1/p1/a.png'))).toBe(false)
      expect(await bridge.store.getAttachment('u1/p1/a.png')).toBeNull()
      // The Storage object is one ref's; the bytes are both refs'.
      expect(files.has(SHARED_PATH)).toBe(true)
      expect(await queue.getStatus('u1/p1/b.png')).toMatchObject({
        localUri: `mem://${SHARED_PATH}`,
      })

      await bridge.store.markAttachmentOrphaned('u1/p1/b.png', 'T')
      await queue.vacuum()

      expect(await bridge.store.getAttachment('u1/p1/b.png')).toBeNull()
      expect(files.has(SHARED_PATH)).toBe(false)
    } finally {
      bridge.close()
    }
  })

  // MARK: - Owner rule

  test('an orphaned ref of another user is evicted and Storage is never asked', async () => {
    const bridge = await openBridge()

    try {
      const { fileStore, files } = makeFileStore()
      const transfer = makeTransfer(files)
      const queue = createAttachmentQueue({
        store: bridge.store,
        config: QUEUE_CONFIG,
        fileStore,
        transfer,
        apply: NO_ROW_WRITES,
        now: () => '2020-01-01T00:00:00.000Z',
        uuid: () => 'up-1',
      })
      const peerRef = 'u2/p9/peer.png'

      await bridge.store.enqueueAttachment({
        ...upload(peerRef, SHARED_PATH),
        pk: 'p9',
        owner: 'u2',
        direction: 'download',
        state: EAttachmentState.synced,
      })
      transfer.objects.set(objectKey('media', peerRef), SHARED_BYTES)

      await bridge.store.markAttachmentOrphaned(peerRef, 'T')
      expect(await bridge.store.getAttachment(peerRef)).toMatchObject({ state: EAttachmentState.evicted })

      await queue.vacuum()

      expect(transfer.removed).toEqual([])
      expect(transfer.objects.has(objectKey('media', peerRef))).toBe(true)
      expect(await bridge.store.getAttachment(peerRef)).toMatchObject({
        state: EAttachmentState.evicted,
        localPath: null,
      })
      expect(files.has(SHARED_PATH)).toBe(false)
    } finally {
      bridge.close()
    }
  })
})
