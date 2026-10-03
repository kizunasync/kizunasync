/// <reference types="bun" />
// MARK: - createKizunaSync on the N-API addon

/**
 * `createKizunaSync` over the addon: the engine kind it reports, the bytes the
 * injected remote sees, the exactly-once watermark, the rejection journal, the
 * checkpoint, the inspector, the scheduler and the attachment queue, each driven
 * through the public surface an app uses.
 *
 * Skipped wholesale when the native addon is not built (`cargo build -p
 * kizunasync-napi`): without it `createKizunaSync` has no engine to run at all. That
 * case belongs to select-engine.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { attachment, byOwner, defineConfig } from '../config/config'
import { EInspectorVerdictKind } from './inspector'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { loadNapiAddon } from './napi-loader'
import { createTempDatabase } from '../testing/temp-database'
import type { IStoreLocator } from '../ports/store-locator'
import { sha256Hex } from '../util/sha256'
import type { IFileStore } from '../ports/file-store'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ITransfer } from '../ports/transfer'
import { EAttachmentState, EConflictMode, EEngineErrorCode, EEngineEventType, ERejectionKind, ERejectReason, ESignalType, EVerdictKind, TEngineError, type TEngineEvent, type TPullRequest, type TPullResponse, type TPushRequest, type TPushResponse, type TRejectReason } from '../wire/types'

const hasAddon = loadNapiAddon() !== null

const config = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

const EMPTY_PULL: TPullResponse = {
  cursor: '0',
  has_more: false,
  rows: [],
  signal: null,
  tombstones: [],
}

/**
 * Engine events cross the FFI on the event loop, so they land a tick after the
 * call that produced them.
 */
const flushEvents = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

interface IRecordingRemote extends IProtocolRemote {
  readonly pulls: TPullRequest[]
  readonly pushes: TPushRequest[]
}

const applyAll = (request: TPushRequest): TPushResponse => ({
  verdicts: request.batch.mutations.map((mutation) => ({
    mutation_id: mutation.mutation_id,
    verdict: EVerdictKind.applied,
  })),
})

const rejectAll = (request: TPushRequest, reason: TRejectReason): TPushResponse => ({
  verdicts: request.batch.mutations.map((mutation) => ({
    mutation_id: mutation.mutation_id,
    verdict: EVerdictKind.rejected,
    reason,
    server_row: null,
  })),
})

const recordingRemote = (
  push: (request: TPushRequest) => Promise<TPushResponse> = async (request) => applyAll(request),
  pull: (request: TPullRequest) => Promise<TPullResponse> = async () => EMPTY_PULL,
): IRecordingRemote => {
  const pulls: TPullRequest[] = []
  const pushes: TPushRequest[] = []

  return {
    pulls,
    pushes,
    pull: async (request) => {
      pulls.push(request)

      return pull(request)
    },
    push: async (request) => {
      pushes.push(request)

      return push(request)
    },
  }
}

