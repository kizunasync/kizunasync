// MARK: - Attachment queue state machine

/**
 * fromFile → drive → confirm, the upload re-guard (orphan a dead object),
 * vacuum GC, and the lazy verified download. Map-backed IFileStore and a fake
 * ITransfer; no platform driver. fromFile writes the reference onto the row
 * through the injected local write, which the fake applies to its own rows.
 *
 * Durable state goes through `IAttachmentStore`. The shipped implementation
 * is the Rust store; `napi-attachment.test.ts` drives it across the real
 * bridge and is where `_kizunasync_attachments` answers belong. This file fakes
 * the port and checks the queue's arithmetic while the bytes still move.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createAttachmentQueue, DEFAULT_ATTACHMENT_ATTEMPTS, type IAttachmentQueue } from './attachment-queue'
import { sha256Hex } from '../util/sha256'
import { createSignedUrlDownload } from '../util/signed-url-download'
import { ETransferError, type ITransfer } from '../ports/transfer'
import type { IAttachmentStore, TAttachmentEntry, TAttachmentInsert, TAttachmentPatch, TAttachmentStatus } from './attachment-queue'
import type { IFileStore } from '../ports/file-store'
import { EAttachmentState, EEngineErrorCode, TEngineError, type TAttachmentState, type TColumnValues, type TEngineConfig, type TLocalMutation } from '../wire/types'

const CONFIG: TEngineConfig = {
  schemaVersion: 1,
  tables: {
    todos: {
      bucketColumn: '',
      attachments: { image_path: { storageBucket: 'todos', ownerColumn: 'user_id' } },
    },
  },
}

// MARK: - Map-backed IAttachmentStore

/**
 * The port plus the row seeding the cases need. Mirrors the shipped store's
 * semantics where the queue can observe them: the claim is a compare-and-set
 * that counts an attempt at the claim exactly as `keep_claim_within_budget`
 * does, an enqueue over an existing ref follows `put_attachment`'s
 * `ON CONFLICT(ref)` clause, a live row clears its tombstone shadow, the
 * vacuum's read lists orphaned rows and evicted rows that still name their
 * bytes, and the pending and vacuum reads are ordered by createdAt then ref.
 */
interface ITestAttachmentStore extends IAttachmentStore {
  putRow(table: string, pk: string, row: TColumnValues): void
  deleteRow(table: string, pk: string): void
  putTombstone(table: string, pk: string): void
}

const rowKey = (table: string, pk: string): string => `${table}\x00${pk}`

const byCreatedAtThenRef = (left: TAttachmentEntry, right: TAttachmentEntry): number =>
  left.createdAt === right.createdAt
    ? left.ref.localeCompare(right.ref)
    : left.createdAt.localeCompare(right.createdAt)

const freshStore = (budget = DEFAULT_ATTACHMENT_ATTEMPTS): ITestAttachmentStore => {
  const rows = new Map<string, TColumnValues>()
  const tombstones = new Set<string>()
  const attachments = new Map<string, TAttachmentEntry>()

  const patchEntry = (ref: string, patch: TAttachmentPatch, now: string): void => {
    const entry = attachments.get(ref)

    if (entry === undefined) {
      return
    }
    for (const [field, value] of Object.entries(patch) as [keyof TAttachmentPatch, unknown][]) {
      if (value !== undefined) {
        Object.assign(entry, { [field]: value })
      }
    }
    entry.updatedAt = now
  }

  return {
    putRow: (table, pk, row) => {
      rows.set(rowKey(table, pk), { ...row })
      tombstones.delete(rowKey(table, pk))
    },
    deleteRow: (table, pk) => {
      rows.delete(rowKey(table, pk))
    },
    putTombstone: (table, pk) => {
      tombstones.add(rowKey(table, pk))
    },

    getRow: async (table, pk) => rows.get(rowKey(table, pk)) ?? null,
    hasTombstone: async (table, pk) => tombstones.has(rowKey(table, pk)),

    // Mirrors `put_attachment`'s `ON CONFLICT(ref) DO UPDATE` clause term for term (`crates/kizunasync-store/src/store/attachments.rs:107-135`). `createNapiAttachmentStore` sends the `attachment_put` RPC; `crates/kizunasync-engine/src/rpc.rs` dispatches it to `put_attachment`. JavaScript never calls `attachment_enqueue`, whose clause COALESCEs. Mirroring that one would pass here and fail on the shipped store. A re-enqueue is a FRESH job: every column is overwritten from the new insert, and transfer bookkeeping resets. The adapter sends `entry.x ?? null`, so an omitted field arrives as an explicit null and overwrites; it does not coalesce. `createdAt` is the only column the clause leaves alone.
    enqueueAttachment: async (entry: TAttachmentInsert) => {
      const createdAt = attachments.get(entry.ref)?.createdAt ?? entry.createdAt

      attachments.set(entry.ref, {
        ...entry,
        sha256: entry.sha256 ?? null,
        contentType: entry.contentType ?? null,
        size: entry.size ?? null,
        localPath: entry.localPath ?? null,
        inFlight: false,
        fingerprint: null,
        progress: 0,
        attempts: 0,
        permanent: false,
        error: null,
        errorCode: null,
        createdAt,
        updatedAt: entry.createdAt,
      })
    },
    getAttachment: async (ref) => {
      const entry = attachments.get(ref)

      return entry === undefined ? null : { ...entry }
    },
    pendingAttachments: async (direction) =>
      [...attachments.values()]
        .filter(
          (entry) =>
            entry.direction === direction &&
            !entry.inFlight &&
            !entry.permanent &&
            (entry.state === EAttachmentState.queued || entry.state === EAttachmentState.failed),
        )
        .sort(byCreatedAtThenRef)
        .map((entry) => ({ ...entry })),
    claimAttachment: async (ref, state: TAttachmentState, now) => {
      const entry = attachments.get(ref)

      if (entry === undefined || entry.inFlight || entry.permanent) {
        return false
      }
      // `keep_claim_within_budget`: the claim is the moment the budget is charged. A row that already spent it is stopped here, not driven, so the claim the budget discovered is not itself an attempt.
      if (entry.attempts >= budget) {
        entry.state = 'failed'
        entry.permanent = true
        entry.inFlight = false
        entry.updatedAt = now

        return false
      }
      entry.inFlight = true
      entry.state = state
      entry.updatedAt = now

      return true
    },
    updateAttachment: async (ref, patch, now) => {
      patchEntry(ref, patch, now)
    },
    markAttachmentOrphaned: async (ref, now) => {
      patchEntry(ref, { state: EAttachmentState.orphaned, inFlight: false }, now)
    },
    orphanedAttachments: async () =>
      [...attachments.values()]
        .filter(
          (entry) =>
            entry.state === EAttachmentState.orphaned ||
            (entry.state === EAttachmentState.evicted && entry.localPath !== null),
        )
        .sort(byCreatedAtThenRef)
        .map((entry) => ({ ...entry })),
    purgeAttachment: async (ref) => {
      attachments.delete(ref)
    },
    retryAttachment: async (ref) => {
      const entry = attachments.get(ref)

      if (entry === undefined) {
        return false
      }
      Object.assign(entry, {
        state: EAttachmentState.queued,
        permanent: false,
        attempts: 0,
        inFlight: false,
        error: null,
        errorCode: null,
      })

      return true
    },
    cancelAttachment: async (ref) => {
      const entry = attachments.get(ref)

      if (entry === undefined) {
        return false
      }
      Object.assign(entry, { state: EAttachmentState.failed, inFlight: false, permanent: false })

      return true
    },
    removeAttachment: async (ref) => {
      const localPath = attachments.get(ref)?.localPath ?? null

      attachments.delete(ref)

      return localPath
    },
    recoverInFlightAttachments: async (now) => {
      for (const entry of attachments.values()) {
        if (entry.inFlight || entry.state === EAttachmentState.uploading || entry.state === EAttachmentState.downloading) {
          entry.inFlight = false
          entry.state = 'queued'
          entry.updatedAt = now
        }
      }
    },
    countLiveAttachmentsAtLocalPath: async (localPath, excludingRef) =>
      [...attachments.values()].filter(
        (entry) =>
          entry.localPath === localPath &&
          entry.state !== EAttachmentState.orphaned &&
          entry.state !== EAttachmentState.evicted &&
          entry.ref !== excludingRef,
      ).length,
  }
}