describe.skipIf(!hasAddon)('createKizunaSync runs the Rust engine', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  const start = (
    remote: IProtocolRemote,
    db: IStoreLocator = createTempDatabase().driver,
    options: { pollIntervalMs?: number } = {},
  ): IKizunaSync => {
    const kizunasync = createKizunaSync(db, remote, config, { pollIntervalMs: 0, ...options })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    return kizunasync
  }

  // MARK: - Selection

  test('the engine createKizunaSync reports is Rust', () => {
    expect(start(recordingRemote()).engine).toBe('rust')
  })

  // MARK: - The port bridge

  test('the Rust engine reaches the INJECTED TypeScript remote', async () => {
    const remote = recordingRemote()
    const kizunasync = start(remote)

    await kizunasync.from('items').insert({ title: 'bridged', user_id: 'u1' })
    await kizunasync.sync()

    expect(remote.pushes).toHaveLength(1)
    const request = remote.pushes[0]!

    expect(request.batch.mutations[0]?.columns.title).toBe('bridged')
    // The bridge hands the remote exactly the keys a real PostgREST RPC accepts as argument names, because it rejects an extra one outright: the batch, the exactly-once watermark, the schema version, and the client identity D-client-identity put on the wire.
    expect(Object.keys(request).sort()).toEqual([
      'batch',
      'client_id',
      'last_mutation_id',
      'schema_version',
    ])
    expect(remote.pulls).toHaveLength(1)
    expect(await kizunasync.getOutboxDepth()).toBe(0)
  })

  test('a table with no bucket() pulls and pushes like any other', async () => {
    // A global/shared table carries an EMPTY bucket-param map, which is not the same as a bucket nobody filled. Conflating the two would refuse to pull a whole class of configs, invisible to the core suites because they all declare `byOwner`.
    const globalConfig = defineConfig({ tables: { items: { sync: 'read-write' } } })
    const remote = recordingRemote()
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, globalConfig, {
      pollIntervalMs: 0,
    })

    open.push(() => kizunasync.dispose())
    expect(kizunasync.engine).toBe('rust')

    await kizunasync.from('items').insert({ title: 'shared', user_id: 'u1' })
    await kizunasync.sync()

    expect(remote.pulls[0]?.buckets).toEqual([{ table: 'items', params: {} }])
    expect(await kizunasync.getOutboxDepth()).toBe(0)
  })

  test('the exactly-once watermark advances across the bridge', async () => {
    const remote = recordingRemote()
    const kizunasync = start(remote)

    await kizunasync.from('items').insert({ title: 'first', user_id: 'u1' })
    await kizunasync.sync()
    await kizunasync.from('items').insert({ title: 'second', user_id: 'u1' })
    await kizunasync.sync()

    expect(remote.pushes[0]?.last_mutation_id).toBeNull()
    expect(remote.pushes[1]?.last_mutation_id).toBe(
      remote.pushes[0]!.batch.mutations[0]!.mutation_id,
    )
  })

  test('a transient remote failure keeps the write queued and retries', async () => {
    let attempts = 0
    const remote = recordingRemote(async (request) => {
      attempts += 1

      if (attempts === 1) {
        throw new Error('network down')
      }
      return applyAll(request)
    })
    const kizunasync = start(remote)

    await kizunasync.from('items').insert({ title: 'queued', user_id: 'u1' })

    await expect(kizunasync.sync()).rejects.toThrow(/network down/)
    expect(await kizunasync.getOutboxDepth()).toBe(1)

    await kizunasync.sync()
    expect(await kizunasync.getOutboxDepth()).toBe(0)
  })

  test('a PERMANENT remote failure dead-letters the write once the budget runs out', async () => {
    const remote = recordingRemote(async () => {
      const error = new Error('duplicate key')

      ;(error as { retryable?: boolean }).retryable = false

      throw error
    })
    const kizunasync = start(remote)
    const events: TEngineEvent[] = []

    kizunasync.on((event) => events.push(event))
    await kizunasync.from('items').insert({ title: 'doomed', user_id: 'u1' })

    // The budget is five CONSECUTIVE permanent failures against the same head (parity with sync-engine.ts); the first four must keep the write.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(kizunasync.sync()).rejects.toThrow(/duplicate key/)
    }
    expect(await kizunasync.getOutboxDepth()).toBe(1)

    await kizunasync.sync()
    await flushEvents()
    expect(await kizunasync.getOutboxDepth()).toBe(0)
    expect(events.some((event) => event.type === EEngineEventType.DEAD_LETTER)).toBe(true)
    expect((await kizunasync.rejections())[0]?.kind).toBe(ERejectionKind.DEAD_LETTER)
  })

  // MARK: - Events, journal, checkpoint, inspector

  test('a rejected verdict reaches the client as MUTATION_REJECTED', async () => {
    const remote = recordingRemote(async (request) => rejectAll(request, ERejectReason.CONSTRAINT))
    const kizunasync = start(remote)
    const events: TEngineEvent[] = []

    kizunasync.on((event) => events.push(event))

    await kizunasync.from('items').insert({ title: 'refused', user_id: 'u1' })
    await kizunasync.sync()
    await flushEvents()

    expect(events.find((event) => event.type === EEngineEventType.MUTATION_REJECTED)).toMatchObject({
      reason: ERejectReason.CONSTRAINT,
    })
    expect(events.some((event) => event.type === EEngineEventType.LOCAL_CHANGED)).toBe(true)
  })

  test('the rejection journal lists and dismisses from the Rust store', async () => {
    const remote = recordingRemote(async (request) => rejectAll(request, ERejectReason.RLS_DENIED))
    const kizunasync = start(remote)

    await kizunasync.from('items').insert({ title: 'denied', user_id: 'u1' })
    await kizunasync.sync()

    const journal = await kizunasync.rejections()

    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      kind: ERejectionKind.REJECTED,
      reason: ERejectReason.RLS_DENIED,
      table: 'items',
      dismissed: false,
    })

    await kizunasync.dismissRejection(journal[0]!.mutationId)
    expect(await kizunasync.rejections()).toHaveLength(0)
    expect(await kizunasync.rejections({ includeDismissed: true })).toHaveLength(1)
  })

  test('seedCheckpoint honors its argument and the next pull carries it', async () => {
    const remote = recordingRemote()
    const kizunasync = start(remote)

    await kizunasync.seedCheckpoint('42')
    expect((await kizunasync.getCheckpoint()).cursor).toBe('42')

    await kizunasync.pullOnce()
    expect(remote.pulls[0]?.cursor).toBe('42')
  })

  test('the inspector reads the Rust command queue', async () => {
    const kizunasync = start(recordingRemote())

    await kizunasync.from('items').insert({ title: 'queued', user_id: 'u1' })

    const before = await kizunasync.inspector!.snapshot()

    expect(before.depth).toBe(1)
    expect(before.queued[0]?.table).toBe('items')
    expect(before.queued[0]?.createdAt).not.toBe('')

    await kizunasync.sync()
    const after = await kizunasync.inspector!.snapshot()

    expect(after.depth).toBe(0)
    expect(after.queued).toHaveLength(0)
    expect(after.lastMutationId).toBe(before.queued[0]!.mutationId)
  })

  test('a reset mints the client identity the next pull registers under', async () => {
    const remote = recordingRemote()
    const kizunasync = start(remote)

    const before = await kizunasync.inspector!.snapshot()

    await kizunasync.pullOnce()
    expect(remote.pulls[0]?.client_id).toBe(before.clientId)

    await kizunasync.reset()

    const after = await kizunasync.inspector!.snapshot()

    expect(after.clientId).not.toBe(before.clientId)
    // A reset unsets an owner bucket until a token names the next owner, and this store never sees one.
    kizunasync.setBucket({ user_id: 'u1' })
    await kizunasync.pullOnce()
    expect(remote.pulls[1]?.client_id).toBe(after.clientId)
  })

  // MARK: - Scheduling

  test('the shared scheduler drives the Rust engine back to health after an outage', async () => {
    let online = false
    const remote = recordingRemote(async (request) => {
      if (!online) {
        throw new Error('offline')
      }
      return applyAll(request)
    })
    const timers: Array<() => void> = []
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, {
      pollIntervalMs: 1_000,
      setTimer: (callback) => {
        timers.push(callback)

        return timers.length
      },
      clearTimer: () => undefined,
    })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })
    await kizunasync.from('items').insert({ title: 'survives', user_id: 'u1' })

    // A tick while the network is down must not lose the write, and must leave the loop armed, which is the scheduler's entire reason to exist.
    const armedWhileDown = timers.length

    timers.shift()?.()
    await flushEvents()
    expect(await kizunasync.getOutboxDepth()).toBe(1)
    expect(timers.length).toBeGreaterThanOrEqual(armedWhileDown)

    online = true
    timers.shift()?.()
    await flushEvents()
    expect(await kizunasync.getOutboxDepth()).toBe(0)
  })
})

// MARK: - Attachments

/**
 * A config declaring `attachment()` runs on the same engine as any other. The
 * shared queue (`host/attachment-queue.ts`) drives the bytes through the
 * injected ports and only its durable rows cross into the Rust store, which
 * keeps Rust the single writer of the queue table and of the pull-side
 * schedule and orphan that happen inside the checkpoint.
 *
 * These tests go end-to-end through `createKizunaSync`: they assert the bytes
 * landed in the fake Storage, not that an RPC was reachable.
 */
type TAttachmentDb = {
  public: {
    Tables: {
      items: {
        Row: { id: string; user_id: string; title: string; image_path: string | null }
      }
    }
  }
}

const attachmentConfig = defineConfig<TAttachmentDb>({
  tables: {
    items: {
      sync: 'read-write',
      bucket: byOwner('user_id'),
      attachments: { image_path: attachment('media') },
    },
  },
})

const PNG = { bytes: new Uint8Array([1, 2, 3, 4, 5]), contentType: 'image/png' }
const PEER_BYTES = new Uint8Array([9, 8, 7])

/** The uuid owner and primary key an import names its object from. */
const OWNER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const PK = '0f8fad5b-d9cb-469f-a165-70867728950e'

/** Another user, whose row this device pulls, and that row's primary key. */
const PEER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PEER_PK = '9a7b6c5d-4e3f-4a1b-8c2d-1e0f9a8b7c6d'

/** Unpadded base64url JSON, the encoding a JWT's header and claims take. */
const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** The access token Supabase Auth issues to `sub`. The engine reads the claim and never checks the signature. */
const tokenOf = (sub: string): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub, role: 'authenticated' })}.c2lnbmF0dXJl`

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)

  new Uint8Array(buffer).set(bytes)

  return buffer
}

/**
 * A Map-backed sandbox: the queue only ever reaches bytes through this port, so
 * a Map is a complete implementation of it for a test.
 */
const makeFileStore = (): { fileStore: IFileStore; files: Map<string, Uint8Array> } => {
  const files = new Map<string, Uint8Array>()
  const fileStore: IFileStore = {
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
    importFromUri: async () => {
      const sha = sha256Hex(PNG.bytes)
      const path = `sandbox/${sha}`

      files.set(path, PNG.bytes)

      return { path, sha256: sha, size: PNG.bytes.length, contentType: PNG.contentType }
    },
    toUri: async (path) => `mem://${path}`,
  }

  return { fileStore, files }
}

type TFakeTransfer = ITransfer & {
  objects: Map<string, Uint8Array>
  meta: Map<string, { sha256: string }>

  /** Every Storage key a removal was asked for, in order. */
  removed: string[]
}

const objectKey = (bucket: string, path: string): string => `${bucket}/${path}`