/** The engine's local update, applied to the fake's rows: each column the mutation carries replaces the row's. */
const writeRowsOf = (store: ITestAttachmentStore): ((mutation: TLocalMutation) => Promise<void>) => async (mutation) => {
  const row = await store.getRow(mutation.table, mutation.pk)

  store.putRow(mutation.table, mutation.pk, { ...row, ...mutation.columns })
}

const toArrayBuffer = (u8: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(u8.byteLength)

  new Uint8Array(buffer).set(u8)

  return buffer
}

const makeFileStore = (
  sources: Record<string, { bytes: Uint8Array; contentType: string | null }>,
): { fs: IFileStore; files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>()
  const fs: IFileStore = {
    capabilities: { atomicRename: true, streams: true, quota: false, contentUris: true },
    writeAtomic: async (path, data) => {
      files.set(path, new Uint8Array(data))
    },
    read: async (path) => toArrayBuffer(files.get(path)!),
    readRange: async (path, offset, length) =>
      toArrayBuffer(files.get(path)!.subarray(offset, offset + length)),
    exists: async (path) => files.has(path),
    stat: async (path) => {
      const bytes = files.get(path)

      return bytes === undefined ? null : { size: bytes.length, modifiedAt: 0 }
    },
    delete: async (path) => {
      files.delete(path)
    },
    list: async (prefix) => [...files.keys()].filter((key) => key.startsWith(prefix)),
    sha256: async (path) => sha256Hex(files.get(path)!),
    importFromUri: async (uri) => {
      const source = sources[uri]

      if (source === undefined) {
        throw new Error(`no source registered for ${uri}`)
      }
      const sha = sha256Hex(source.bytes)
      const path = `sandbox/${sha}`

      files.set(path, source.bytes)

      return { path, sha256: sha, size: source.bytes.length, contentType: source.contentType }
    },
    toUri: async (path) => `mem://${path}`,
  }

  return { fs, files }
}

type TFakeTransfer = ITransfer & {
  objects: Map<string, Uint8Array>
  meta: Map<string, { sha256: string }>
}