const makeTransfer = (files: Map<string, Uint8Array>): TFakeTransfer => {
  const objects = new Map<string, Uint8Array>()
  const meta = new Map<string, { sha256: string }>()
  const removed: string[] = []

  return {
    objects,
    meta,
    removed,
    createUpload: async (localPath, target) => {
      objects.set(objectKey(target.bucket, target.path), files.get(localPath)!)

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
    download: async (target, toLocalPath) => {
      const bytes = objects.get(objectKey(target.bucket, target.path))

      if (bytes === undefined) {
        throw new Error(`no object at ${objectKey(target.bucket, target.path)}`)
      }
      files.set(toLocalPath, bytes)
    },
    confirm: async (target, integrity) => {
      meta.set(target.path, { sha256: integrity.sha256 })
    },
    metadata: async (target) => meta.get(target.path) ?? null,
    remove: async (target) => {
      removed.push(target.path)
      objects.delete(objectKey(target.bucket, target.path))
    },
  }
}

const pullPages = (...pages: TPullResponse[]) => {
  let index = 0

  return async (): Promise<TPullResponse> => {
    const page = pages[index]

    index += 1

    // Every later pull answers with the LAST cursor handed out, so a drained server does not rewind the checkpoint it moved.
    return page ?? { ...EMPTY_PULL, cursor: String(pages.length) }
  }
}

/** A page carrying one row of `owner`'s, whose image column holds `ref`. */
const rowPage = (cursor: string, ref: string | null, owner = PEER): TPullResponse => ({
  ...EMPTY_PULL,
  cursor,
  rows: [
    {
      table: 'items',
      pk: PEER_PK,
      seq: cursor,
      row: { id: PEER_PK, user_id: owner, title: 'from a peer', image_path: ref },
    },
  ],
})

const peerRef = (upload: string): string => `${PEER}/${PEER_PK}/${upload}.png`

describe.skipIf(!hasAddon)('attachments run on the Rust engine', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  // A client signed in as `OWNER` (or as nobody), over a Map sandbox and a recording Storage.
  const start = async (
    remote: IProtocolRemote,
    session: string | null = OWNER,
  ): Promise<{ kizunasync: IKizunaSync; files: Map<string, Uint8Array>; transfer: TFakeTransfer }> => {
    const { fileStore, files } = makeFileStore()
    const transfer = makeTransfer(files)
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, attachmentConfig, {
      pollIntervalMs: 0,
      fileStore,
      transfer,
    })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: OWNER })

    if (session !== null) {
      await kizunasync.setRemoteAccessToken(tokenOf(session))
    }
    return { kizunasync, files, transfer }
  }

  // MARK: - Selection

  test('a config with attachment() and both ports picks Rust', async () => {
    const { kizunasync } = await start(recordingRemote())

    expect(kizunasync.engine).toBe('rust')
    expect(kizunasync.attachments).not.toBeNull()
  })

  test('a config with attachment() but no byte ports fails before an engine is chosen', () => {
    let caught: unknown

    try {
      createKizunaSync(createTempDatabase().driver, recordingRemote(), attachmentConfig)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TEngineError)
    expect((caught as TEngineError).code).toBe(EEngineErrorCode.ATTACHMENT_PORTS_MISSING)
  })

  // MARK: - Upload: fromFile → push → drive

  test('fromFile writes the ref onto the row, and a sync alone uploads the bytes and marks the ref synced', async () => {
    const remote = recordingRemote()
    const { kizunasync, transfer } = await start(remote)

    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })

    const picked = await kizunasync.attachments.fromFile({
      table: 'items',
      column: 'image_path',
      pk: PK,
      uri: 'pick://a',
    })

    expect(picked.ref.startsWith(`${OWNER}/${PK}/`)).toBe(true)
    expect(await kizunasync.attachments.getStatus(picked.ref)).toMatchObject({ state: EAttachmentState.queued })
    expect((await kizunasync.from('items').select('image_path').eq('id', PK)).data).toEqual([{ image_path: picked.ref }])

    await kizunasync.sync()

    // The ref reached the server BEFORE its object: the queue only drives once the outbox is empty, which is the whole reason `sync` is split in two.
    expect(await kizunasync.getOutboxDepth()).toBe(0)
    expect(transfer.objects.has(objectKey('media', picked.ref))).toBe(true)
    expect(transfer.meta.get(picked.ref)?.sha256).toBe(picked.sha256)
    expect(await kizunasync.attachments.getStatus(picked.ref)).toMatchObject({
      state: EAttachmentState.synced,
      progress: 100,
      error: null,
      errorCode: null,
    })
  })

  test('a ref replaced before its bytes move is never uploaded and is dropped after the verdict', async () => {
    const { kizunasync, transfer } = await start(recordingRemote())

    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })
    const picked = await kizunasync.attachments.fromFile({
      table: 'items',
      column: 'image_path',
      pk: PK,
      uri: 'pick://a',
    })

    await kizunasync.from('items').update({ image_path: `${OWNER}/${PK}/other-upload.png` }).eq('id', PK)
    // The applied verdict for the replacement is the server evidence: the ref it replaced is this user's garbage, so the push hands it to the vacuum before the drive could send its bytes, and `sync` vacuums right after.
    await kizunasync.sync()

    expect(transfer.objects.size).toBe(0)
    expect(await kizunasync.attachments.getStatus(picked.ref)).toBeNull()

    // A second sweep over an already-collected orphan is a no-op.
    await kizunasync.attachments.vacuum()
    expect(await kizunasync.attachments.getStatus(picked.ref)).toBeNull()
  })

  // MARK: - Pull: the Rust checkpoint schedules and orphans

  test('a pulled peer ref is scheduled for a lazy download and resolves on first use', async () => {
    const ref = peerRef('peer-1')
    const remote = recordingRemote(
      async (request) => applyAll(request),
      pullPages(rowPage('1', ref)),
    )
    const { kizunasync, transfer } = await start(remote)

    transfer.objects.set(objectKey('media', ref), PEER_BYTES)
    transfer.meta.set(ref, { sha256: sha256Hex(PEER_BYTES) })

    await kizunasync.sync()

    // Metadata only: a sync NEVER pulls bytes, so the entry sits queued with no local file until something asks for it.
    expect(await kizunasync.attachments.getStatus(ref)).toMatchObject({
      state: EAttachmentState.queued,
      localUri: null,
    })

    expect(await kizunasync.attachments.resolveDownload(ref)).toBe(
      `mem://downloads/${sha256Hex(PEER_BYTES)}`,
    )
    expect(await kizunasync.attachments.getStatus(ref)).toMatchObject({ state: EAttachmentState.synced })
  })

  test('a pulled replacement evicts a peer ref locally', async () => {
    const first = peerRef('peer-1')
    const second = peerRef('peer-2')
    const remote = recordingRemote(
      async (request) => applyAll(request),
      pullPages(rowPage('1', first), rowPage('2', second)),
    )
    const { kizunasync, transfer } = await start(remote)

    await kizunasync.sync()
    expect(await kizunasync.attachments.getStatus(first)).toMatchObject({ state: EAttachmentState.queued })

    await kizunasync.sync()
    await kizunasync.attachments.vacuum()

    expect(await kizunasync.attachments.getStatus(first)).toMatchObject({ state: EAttachmentState.evicted })
    expect(await kizunasync.attachments.getStatus(second)).toMatchObject({ state: EAttachmentState.queued })
    expect(transfer.removed).toEqual([])
  })

  test('a pulled delete evicts the peer refs the row was holding', async () => {
    const ref = peerRef('peer-1')
    const remote = recordingRemote(
      async (request) => applyAll(request),
      pullPages(rowPage('1', ref), {
        ...EMPTY_PULL,
        cursor: '2',
        tombstones: [{ table: 'items', pk: PEER_PK, seq: '2', deleted_at: '2026-01-01T00:00:00Z' }],
      }),
    )
    const { kizunasync, transfer } = await start(remote)

    await kizunasync.sync()
    await kizunasync.sync()
    await kizunasync.attachments.vacuum()

    expect((await kizunasync.from('items').select()).data).toHaveLength(0)
    expect(await kizunasync.attachments.getStatus(ref)).toMatchObject({ state: EAttachmentState.evicted })
    expect(transfer.removed).toEqual([])
  })

  test('a pulled replacement of the signed-in user\'s own object makes it remote garbage', async () => {
    const own = `${OWNER}/${PK}/own-1.png`
    const next = `${OWNER}/${PK}/own-2.png`
    const remote = recordingRemote(
      async (request) => applyAll(request),
      pullPages(rowPage('1', own, OWNER), rowPage('2', next, OWNER)),
    )
    const { kizunasync, transfer } = await start(remote)

    transfer.objects.set(objectKey('media', own), PNG.bytes)
    await kizunasync.sync()
    await kizunasync.sync()
    expect(await kizunasync.attachments.getStatus(own)).toMatchObject({ state: EAttachmentState.orphaned })

    await kizunasync.attachments.vacuum()

    expect(transfer.removed).toEqual([own])
    expect(transfer.objects.has(objectKey('media', own))).toBe(false)
    expect(await kizunasync.attachments.getStatus(own)).toBeNull()
  })

  // MARK: - The session the queue runs under

  test('without a session token a sync uploads nothing', async () => {
    const { kizunasync, transfer } = await start(recordingRemote(), null)

    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })
    const picked = await kizunasync.attachments.fromFile({ table: 'items', column: 'image_path', pk: PK, uri: 'pick://a' })

    await kizunasync.sync()

    expect(await kizunasync.getOutboxDepth()).toBe(0)
    expect(transfer.objects.size).toBe(0)
    expect(await kizunasync.attachments.getStatus(picked.ref)).toMatchObject({ state: EAttachmentState.queued, attempts: 0 })
  })

  test('a store soft-blocked for another user uploads and vacuums nothing', async () => {
    const { kizunasync, transfer } = await start(recordingRemote())
    const upload = transfer.createUpload
    let refuseUploads = true

    transfer.createUpload = async (...args) => {
      if (refuseUploads) {
        throw new Error('network down')
      }
      return upload(...args)
    }
    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })
    const picked = await kizunasync.attachments.fromFile({ table: 'items', column: 'image_path', pk: PK, uri: 'pick://a' })

    await kizunasync.sync()
    expect(await kizunasync.attachments.getStatus(picked.ref)).toMatchObject({ state: EAttachmentState.failed, attempts: 1 })

    await kizunasync.setRemoteAccessToken(tokenOf(PEER))
    refuseUploads = false
    await kizunasync.sync()
    await kizunasync.attachments.vacuum()

    expect((await kizunasync.getCheckpoint()).softBlocked).toBe(true)
    expect(transfer.objects.size).toBe(0)
    expect(transfer.removed).toEqual([])
    expect(await kizunasync.attachments.getStatus(picked.ref)).toMatchObject({ state: EAttachmentState.failed, attempts: 1 })
  })

  test('an upload the host refuses with a client error ends for good across the bridge', async () => {
    const { kizunasync, transfer } = await start(recordingRemote())

    transfer.createUpload = async () => {
      throw Object.assign(new Error('bucket not found'), { status: 404 })
    }
    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })
    const picked = await kizunasync.attachments.fromFile({ table: 'items', column: 'image_path', pk: PK, uri: 'pick://a' })

    await kizunasync.sync()
    await kizunasync.sync()

    expect(await kizunasync.attachments.getStatus(picked.ref)).toMatchObject({
      state: EAttachmentState.failed,
      permanent: true,
      attempts: 1,
      error: 'bucket not found',
      errorCode: EEngineErrorCode.TRANSFER,
    })
  })

  // MARK: - reset

  test('reset wipes the sandbox bytes the Rust store just dropped rows for', async () => {
    const { kizunasync, files } = await start(recordingRemote())

    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })
    const picked = await kizunasync.attachments.fromFile({
      table: 'items',
      column: 'image_path',
      pk: PK,
      uri: 'pick://a',
    })
    const sandboxPath = `sandbox/${picked.sha256}`

    expect(files.has(sandboxPath)).toBe(true)

    await kizunasync.reset()

    // The Rust store has no file port, so a reset that only cleared rows would strand every imported byte on disk forever.
    expect(files.has(sandboxPath)).toBe(false)
    expect(await kizunasync.attachments.getStatus(picked.ref)).toBeNull()
  })
})

/**
 * `_kizunasync_overwrites` is written by the pull that commits a peer's winning
 * column and read back through `overwrites()` / `dismissOverwrite()`. Both go
 * through the same dispatch surface the rejection journal uses. What is under
 * test is that the two new methods cross the bridge and that the dismissal is
 * durable, not a filter applied in JavaScript.
 */
// MARK: - The overwrite journal, across the bridge

const conflictPage = (cursor: string, loserValue: unknown): TPullResponse => ({
  ...EMPTY_PULL,
  cursor,
  rows: [
    {
      table: 'items',
      pk: 'p1',
      seq: cursor,
      row: { id: 'p1', user_id: 'u1', title: 'the peer won' },
    },
  ],
  conflicts: [
    {
      table: 'items',
      pk: 'p1',
      column_name: 'title',
      loser_value: loserValue,
      winner_mutation_id: '00000000-0000-4000-8000-00000000beef',
      conflict_mode: 'arrival',
      /**
       * D-conflict-journal-visibility: the winner is always a row this same page delivers, so the
       * conflict names the seq that row carries.
       */
      winner_seq: cursor,
    },
  ],
})

describe.skipIf(!hasAddon)('the overwrite journal on the Rust engine', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  const start = (remote: IProtocolRemote): IKizunaSync => {
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, { pollIntervalMs: 0 })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    return kizunasync
  }

  test('a pulled conflict is journalled, readable, and dismissable', async () => {
    const kizunasync = start(recordingRemote(undefined, pullPages(conflictPage('1', 'mine'))))

    await kizunasync.sync()

    const journal = await kizunasync.overwrites()

    expect(journal).toHaveLength(1)
    expect(journal[0]).toMatchObject({
      table: 'items',
      pk: 'p1',
      column: 'title',
      loserValue: 'mine',
      winnerMutationId: '00000000-0000-4000-8000-00000000beef',
      conflictMode: EConflictMode.arrival,
      dismissed: false,
    })
    expect(typeof journal[0]!.id).toBe('number')

    await kizunasync.dismissOverwrite(journal[0]!.id)

    expect(await kizunasync.overwrites()).toHaveLength(0)
    const all = await kizunasync.overwrites({ includeDismissed: true })

    expect(all).toHaveLength(1)
    expect(all[0]!.dismissed).toBe(true)
  })

  test('the journal is empty on a client nothing overwrote', async () => {
    const kizunasync = start(recordingRemote())

    await kizunasync.sync()
    expect(await kizunasync.overwrites()).toEqual([])
  })

  test('COLUMN_OVERWRITTEN reaches the inspector ring beside the rejections', async () => {
    const kizunasync = start(recordingRemote(undefined, pullPages(conflictPage('1', 'mine'))))

    await kizunasync.sync()

    const verdicts = kizunasync.inspector!.verdicts()

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({
      kind: EInspectorVerdictKind.overwritten,
      mutationId: '00000000-0000-4000-8000-00000000beef',
      reason: 'items.title',
    })
  })
})