const makeTransfer = (files: Map<string, Uint8Array>): TFakeTransfer => {
  const objects = new Map<string, Uint8Array>()
  const meta = new Map<string, { sha256: string }>()
  const key = (bucket: string, path: string): string => `${bucket}/${path}`

  return {
    objects,
    meta,
    createUpload: async (localPath, target) => {
      objects.set(key(target.bucket, target.path), files.get(localPath)!)

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
    download: async (target, toLocalPath, options) => {
      const bytes = objects.get(key(target.bucket, target.path))

      if (bytes === undefined) {
        throw Object.assign(new Error('not yet available'), { code: ETransferError.notYetAvailable })
      }
      if (options?.sha256 !== undefined && sha256Hex(bytes) !== options.sha256) {
        throw new Error('sha256 mismatch')
      }
      files.set(toLocalPath, bytes)
    },
    confirm: async (target, m) => {
      meta.set(target.path, { sha256: m.sha256 })
    },
    metadata: async (target) => meta.get(target.path) ?? null,
    remove: async (target) => {
      objects.delete(key(target.bucket, target.path))
    },
  }
}

const setup = (
  sources: Record<string, { bytes: Uint8Array; contentType: string | null }>,
  makeApply: (store: ITestAttachmentStore) => (mutation: TLocalMutation) => Promise<void> = writeRowsOf,
) => {
  const store = freshStore()
  const { fs, files } = makeFileStore(sources)
  const transfer = makeTransfer(files)
  let counter = 0
  const queue = createAttachmentQueue({
    store,
    config: CONFIG,
    fileStore: fs,
    transfer,
    apply: makeApply(store),
    now: () => 'T',
    uuid: () => `up-${++counter}`,
  })

  return { store, fs, files, transfer, queue }
}

const PNG = { bytes: new Uint8Array([1, 2, 3, 4, 5]), contentType: 'image/png' }

/** The uuid owner and primary keys an import names its object from. */
const OWNER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const PK = '0f8fad5b-d9cb-469f-a165-70867728950e'
const PK_2 = '4b3a1f0e-2c9d-4e8f-9a7b-6c5d4e3f2a1b'

describe('attachment queue', () => {
  test('fromFile enqueues; drive uploads, confirms, and marks synced', async () => {
    const { store, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER, title: 'x' })

    const result = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    expect(result.ref).toBe(`${OWNER}/${PK}/up-1.png`)
    expect(result.sha256).toBe(sha256Hex(PNG.bytes))
    expect(result.localUri).toBe(`mem://sandbox/${result.sha256}`)
    expect((await store.getAttachment(result.ref))?.state).toBe('queued')

    await queue.drive()

    const synced = await store.getAttachment(result.ref)

    expect(synced?.state).toBe('synced')
    expect(synced?.errorCode).toBeNull()
    expect(synced?.localPath).toBe(`sandbox/${result.sha256}`) // sandbox kept as cache
    expect(transfer.objects.has(`todos/${result.ref}`)).toBe(true)
    expect(transfer.meta.get(result.ref)?.sha256).toBe(result.sha256)
  })

  test('drive releases (does not orphan) an upload whose row column no longer carries the ref', async () => {
    const { store, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    // A later local write cleared the column before the drive ran.
    store.putRow('todos', PK, { user_id: OWNER })
    await queue.drive()

    const releasedEntry = await store.getAttachment(ref)

    expect(releasedEntry?.state).toBe('queued') // retryable, NOT orphaned
    expect(releasedEntry?.inFlight).toBe(false)
    expect(transfer.objects.has(`todos/${ref}`)).toBe(false) // never uploaded

    // The column carries the ref again, and the next drive() succeeds.
    store.putRow('todos', PK, { user_id: OWNER, image_path: ref })
    await queue.drive()
    expect((await store.getAttachment(ref))?.state).toBe('synced')
  })

  test('drive releases, never orphans, an upload whose row was deleted before it ran', async () => {
    const { store, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    // The delete may still be this device's own queued write: only the kernel's pull or verdict decides the object is garbage.
    store.deleteRow('todos', PK)
    store.putTombstone('todos', PK)

    await queue.drive()

    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.queued, inFlight: false })
    expect(transfer.objects.has(`todos/${ref}`)).toBe(false)
  })

  test('drive releases, never orphans, an upload whose row carries another ref', async () => {
    const { store, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    store.putRow('todos', PK, { user_id: OWNER, image_path: `${OWNER}/${PK}/older.png` })

    await queue.drive()

    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.queued, inFlight: false })
    expect(transfer.objects.has(`todos/${ref}`)).toBe(false)
  })

  test('fromFile refuses an owner or a primary key that is not a uuid', async () => {
    const { store, files, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: '../owner-1' })
    store.putRow('todos', 'p1', { user_id: OWNER })

    for (const pk of [PK, 'p1']) {
      const refused = await queue.fromFile({ table: 'todos', column: 'image_path', pk, uri: 'pick://a' }).then(
        () => null,
        (error: unknown) => error,
      )

      expect(refused).toBeInstanceOf(TEngineError)
      expect((refused as TEngineError).code).toBe(EEngineErrorCode.LOCAL_CONSTRAINT)
    }
    expect(await store.pendingAttachments('upload')).toEqual([])
    expect(files.size).toBe(0)
  })

  test('fromFile writes the ref onto the row as one local update of its column', async () => {
    const applied: TLocalMutation[] = []
    const { store, queue } = setup({ 'pick://a': PNG }, (target) => async (mutation) => {
      applied.push(mutation)
      await writeRowsOf(target)(mutation)
    })

    store.putRow('todos', PK, { user_id: OWNER, title: 'x' })
    const result = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    expect(result).toEqual({
      ref: `${OWNER}/${PK}/up-1.png`,
      sha256: sha256Hex(PNG.bytes),
      size: PNG.bytes.length,
      mediaType: 'image/png',
      localUri: `mem://sandbox/${sha256Hex(PNG.bytes)}`,
    })
    expect(applied).toEqual([{ table: 'todos', pk: PK, op: 'update', columns: { image_path: result.ref } }])
    expect(await store.getRow('todos', PK)).toEqual({ user_id: OWNER, title: 'x', image_path: result.ref })
    expect((await store.getAttachment(result.ref))?.state).toBe(EAttachmentState.queued)
  })

  test('a fromFile whose row write fails rejects with that failure and evicts the job, so its bytes go without asking Storage', async () => {
    const refusal = new TEngineError(EEngineErrorCode.LOCAL_CONSTRAINT, 'the row refused the column')
    const { store, files, transfer, queue } = setup({ 'pick://a': PNG }, () => async () => {
      throw refusal
    })
    const removed: string[] = []

    transfer.remove = async (target) => {
      removed.push(target.path)
    }
    store.putRow('todos', PK, { user_id: OWNER })
    const failure = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' }).then(
      () => null,
      (error: unknown) => error,
    )
    const ref = `${OWNER}/${PK}/up-1.png`

    expect(failure).toBe(refusal)
    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.evicted, inFlight: false, error: null, errorCode: null })
    expect(await store.pendingAttachments('upload')).toEqual([])

    await queue.vacuum()

    expect(removed).toEqual([])
    expect(files.size).toBe(0)
    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.evicted, localPath: null })
  })

  test('fromFile on a row that does not exist rejects with ATTACHMENT_ROW_GONE and writes nothing', async () => {
    const applied: TLocalMutation[] = []
    const { store, files, queue } = setup({ 'pick://a': PNG }, () => async (mutation) => {
      applied.push(mutation)
    })
    const refused = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(refused).toBeInstanceOf(TEngineError)
    expect((refused as TEngineError).code).toBe(EEngineErrorCode.ATTACHMENT_ROW_GONE)
    expect(applied).toEqual([])
    expect(await store.pendingAttachments('upload')).toEqual([])
    expect(files.size).toBe(0)
  })

  test('vacuum removes the orphaned Storage object and purges the row', async () => {
    const { store, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER, image_path: '' })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    await queue.drive()
    expect(transfer.objects.has(`todos/${ref}`)).toBe(true)

    await store.markAttachmentOrphaned(ref, 'T')
    await queue.vacuum()

    expect(transfer.objects.has(`todos/${ref}`)).toBe(false)
    expect(await store.getAttachment(ref)).toBeNull()
  })

  test('a fresh queue recovers a crashed in-flight upload and completes it', async () => {
    const { store, fs, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    // Simulate a crash mid-upload: claimed (in_flight=1) but the process died before finishing, never released back to a retryable state.
    await store.claimAttachment(ref, 'uploading', 'T')
    expect((await store.getAttachment(ref))?.inFlight).toBe(true)

    // A fresh engine opens the SAME (existing) DB, so construction alone must recover it.
    const recovered = createAttachmentQueue({
      store, config: CONFIG, fileStore: fs, transfer, apply: writeRowsOf(store), now: () => 'T2', uuid: () => 'up-recovered',
    })

    await recovered.drive()

    const entry = await store.getAttachment(ref)

    expect(entry?.state).toBe('synced')
    expect(transfer.objects.has(`todos/${ref}`)).toBe(true)
  })

  test('vacuum records a remove failure and retries instead of leaking + purging', async () => {
    const { store, transfer, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })

    await queue.drive()
    expect(transfer.objects.has(`todos/${ref}`)).toBe(true)
    await store.markAttachmentOrphaned(ref, 'T')

    const originalRemove = transfer.remove

    transfer.remove = async () => {
      throw new Error('network down')
    }
    await queue.vacuum()

    const afterFailedVacuum = await store.getAttachment(ref)

    expect(afterFailedVacuum?.state).toBe('orphaned') // not purged
    expect(afterFailedVacuum?.attempts).toBe(1)
    expect(afterFailedVacuum?.error).toBe('network down')
    expect(afterFailedVacuum?.errorCode).toBe(EEngineErrorCode.TRANSFER)
    expect(transfer.objects.has(`todos/${ref}`)).toBe(true) // remote object NOT leaked-purged

    transfer.remove = originalRemove
    await queue.vacuum()

    expect(await store.getAttachment(ref)).toBeNull() // purged once remove succeeds
    expect(transfer.objects.has(`todos/${ref}`)).toBe(false)
  })

  test('vacuum keeps sandbox bytes another live ref still shares (content-addressed)', async () => {
    const { store, files, transfer, queue } = setup({ 'pick://a': PNG, 'pick://b': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    store.putRow('todos', PK_2, { user_id: OWNER })
    const a = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })
    const b = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK_2, uri: 'pick://b' })

    expect(a.localUri).toBe(b.localUri) // identical bytes ⇒ same content-addressed sandbox path
    await queue.drive()
    const sandboxPath = `sandbox/${a.sha256}`

    expect(files.has(sandboxPath)).toBe(true)

    // p1's ref is superseded/orphaned; p2's ref (SAME bytes) is still live.
    await store.markAttachmentOrphaned(a.ref, 'T')
    await queue.vacuum()

    expect(await store.getAttachment(a.ref)).toBeNull() // row purged
    expect(transfer.objects.has(`todos/${a.ref}`)).toBe(false) // its remote object removed
    expect(files.has(sandboxPath)).toBe(true) // bytes kept: b.ref still references them
    expect((await store.getAttachment(b.ref))?.localPath).toBe(sandboxPath)
  })

  test('resolveDownload lazily fetches + verifies a peer ref', async () => {
    const { store, transfer, queue, files } = setup({})
    // The peer already uploaded + confirmed this object.
    const ref = 'owner-2/p9/up-9.png'

    transfer.objects.set(`todos/${ref}`, PNG.bytes)
    transfer.meta.set(ref, { sha256: sha256Hex(PNG.bytes) })
    // The pull-apply scheduled a download entry for it.
    await store.enqueueAttachment({
      ref,
      uploadId: 'up-9',
      table: 'todos',
      pk: 'p9',
      column: 'image_path',
      bucket: 'todos',
      owner: 'owner-2',
      direction: 'download',
      state: EAttachmentState.queued,
      createdAt: 'T',
    })

    const uri = await queue.resolveDownload(ref)
    const expectedSha = sha256Hex(PNG.bytes)
    const expectedSandboxPath = `downloads/${expectedSha}`

    // The URI must point at the sandbox-based path, not the raw Storage object key.
    expect(uri).toBe(`mem://${expectedSandboxPath}`)
    expect((await store.getAttachment(ref))?.localPath).toBe(expectedSandboxPath)
    // The bytes must exist in the file store at the sandbox path.
    expect(files.has(expectedSandboxPath)).toBe(true)
    expect(files.has(ref)).toBe(false) // never written at the Storage key path
    expect((await store.getAttachment(ref))?.state).toBe('synced')
  })

  test('resolveDownload whose bytes are not up yet re-queues (non-terminal)', async () => {
    const { store, transfer, queue } = setup({})
    const ref = 'owner-2/p9/up-9.png'

    // The confirm row names the hash, but the object is not on Storage yet.
    transfer.meta.set(ref, { sha256: sha256Hex(PNG.bytes) })
    await store.enqueueAttachment({
      ref,
      uploadId: 'up-9',
      table: 'todos',
      pk: 'p9',
      column: 'image_path',
      bucket: 'todos',
      owner: 'owner-2',
      direction: 'download',
      state: EAttachmentState.queued,
      createdAt: 'T',
    })
    expect(await queue.resolveDownload(ref)).toBeNull()
    expect((await store.getAttachment(ref))?.state).toBe('queued') // still pending, not failed
    expect(await queue.getStatus(ref)).toMatchObject({ errorCode: EEngineErrorCode.ATTACHMENT_NOT_YET_AVAILABLE })
  })

  test('resolveDownload fails closed when no SHA-256 is known, and never names a file after the ref', async () => {
    for (const serverSha of [null, '../../escape']) {
      const { store, transfer, queue, files } = setup({})
      const ref = 'owner-2/p9/up-9.png'
      let downloads = 0

      transfer.objects.set(`todos/${ref}`, PNG.bytes)

      if (serverSha !== null) {
        transfer.meta.set(ref, { sha256: serverSha })
      }
      const download = transfer.download

      transfer.download = async (target, toLocalPath, options) => {
        downloads += 1

        return download(target, toLocalPath, options)
      }
      await store.enqueueAttachment({
        ref, uploadId: 'up-9', table: 'todos', pk: 'p9', column: 'image_path',
        bucket: 'todos', owner: 'owner-2', direction: 'download', state: EAttachmentState.queued, createdAt: 'T',
      })

      expect(await queue.resolveDownload(ref)).toBeNull()
      expect(downloads).toBe(0)
      expect(files.size).toBe(0)
      expect(await store.getAttachment(ref)).toMatchObject({
        state: EAttachmentState.failed,
        inFlight: false,
        localPath: null,
        error: `${ref} has no known SHA-256`,
        errorCode: EEngineErrorCode.ATTACHMENT_UNVERIFIED,
      })
    }
  })

  test('an off-shape peer ref downloads under downloads/, named by its SHA-256 only', async () => {
    const { store, transfer, queue, files } = setup({})
    const ref = '../../outside/evil.png'
    const sha = sha256Hex(PNG.bytes)

    transfer.objects.set(`todos/${ref}`, PNG.bytes)
    transfer.meta.set(ref, { sha256: sha })
    await store.enqueueAttachment({
      ref, uploadId: 'evil', table: 'todos', pk: 'p9', column: 'image_path',
      bucket: 'todos', owner: 'owner-2', direction: 'download', state: EAttachmentState.queued, createdAt: 'T',
    })

    expect(await queue.resolveDownload(ref)).toBe(`mem://downloads/${sha}`)
    expect([...files.keys()]).toEqual([`downloads/${sha}`])
  })

  test('drive does NOT download (lazy) and a scheduled download stays queued', async () => {
    const { store, transfer, queue } = setup({})
    const ref = 'owner-2/p9/up-9.png'

    transfer.objects.set(`todos/${ref}`, PNG.bytes)
    transfer.meta.set(ref, { sha256: sha256Hex(PNG.bytes) })
    await store.enqueueAttachment({
      ref, uploadId: 'up-9', table: 'todos', pk: 'p9', column: 'image_path',
      bucket: 'todos', owner: 'owner-2', direction: 'download', state: EAttachmentState.queued, createdAt: 'T',
    })
    await queue.drive()
    expect((await store.getAttachment(ref))?.state).toBe('queued') // sync didn't fetch it
  })

  test('watch fires on state changes for its ref', async () => {
    const { store, queue } = setup({ 'pick://a': PNG })

    store.putRow('todos', PK, { user_id: OWNER })
    const { ref } = await queue.fromFile({ table: 'todos', column: 'image_path', pk: PK, uri: 'pick://a' })


    const states: string[] = []
    const unsubscribe = queue.watch(ref, (status) => states.push(status.state))

    await queue.drive()

    // notify is fire-and-forget async (getStatus goes through the store mutex); spin the event loop until the synced status lands.
    for (let i = 0; i < 50 && !states.includes('synced'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    unsubscribe()
    expect(states).toContain('synced')
  })
})