// MARK: - The app's attachment controls, across the bridge

describe.skipIf(!hasAddon)('attachment controls on the Rust engine', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  const start = (): { kizunasync: IKizunaSync; files: Map<string, Uint8Array> } => {
    const { fileStore, files } = makeFileStore()
    const kizunasync = createKizunaSync(
      createTempDatabase().driver,
      recordingRemote(),
      attachmentConfig,
      { pollIntervalMs: 0, fileStore, transfer: makeTransfer(files) },
    )

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: OWNER })

    return { kizunasync, files }
  }

  const pick = async (kizunasync: IKizunaSync): Promise<string> => {
    await kizunasync.from('items').insert({ id: PK, title: 'holiday', user_id: OWNER })
    const picked = await kizunasync.attachments.fromFile({
      table: 'items',
      column: 'image_path',
      pk: PK,
      uri: 'pick://a',
    })

    return picked.ref
  }

  test('getStatus carries the permanent flag and the attempt count', async () => {
    const { kizunasync } = start()
    const ref = await pick(kizunasync)

    expect(await kizunasync.attachments.getStatus(ref)).toMatchObject({
      state: EAttachmentState.queued,
      permanent: false,
      attempts: 0,
      errorCode: null,
    })
  })

  test('cancel lands the row failed and retryable, and retry queues it again', async () => {
    const { kizunasync } = start()
    const ref = await pick(kizunasync)

    await kizunasync.attachments.cancel(ref)
    expect(await kizunasync.attachments.getStatus(ref)).toMatchObject({
      state: EAttachmentState.failed,
      permanent: false,
    })

    await kizunasync.attachments.retry(ref)
    expect(await kizunasync.attachments.getStatus(ref)).toMatchObject({
      state: EAttachmentState.queued,
      permanent: false,
      attempts: 0,
    })
  })

  test('remove forgets the row and deletes its sandbox bytes', async () => {
    const { kizunasync, files } = start()
    const ref = await pick(kizunasync)
    const sandboxPath = (await kizunasync.attachments.getStatus(ref))!.localUri!.replace('mem://', '')

    expect(files.has(sandboxPath)).toBe(true)

    await kizunasync.attachments.remove(ref)

    expect(await kizunasync.attachments.getStatus(ref)).toBeNull()
    expect(files.has(sandboxPath)).toBe(false)
  })

  test('retry and remove on a reference no row carries are no-ops', async () => {
    const { kizunasync } = start()

    await kizunasync.attachments.retry('u1/p1/never.png')
    await kizunasync.attachments.remove('u1/p1/never.png')
    expect(await kizunasync.attachments.getStatus('u1/p1/never.png')).toBeNull()
  })
})