// MARK: - Resumable uploads

/**
 * The tus adapter shape in miniature: the session URL does NOT exist when
 * createUpload returns (the create request is still in flight), so it arrives
 * through onSessionCreated; `progress` ends when the transfer SETTLES, success
 * or failure; the failure itself travels only on `done`. A queue that drains
 * progress and never sees an end would stall every later sync, and one that
 * persists the session only after `done` would restart from byte zero.
 */
const RESUMABLE_HANG_GUARD_MS = 5_000

type TResumableTransfer = TFakeTransfer & {
  /** One record per createUpload, in order: what the queue offered to resume. */
  attempts: Array<{ resumeFingerprint: string | undefined; sessionUrl: string }>
}

const makeResumableTransfer = (
  files: Map<string, Uint8Array>,
  options: { announcesSession?: boolean } = {},
): TResumableTransfer => {
  const announcesSession = options.announcesSession ?? true
  const base = makeTransfer(files)
  const attempts: TResumableTransfer['attempts'] = []

  return {
    ...base,
    attempts,
    createUpload: async (localPath, target, uploadOptions) => {
      const resumeFingerprint = uploadOptions.resumeFingerprint
      const sessionUrl = resumeFingerprint ?? `tus://session-${attempts.length + 1}`

      attempts.push({ resumeFingerprint, sessionUrl })
      const failing = attempts.length === 1
      let settle = (): void => undefined
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      const done = (async () => {
        try {
          // The bytes only start moving after createUpload has returned.
          await Promise.resolve()

          if (failing) {
            throw new Error('connection reset mid-upload')
          }
          base.objects.set(`${target.bucket}/${target.path}`, files.get(localPath)!)
        } finally {
          settle()
        }
      })()

      void done.catch(() => undefined)

      return {
        resumable: true,
        fingerprint: '',
        progress: (async function* () {
          yield 50
          await settled

          if (!failing) {
            yield 100
          }
        })(),
        done,
        abort: async () => undefined,
        onSessionCreated: (listener) => {
          // Only a freshly created session is news; a resumed one is already persisted.
          if (announcesSession && resumeFingerprint === undefined) {
            listener(sessionUrl)
          }
        },
      }
    },
  }
}

const setupResumable = (
  sources: Record<string, { bytes: Uint8Array; contentType: string | null }>,
  options: { announcesSession?: boolean } = {},
) => {
  const store = freshStore()
  const { fs, files } = makeFileStore(sources)
  const transfer = makeResumableTransfer(files, options)
  let counter = 0
  const queue = createAttachmentQueue({
    store,
    config: CONFIG,
    fileStore: fs,
    transfer,
    apply: writeRowsOf(store),
    now: () => 'T',
    uuid: () => `up-${++counter}`,
  })

  return { store, transfer, queue }
}

/** A row, then fromFile, which writes the ref into the row column. */
const enqueueApplied = async (store: ITestAttachmentStore, queue: IAttachmentQueue): Promise<string> => {
  store.putRow('todos', PK, { user_id: OWNER })
  const { ref } = await queue.fromFile({
    table: 'todos',
    column: 'image_path',
    pk: PK,
    uri: 'pick://a',
  })

  return ref
}

describe('attachment queue resumable uploads', () => {
  test(
    'an upload that dies mid-flight fails the row, counts the attempt, and keeps its session',
    async () => {
      const { store, queue } = setupResumable({ 'pick://a': PNG })
      const ref = await enqueueApplied(store, queue)
      const rejections: unknown[] = []
      const recordRejection = (reason: unknown): void => {
        rejections.push(reason)
      }
      // bun-types declares Process.off('memoryPressure', …) directly, which hides the inherited EventEmitter overload; the base type restores it.
      const emitter: NodeJS.EventEmitter = process

      process.on('unhandledRejection', recordRejection)

      try {
        await queue.drive() // must RETURN: a progress iterable that never ends stalls sync

        const entry = await store.getAttachment(ref)

        expect(entry?.state).toBe('failed')
        expect(entry?.attempts).toBe(1)
        expect(entry?.error).toBe('connection reset mid-upload')
        expect(entry?.inFlight).toBe(false)
        // The queue persists the session token the adapter announces mid-transfer, so a failed upload still leaves the fingerprint on the row.
        expect(entry?.fingerprint).toBe('tus://session-1')
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
      } finally {
        emitter.off('unhandledRejection', recordRejection)
      }
    },
    RESUMABLE_HANG_GUARD_MS,
  )

  test(
    'the retry resumes the persisted session instead of opening a new one',
    async () => {
      const { store, transfer, queue } = setupResumable({ 'pick://a': PNG })
      const ref = await enqueueApplied(store, queue)

      await queue.drive() // dies mid-flight
      await queue.drive() // retries the failed row

      expect(transfer.attempts.map((attempt) => attempt.resumeFingerprint)).toEqual([
        undefined,
        'tus://session-1',
      ])
      const entry = await store.getAttachment(ref)

      expect(entry?.state).toBe('synced')
      expect(entry?.progress).toBe(100)
      expect(transfer.objects.has(`todos/${ref}`)).toBe(true)
      expect(transfer.meta.get(ref)?.sha256).toBe(sha256Hex(PNG.bytes))
    },
    RESUMABLE_HANG_GUARD_MS,
  )

  test(
    'an upload with no session leaves the fingerprint null, because "" is not a resume token',
    async () => {
      const { store, transfer, queue } = setupResumable({ 'pick://a': PNG }, { announcesSession: false })
      const ref = await enqueueApplied(store, queue)

      await queue.drive()
      await queue.drive()

      expect((await store.getAttachment(ref))?.fingerprint).toBeNull()
      // A retry offered '' would HEAD a nonexistent session; it must start clean.
      expect(transfer.attempts.map((attempt) => attempt.resumeFingerprint)).toEqual([
        undefined,
        undefined,
      ])
    },
    RESUMABLE_HANG_GUARD_MS,
  )
})

// MARK: - The transfer budget and the app's own controls