// MARK: - The reset signal, across the bridge

/**
 * `RESET_REQUIRED` arrives on a pull that otherwise resolves. A UI reading
 * only the loop's own failures would call a blocked client healthy. The
 * checkpoint latches the soft block; both `useSyncStatus` hooks read
 * `needsReset` from it. The health snapshot carries the signal as its last
 * error without counting it as a failed attempt.
 */

describe.skipIf(!hasAddon)('the reset signal on the Rust engine', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  const start = (remote: IProtocolRemote): IKizunaSync => {
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, { pollIntervalMs: 0 })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    return kizunasync
  }

  test('a RESET_REQUIRED pull soft-blocks the checkpoint and lands in the health snapshot', async () => {
    const kizunasync = start(
      recordingRemote(undefined, async () => ({
        ...EMPTY_PULL,
        signal: { type: ESignalType.RESET_REQUIRED },
      })),
    )

    await kizunasync.sync()
    await flushEvents()

    expect((await kizunasync.getCheckpoint()).softBlocked).toBe(true)
    const health = kizunasync.getSyncHealth()

    expect(health.lastError?.code).toBe(EEngineEventType.RESET_REQUIRED)
    expect(health.lastError?.message).toContain('reset()')
    // The pull itself resolved, so the attempt succeeded: the signal must not be counted as a failure, or the backoff would back off from nothing.
    expect(health.consecutiveFailures).toBe(0)
    expect(health.lastSuccessAt).not.toBeNull()
  })

  test('a clean sync leaves the checkpoint unblocked and the health snapshot clear', async () => {
    const kizunasync = start(recordingRemote())

    await kizunasync.sync()
    await flushEvents()

    expect((await kizunasync.getCheckpoint()).softBlocked).toBe(false)
    expect(kizunasync.getSyncHealth().lastError).toBeNull()
    expect(kizunasync.getSyncHealth().softBlockReason).toBeNull()
  })

  test('the RESET_REQUIRED event and the health snapshot name the reason, and reset() clears it', async () => {
    const kizunasync = start(
      recordingRemote(undefined, async () => ({
        ...EMPTY_PULL,
        signal: { type: ESignalType.RESET_REQUIRED },
      })),
    )
    const events: TEngineEvent[] = []

    kizunasync.on((event) => events.push(event))
    await kizunasync.sync()
    await flushEvents()

    expect(events).toContainEqual({ type: EEngineEventType.RESET_REQUIRED, reason: 'reset_required' })
    expect(kizunasync.getSyncHealth().softBlockReason).toBe('reset_required')

    await kizunasync.reset()

    expect(kizunasync.getSyncHealth().softBlockReason).toBeNull()
  })

  test('a store reopened while still soft-blocked names the reason in the health snapshot at open', async () => {
    const database = createTempDatabase()
    const blockingRemote = recordingRemote(undefined, async () => ({
      ...EMPTY_PULL,
      signal: { type: ESignalType.RESET_REQUIRED },
    }))
    const first = createKizunaSync(database.driver, blockingRemote, config, { pollIntervalMs: 0 })

    first.setBucket({ user_id: 'u1' })
    await first.sync()
    first.dispose()
    await flushEvents()

    const reopened = createKizunaSync(database.driver, recordingRemote(), config, { pollIntervalMs: 0 })

    open.push(() => {
      reopened.dispose()
      database.remove()
    })
    // The first use opens the engine, and the open reads the latched block from the checkpoint.
    reopened.getSyncHealth()
    await flushEvents()

    expect(reopened.getSyncHealth().softBlockReason).toBe('reset_required')
  })
})