/**
 * A queue whose uploads always fail, so the budget is the only thing that can
 * end them, and one whose upload hangs until it is aborted, the state `cancel`
 * exists for. Both keep the byte ports of the fakes above; only the upload
 * handle changes.
 */
const makeFailingTransfer = (files: Map<string, Uint8Array>): TFakeTransfer => {
  const base = makeTransfer(files)

  return {
    ...base,
    createUpload: async () => ({
      resumable: false,
      fingerprint: '',
      progress: (async function* () {
        // Nothing moves: the transfer fails before the first byte.
      })(),
      done: Promise.reject(new Error('connection refused')).catch((error: unknown) => {
        throw error
      }),
      abort: async () => undefined,
    }),
  }
}

type TAbortableTransfer = TFakeTransfer & {
  /** Resolves once the queue has an upload handle in hand. */
  started: Promise<void>

  aborts: number
}

const makeAbortableTransfer = (files: Map<string, Uint8Array>): TAbortableTransfer => {
  const base = makeTransfer(files)
  let announceStart = (): void => undefined
  const started = new Promise<void>((resolve) => {
    announceStart = resolve
  })
  const transfer: TAbortableTransfer = {
    ...base,
    started,
    aborts: 0,
    createUpload: async () => {
      let fail = (reason: Error): void => void reason
      const done = new Promise<void>((_resolve, reject) => {
        fail = reject
      })

      void done.catch(() => undefined)

      return {
        resumable: false,
        fingerprint: '',
        // The start is announced from the first pull of this iterable, which the queue reaches only after it has registered the handle. Announcing it from `createUpload` would let the test cancel a reference the queue has not recorded yet: a race in the test, not in the queue.
        progress: (async function* () {
          announceStart()
          await done.catch(() => undefined)
        })(),
        done,
        abort: async () => {
          transfer.aborts += 1
          fail(new Error('upload aborted'))
        },
      }
    },
  }

  return transfer
}

const setupWith = (
  makeUploads: (files: Map<string, Uint8Array>) => TFakeTransfer,
  budget?: number,
) => {
  const store = freshStore(budget)
  const { fs, files } = makeFileStore({ 'pick://a': PNG })
  const transfer = makeUploads(files)
  let counter = 0
  const queue = createAttachmentQueue({
    store,
    config: budget === undefined ? CONFIG : { ...CONFIG, attachmentAttempts: budget },
    fileStore: fs,
    transfer,
    apply: writeRowsOf(store),
    now: () => 'T',
    uuid: () => `up-${++counter}`,
  })

  return { store, files, transfer, queue }
}

describe('attachment budget and controls', () => {
  test('six failures end the reference for good, and retry hands it back', async () => {
    const { store, queue } = setupWith(makeFailingTransfer)
    const ref = await enqueueApplied(store, queue)

    // Five drives spend the budget: each one claims, fails, and charges an attempt.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await queue.drive()
    }
    const spent = await store.getAttachment(ref)

    expect(spent?.attempts).toBe(5)
    expect(spent?.state).toBe('failed')
    expect(spent?.permanent).toBe(false)

    // The sixth claim is the one the budget refuses: attempts stay at DEFAULT_ATTACHMENT_ATTEMPTS and the row lands permanent.
    await queue.drive()
    const stopped = await store.getAttachment(ref)

    expect(stopped?.permanent).toBe(true)
    expect(stopped?.state).toBe('failed')
    expect(stopped?.attempts).toBe(5)
    expect(await queue.getStatus(ref)).toMatchObject({
      state: EAttachmentState.failed,
      permanent: true,
      attempts: 5,
    })

    // A permanent row is no longer a candidate, so a later drive costs nothing.
    expect(await store.pendingAttachments('upload')).toEqual([])
    await queue.drive()
    expect((await store.getAttachment(ref))?.attempts).toBe(5)

    await queue.retry(ref)
    const forgiven = await store.getAttachment(ref)

    expect(forgiven?.state).toBe('queued')
    expect(forgiven?.permanent).toBe(false)
    expect(forgiven?.attempts).toBe(0)
    expect((await store.pendingAttachments('upload')).map((entry) => entry.ref)).toEqual([ref])
  })

  test('watchers hear the claim that stops a reference for a spent budget', async () => {
    const { store, transfer, queue } = setupWith(makeFailingTransfer, 2)
    const upload = await enqueueApplied(store, queue)
    const download = 'owner-2/p9/up-9.png'

    transfer.meta.set(download, { sha256: sha256Hex(PNG.bytes) })
    await store.enqueueAttachment({
      ref: download, uploadId: 'up-9', table: 'todos', pk: 'p9', column: 'image_path',
      bucket: 'todos', owner: 'owner-2', direction: 'download', state: EAttachmentState.queued, createdAt: 'T',
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await queue.drive()
      await queue.resolveDownload(download)
    }
    const heard: Array<{ ref: string; status: TAttachmentStatus }> = []

    for (const ref of [upload, download]) {
      queue.watch(ref, (status) => heard.push({ ref, status }))
    }
    // The claims the budget refuses: no transfer runs, so the refusal is the only news.
    await queue.drive()
    await queue.resolveDownload(download)

    for (let turn = 0; turn < 50 && heard.length < 2; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const stopped = { state: EAttachmentState.failed, permanent: true, attempts: 2 }

    expect(heard).toEqual([
      { ref: upload, status: expect.objectContaining(stopped) },
      { ref: download, status: expect.objectContaining(stopped) },
    ])
  })

  test('a download 404 keeps the row retryable and still spends the budget', async () => {
    const { store, transfer, queue } = setupWith(makeTransfer, 2)
    const ref = 'owner-2/p9/up-9.png'

    transfer.meta.set(ref, { sha256: sha256Hex(PNG.bytes) })
    await store.enqueueAttachment({
      ref,
      uploadId: 'up-9',
      table: 'todos',
      pk: 'p9',
      column: 'image_path',
      bucket: 'todos',
      owner: 'owner-2',
      direction: 'download',
      state: EAttachmentState.queued,
      createdAt: 'T',
    })

    expect(await queue.resolveDownload(ref)).toBeNull()
    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.queued, attempts: 1 })
    expect(await queue.resolveDownload(ref)).toBeNull()
    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.queued, attempts: 2 })

    // The budget is spent, so the next claim stops the row; it does not refetch.
    expect(await queue.resolveDownload(ref)).toBeNull()
    expect(await store.getAttachment(ref)).toMatchObject({
      state: EAttachmentState.failed,
      permanent: true,
      attempts: 2,
    })
  })

  test('cancel aborts the in-flight handle and leaves the row retryable', async () => {
    const { store, transfer, queue } = setupWith(makeAbortableTransfer)
    const ref = await enqueueApplied(store, queue)

    const driving = queue.drive()

    await (transfer as TAbortableTransfer).started
    await queue.cancel(ref)
    await driving

    expect((transfer as TAbortableTransfer).aborts).toBe(1)
    const cancelled = await store.getAttachment(ref)

    expect(cancelled?.state).toBe('failed')
    expect(cancelled?.permanent).toBe(false)
    // Cancelling says "not now": it must not spend an attempt of the budget.
    expect(cancelled?.attempts).toBe(0)
    expect((await store.pendingAttachments('upload')).map((entry) => entry.ref)).toEqual([ref])
  })

  test('cancel on a reference with no transfer running still marks the row', async () => {
    const { store, transfer, queue } = setupWith(makeAbortableTransfer)
    const ref = await enqueueApplied(store, queue)

    await queue.cancel(ref)

    expect((transfer as TAbortableTransfer).aborts).toBe(0)
    expect((await store.getAttachment(ref))?.state).toBe('failed')
  })

  test('remove forgets the row and deletes its sandbox bytes', async () => {
    const { store, files, queue } = setupWith(makeTransfer)
    const ref = await enqueueApplied(store, queue)
    const sandboxPath = (await store.getAttachment(ref))?.localPath

    expect(sandboxPath).toBe(`sandbox/${sha256Hex(PNG.bytes)}`)
    expect(files.has(sandboxPath!)).toBe(true)

    await queue.remove(ref)

    expect(await store.getAttachment(ref)).toBeNull()
    expect(await queue.getStatus(ref)).toBeNull()
    expect(files.has(sandboxPath!)).toBe(false)
  })

  test('remove keeps sandbox bytes another live row still shares', async () => {
    const { store, files, queue } = setupWith(makeTransfer)
    const ref = await enqueueApplied(store, queue)
    const sandboxPath = (await store.getAttachment(ref))!.localPath!

    store.putRow('todos', PK_2, { user_id: OWNER })
    const twin = await queue.fromFile({
      table: 'todos',
      column: 'image_path',
      pk: PK_2,
      uri: 'pick://a',
    })

    expect(twin.ref).not.toBe(ref)

    await queue.remove(ref)

    expect(await store.getAttachment(ref)).toBeNull()
    expect(files.has(sandboxPath)).toBe(true)
  })

  test('remove on a reference no row carries is a no-op', async () => {
    const { queue } = setupWith(makeTransfer)

    await queue.remove('owner-1/p1/never-enqueued.png')
    expect(await queue.getStatus('owner-1/p1/never-enqueued.png')).toBeNull()
  })
})

// MARK: - Session refusals and the confirm table

/**
 * A 401 refuses the session, not the object: the next session can succeed
 * where this one could not, so the claim goes back to `queued` without
 * charging an attempt, on uploads and downloads alike.
 */
const makeRefusingTransfer = (status: number) => (files: Map<string, Uint8Array>): TFakeTransfer => {
  const base = makeTransfer(files)
  const refusal = (): Error => Object.assign(new Error(`refused with ${status}`), { status })

  return {
    ...base,
    createUpload: async () => ({
      resumable: false,
      fingerprint: '',
      progress: (async function* () {
        // Nothing moves: the host refuses before the first byte.
      })(),
      done: Promise.reject(refusal()).catch((error: unknown) => {
        throw error
      }),
      abort: async () => undefined,
    }),
    metadata: async () => {
      throw refusal()
    },
  }
}

const enqueuePeerDownload = async (store: ITestAttachmentStore): Promise<string> => {
  const ref = 'owner-2/p9/up-9.png'

  await store.enqueueAttachment({
    ref, uploadId: 'up-9', table: 'todos', pk: 'p9', column: 'image_path',
    bucket: 'todos', owner: 'owner-2', direction: 'download', state: EAttachmentState.queued, createdAt: 'T',
  })

  return ref
}

describe('attachment session refusals and the confirm table', () => {
  test('an upload refused with 401 releases its claim without charging an attempt', async () => {
    const { store, queue } = setupWith(makeRefusingTransfer(401))
    const ref = await enqueueApplied(store, queue)

    await queue.drive()

    expect(await store.getAttachment(ref)).toMatchObject({
      state: EAttachmentState.queued,
      inFlight: false,
      attempts: 0,
      error: null,
      errorCode: null,
    })
  })

  test('a download refused with 401 releases its claim without charging an attempt', async () => {
    const { store, queue } = setupWith(makeRefusingTransfer(401))
    const ref = await enqueuePeerDownload(store)

    expect(await queue.resolveDownload(ref)).toBeNull()
    expect(await store.getAttachment(ref)).toMatchObject({
      state: EAttachmentState.queued,
      inFlight: false,
      attempts: 0,
      error: null,
      errorCode: null,
    })
  })

  test('confirm names the table whose row carries the reference', async () => {
    const tables: unknown[] = []
    const { store, queue } = setupWith((files) => {
      const base = makeTransfer(files)

      return {
        ...base,
        confirm: async (target, meta, table) => {
          tables.push(table)
          await base.confirm(target, meta, table)
        },
      }
    })

    await enqueueApplied(store, queue)
    await queue.drive()

    expect(tables).toEqual(['todos'])
  })
})

// MARK: - Failure classification, failure codes, and the vacuum rule

/** An upload whose transfer fails with `failure` before any byte moves. */
const makeUploadFailingWith = (failure: () => unknown) => (files: Map<string, Uint8Array>): TFakeTransfer => {
  const base = makeTransfer(files)

  return {
    ...base,
    createUpload: async () => ({
      resumable: false,
      fingerprint: '',
      progress: (async function* () {
        // Nothing moves: the host answers before the first byte.
      })(),
      done: Promise.reject(failure()).catch((error: unknown) => {
        throw error
      }),
      abort: async () => undefined,
    }),
  }
}

/** A failure carrying the HTTP status the host means. */
const answered = (status: number): Error => Object.assign(new Error(`answered ${status}`), { status })

/** A transfer whose download runs the shared signed-URL adapter over bytes that miss the SHA-256 Storage records. */
const makeMismatchingDownload = (files: Map<string, Uint8Array>): TFakeTransfer => ({
  ...makeTransfer(files),
  metadata: async () => ({ sha256: sha256Hex(PNG.bytes) }),
  download: createSignedUrlDownload({
    client: { storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://storage.example/signed' }, error: null }) }) } },
    fileStore: {} as unknown as IFileStore,
    fetchBytes: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(3) }),
  }),
})

/** An own uploaded object, orphaned, whose bytes this device caches. */
const orphanedUpload = async (setupResult: ReturnType<typeof setupWith>): Promise<{ ref: string; sandboxPath: string }> => {
  const { store, queue } = setupResult
  const ref = await enqueueApplied(store, queue)

  await queue.drive()
  await store.markAttachmentOrphaned(ref, 'T')

  return { ref, sandboxPath: `sandbox/${sha256Hex(PNG.bytes)}` }
}