// MARK: - The client identity createKizunaSync mints

describe.skipIf(!hasAddon)('createKizunaSync client identity', () => {
  const open: Array<() => void> = []

  afterEach(() => {
    while (open.length > 0) {
      open.pop()?.()
    }
  })

  test('an app that passes no clientId gets a minted uuid on the wire', async () => {
    const remote = recordingRemote()
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, { pollIntervalMs: 0 })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    await kizunasync.pullOnce()

    const sent = remote.pulls[0]?.client_id

    expect(typeof sent).toBe('string')
    expect(sent).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  test('a caller-supplied uuid is the identity on the wire', async () => {
    const remote = recordingRemote()
    const clientId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, {
      pollIntervalMs: 0,
      clientId,
    })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    await kizunasync.pullOnce()

    expect(remote.pulls[0]?.client_id).toBe(clientId)
  })

  test('a v7 uuid clientId is accepted (the pattern constrains no version nibble)', async () => {
    const remote = recordingRemote()
    const clientId = '01890a5d-ac96-774b-bcce-b302099a8057'
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, {
      pollIntervalMs: 0,
      clientId,
    })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    await kizunasync.pullOnce()

    expect(remote.pulls[0]?.client_id).toBe(clientId)
  })

  test('the nil uuid clientId is accepted (the pattern constrains no variant nibble)', async () => {
    const remote = recordingRemote()
    const clientId = '00000000-0000-0000-0000-000000000000'
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, {
      pollIntervalMs: 0,
      clientId,
    })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    await kizunasync.pullOnce()

    expect(remote.pulls[0]?.client_id).toBe(clientId)
  })

  test('a clientId that is not a uuid is refused with CONFIG_INVALID', () => {
    let caught: unknown

    try {
      createKizunaSync(createTempDatabase().driver, recordingRemote(), config, {
        pollIntervalMs: 0,
        clientId: 'device-a',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TEngineError)
    expect((caught as TEngineError).code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect((caught as TEngineError).message).toContain('device-a')
  })

  test('an injected uuid generator does not become the client identity', async () => {
    const remote = recordingRemote()
    let minted = 0
    const kizunasync = createKizunaSync(createTempDatabase().driver, remote, config, {
      pollIntervalMs: 0,
      uuid: () => `mutation-${(minted += 1)}`,
    })

    open.push(() => kizunasync.dispose())
    kizunasync.setBucket({ user_id: 'u1' })

    await kizunasync.pullOnce()

    // A frozen mutation-id source is a counter, and a counter is not an identity the server's uuid column can hold.
    expect(remote.pulls[0]?.client_id).not.toBe('mutation-1')
    expect(remote.pulls[0]?.client_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })
})