describe('attachment failures and the vacuum rule', () => {
  test('DEFAULT_ATTACHMENT_ATTEMPTS is the budget the Rust engine defaults to', () => {
    const source = readFileSync(new URL('../../../../crates/kizunasync-engine/src/config.rs', import.meta.url), 'utf8')
    const declared = /pub const DEFAULT_ATTACHMENT_ATTEMPTS: i64 = (\d+);/.exec(source)

    expect(declared).not.toBeNull()
    expect(DEFAULT_ATTACHMENT_ATTEMPTS).toBe(Number(declared?.[1]))
  })

  test('an upload refused with a client error ends for good, and 403, 409, 423 and server errors retry', async () => {
    const cases: Array<[number, boolean]> = [
      [400, true], [404, true], [410, true], [413, true], [422, true],
      [403, false], [409, false], [423, false], [500, false], [503, false],
    ]

    for (const [status, permanent] of cases) {
      const { store, queue } = setupWith(makeUploadFailingWith(() => answered(status)))
      const ref = await enqueueApplied(store, queue)

      await queue.drive()

      expect(await store.getAttachment(ref)).toMatchObject({
        state: EAttachmentState.failed,
        inFlight: false,
        attempts: 1,
        permanent,
        errorCode: EEngineErrorCode.TRANSFER,
      })
      expect(await store.pendingAttachments('upload')).toHaveLength(permanent ? 0 : 1)
    }
  })

  test('a download refused with a client error ends for good', async () => {
    const { store, queue } = setupWith(makeRefusingTransfer(400))
    const ref = await enqueuePeerDownload(store)

    expect(await queue.resolveDownload(ref)).toBeNull()
    expect(await queue.getStatus(ref)).toMatchObject({
      state: EAttachmentState.failed,
      permanent: true,
      attempts: 1,
      errorCode: EEngineErrorCode.TRANSFER,
    })
  })

  test('a download whose bytes miss the recorded hash records ATTACHMENT_HASH_MISMATCH and stays retryable', async () => {
    const { store, queue } = setupWith(makeMismatchingDownload)
    const ref = await enqueuePeerDownload(store)

    expect(await queue.resolveDownload(ref)).toBeNull()
    expect(await queue.getStatus(ref)).toMatchObject({
      state: EAttachmentState.failed,
      permanent: false,
      attempts: 1,
      errorCode: EEngineErrorCode.ATTACHMENT_HASH_MISMATCH,
    })
  })

  test('a failure records the catalog code it carries, and TRANSFER for any other', async () => {
    const cases: Array<[() => unknown, string]> = [
      [() => Object.assign(new Error('session gone'), { code: ETransferError.expired }), EEngineErrorCode.ATTACHMENT_UPLOAD_EXPIRED],
      [() => Object.assign(new Error('too slow'), { code: ETransferError.timedOut }), EEngineErrorCode.ATTACHMENT_TRANSFER_TIMEOUT],
      [() => Object.assign(new Error('no session'), { code: 'AUTH_SESSION_TIMEOUT' }), EEngineErrorCode.TRANSFER],
      [() => new Error('connection refused'), EEngineErrorCode.TRANSFER],
    ]

    for (const [failure, errorCode] of cases) {
      const { store, queue } = setupWith(makeUploadFailingWith(failure))
      const ref = await enqueueApplied(store, queue)

      await queue.drive()

      expect(await queue.getStatus(ref)).toMatchObject({ state: EAttachmentState.failed, errorCode })
    }
  })

  test('an upload whose sandbox bytes are gone records STORE', async () => {
    const { store, queue } = setupWith(makeTransfer)
    const ref = `${OWNER}/${PK}/gone.png`

    await store.enqueueAttachment({
      ref, uploadId: 'gone', table: 'todos', pk: PK, column: 'image_path',
      bucket: 'todos', owner: OWNER, direction: 'upload', state: EAttachmentState.queued, createdAt: 'T',
    })
    store.putRow('todos', PK, { user_id: OWNER, image_path: ref })

    await queue.drive()

    expect(await queue.getStatus(ref)).toMatchObject({
      state: EAttachmentState.failed,
      error: 'missing sandbox bytes',
      errorCode: EEngineErrorCode.STORE,
    })
  })

  test('vacuum deletes an evicted row\'s bytes, keeps the row, and never calls Storage', async () => {
    const setupResult = setupWith(makeTransfer)
    const { store, files, transfer, queue } = setupResult
    const { ref, sandboxPath } = await orphanedUpload(setupResult)
    let removals = 0

    transfer.remove = async () => {
      removals += 1
    }
    await store.updateAttachment(ref, { state: EAttachmentState.evicted }, 'T')
    await queue.vacuum()

    expect(removals).toBe(0)
    expect(files.has(sandboxPath)).toBe(false)
    expect(await store.getAttachment(ref)).toMatchObject({
      state: EAttachmentState.evicted,
      localPath: null,
      sha256: sha256Hex(PNG.bytes),
    })
    await queue.vacuum()
    expect(removals).toBe(0)
  })

  test('a removal refused with 401 or 403 ends as a local eviction after one attempt', async () => {
    for (const status of [401, 403]) {
      const setupResult = setupWith(makeTransfer)
      const { store, files, transfer, queue } = setupResult
      const { ref, sandboxPath } = await orphanedUpload(setupResult)
      let removals = 0

      transfer.remove = async () => {
        removals += 1

        throw answered(status)
      }
      await queue.vacuum()
      await queue.vacuum()

      expect(removals).toBe(1)
      expect(files.has(sandboxPath)).toBe(false)
      expect(await store.getAttachment(ref)).toMatchObject({
        state: EAttachmentState.evicted,
        localPath: null,
        error: null,
        errorCode: null,
      })
    }
  })

  test('a failing removal is retried within the budget, then evicted', async () => {
    const setupResult = setupWith(makeTransfer, 2)
    const { store, files, transfer, queue } = setupResult
    const { ref, sandboxPath } = await orphanedUpload(setupResult)
    let removals = 0

    transfer.remove = async () => {
      removals += 1

      throw answered(503)
    }
    await queue.vacuum()

    expect(await store.getAttachment(ref)).toMatchObject({
      state: EAttachmentState.orphaned,
      attempts: 1,
      error: 'answered 503',
      errorCode: EEngineErrorCode.TRANSFER,
    })
    expect(files.has(sandboxPath)).toBe(true)

    await queue.vacuum()

    expect(removals).toBe(2)
    expect(files.has(sandboxPath)).toBe(false)
    expect(await store.getAttachment(ref)).toMatchObject({ state: EAttachmentState.evicted, localPath: null })
  })
})
