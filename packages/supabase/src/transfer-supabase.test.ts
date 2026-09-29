// MARK: - createSupabaseTransfer dual-path

/**
 * Upload policy under test:
 * - bytes ≤ singleShotMaxBytes → storage-js single-shot, resumable:false
 * - bytes > singleShotMaxBytes → TUS resumable, fingerprint = session URL,
 *   announced through onSessionCreated before the first chunk
 * - resumeFingerprint is forwarded as the TUS resume URL when present
 * - progress terminates on success, failure, AND abort (the queue drains it
 *   before awaiting done, since an iterable that outlives a dead upload hangs sync)
 *
 * Threshold is injectable (singleShotMaxBytes) so tests stay tiny; production
 * default remains 6 MiB (see tus-client SINGLE_SHOT_MAX_BYTES).
 */

import { describe, expect, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ETransferError, type IFileStore, type IUploadHandle } from '@kizunasync/core'
import { AUTH_SESSION_TIMEOUT } from './session-errors'
import { createSupabaseTransfer } from './transfer-supabase'
import { TUS_CHUNK_SIZE } from './tus-client'

/**
 * Every async TUS test runs under an explicit cap so a termination regression
 * fails loudly instead of hanging the suite.
 */
const HANG_GUARD_MS = 5_000

type TUploadCall = {
  bucket: string
  path: string
  body: ArrayBuffer
  options: { contentType?: string; upsert?: boolean }
}

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

/**
 * createRpcRemote's own pattern (rpc-remote.ts): a fake `.rpc()` must answer
 * the same awaitable-and-chainable builder supabase-js returns, since
 * transfer-supabase binds `.abortSignal()` on it too, and the metadata read
 * ends in `.maybeSingle()`.
 */
const answering = (result: { data: unknown; error: unknown; status?: number }) => {
  const settled = Promise.resolve(result)

  return {
    abortSignal: () => ({ maybeSingle: () => settled, then: settled.then.bind(settled) }),
    then: settled.then.bind(settled),
  }
}

/**
 * A `.rpc()` result that only settles once its AbortSignal aborts: a hung
 * PostgREST request under a real deadline race.
 */
const hangingRpc = () => ({
  abortSignal: (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      })
    }),
  then: (): never => {
    throw new Error('hangingRpc requires .abortSignal() before awaiting')
  },
})

const makeClient = (opts: {
  uploadCalls: TUploadCall[]
  uploadError?: { message: string } | null
  accessToken?: string
  supabaseUrl?: string

  /** storage.upload() never settles: single-shot bytesTimeoutMs races it. */
  hangUpload?: boolean

  /** auth.getSession() never settles: controlTimeoutMs races it. */
  hangGetSession?: boolean

  /**
   * rpc('attachment_confirm', ...) only settles on abort: controlTimeoutMs
   * races it.
   */
  hangConfirm?: boolean

  /** Records every `.rpc()` call, name and arguments. */
  rpcCalls?: Array<{ fn: string; args: unknown }>

  /** What every settled `.rpc()` answers, the shape postgrest-js resolves. */
  rpcResult?: { data: unknown; error: unknown; status?: number }

  /** What storage.remove() answers as its error, the shape storage-js resolves. */
  removeError?: unknown
}): SupabaseClient => {
  const uploadError = opts.uploadError === undefined ? null : opts.uploadError

  return {
    supabaseUrl: opts.supabaseUrl ?? 'https://abc.supabase.co',
    supabaseKey: 'pub-key',
    auth: {
      getSession: async () => {
        if (opts.hangGetSession === true) {
          return new Promise<never>(() => undefined)
        }
        return {
          data: {
            session:
              opts.accessToken === ''
                ? null
                : { access_token: opts.accessToken ?? 'access-token' },
          },
          error: null,
        }
      },
    },
    schema: () => ({
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          abortSignal: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        }

        return chain
      },
      rpc: (fn: string, args: unknown) => {
        opts.rpcCalls?.push({ fn, args })

        return opts.hangConfirm === true && fn === 'attachment_confirm'
          ? hangingRpc()
          : answering(opts.rpcResult ?? { data: null, error: null })
      },
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (
          path: string,
          body: ArrayBuffer,
          options: { contentType?: string; upsert?: boolean },
        ) => {
          opts.uploadCalls.push({ bucket, path, body, options })

          if (opts.hangUpload === true) {
            return new Promise<never>(() => undefined)
          }
          return { data: { path }, error: uploadError }
        },
        createSignedUrl: async () => ({ data: null, error: { message: 'unused' } }),
        remove: async () => ({ data: null, error: opts.removeError ?? null }),
      }),
    },
  } as unknown as SupabaseClient
}

describe('createSupabaseTransfer dual-path upload', () => {
  test('small file uses single-shot storage.upload and is not resumable', async () => {
    const files = new Map<string, Uint8Array>([['local.bin', new Uint8Array([1, 2, 3, 4])]])
    const uploadCalls: TUploadCall[] = []
    const transfer = createSupabaseTransfer({
      client: makeClient({ uploadCalls }),
      fileStore: memoryFileStore(files),
      // default threshold is 6 MiB: 4 bytes is single-shot
    })

    const handle = await transfer.createUpload(
      'local.bin',
      { bucket: 'media', path: 'u1/p1.bin', contentType: 'application/octet-stream' },
      { sha256: 'deadbeef' },
    )

    expect(handle.resumable).toBe(false)
    expect(handle.fingerprint).toBe('')
    await handle.done
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0]?.bucket).toBe('media')
    expect(uploadCalls[0]?.path).toBe('u1/p1.bin')
    expect(uploadCalls[0]?.options.contentType).toBe('application/octet-stream')
    expect(uploadCalls[0]?.options.upsert).toBe(true)
    expect(new Uint8Array(uploadCalls[0]!.body)).toEqual(new Uint8Array([1, 2, 3, 4]))

    // Progress reports complete for single-shot
    const progress: number[] = []

    for await (const p of handle.progress) {
      progress.push(p)
    }
    expect(progress).toEqual([100])
  })

  test('large file (above injected threshold) uses TUS and is resumable', async () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5])
    const files = new Map<string, Uint8Array>([['big.bin', payload]])
    const uploadCalls: TUploadCall[] = []
    const fetchCalls: Array<{ method: string; url: string }> = []
    let offset = 0
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      fetchCalls.push({ method, url })

      if (method === 'POST' && url.includes('/upload/resumable')) {
        return new Response(null, {
          status: 201,
          headers: { Location: 'https://abc.storage.supabase.co/files/upload-live-1' },
        })
      }
      if (method === 'HEAD' && url.includes('upload-live-1')) {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': String(offset) },
        })
      }
      if (method === 'PATCH' && url.includes('upload-live-1')) {
        const body = init?.body
        let len = 0

        if (body instanceof Uint8Array) {
          len = body.byteLength
        } else if (body instanceof ArrayBuffer) {
          len = body.byteLength
        } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
          len = body.size
        } else if (typeof body === 'string') {
          len = body.length
        }
        // Fallback: Content-Length header (Blob/stream mocks)
        if (len === 0) {
          const cl = (init?.headers as Record<string, string> | undefined)?.['Content-Length']

          len = cl !== undefined ? Number(cl) : 0
        }
        if (len === 0) {
          throw new Error('mock PATCH missing body length')
        }
        offset += len

        return new Response(null, {
          status: 204,
          headers: { 'Upload-Offset': String(offset) },
        })
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

    try {
      const transfer = createSupabaseTransfer({
        client: makeClient({ uploadCalls }),
        fileStore: memoryFileStore(files),
        // Force TUS for a 5-byte payload
        singleShotMaxBytes: 2,
        tusEndpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
      })

      const handle = await transfer.createUpload(
        'big.bin',
        { bucket: 'media', path: 'u1/big.bin', contentType: 'application/octet-stream' },
        { sha256: 'cafebabe' },
      )

      expect(handle.resumable).toBe(true)
      // The session does not exist yet when createUpload returns (the create POST is still queued behind the auth lookup); the token arrives through the listener, BEFORE the first chunk, which is the only moment early enough for an interrupted upload to be resumable.
      const announced: Array<{ url: string; patchesBefore: number }> = []

      handle.onSessionCreated?.((url) => {
        announced.push({
          url,
          patchesBefore: fetchCalls.filter((call) => call.method === 'PATCH').length,
        })
      })
      expect(handle.fingerprint).toBe('')

      await handle.done

      expect(announced).toEqual([
        { url: 'https://abc.storage.supabase.co/files/upload-live-1', patchesBefore: 0 },
      ])
      expect(handle.fingerprint).toBe('https://abc.storage.supabase.co/files/upload-live-1')
      // Must not have used storage-js single-shot
      expect(uploadCalls).toHaveLength(0)
      expect(fetchCalls.some((c) => c.method === 'POST')).toBe(true)
      expect(fetchCalls.some((c) => c.method === 'PATCH')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('resumeFingerprint is passed through as TUS resumeUrl (HEAD + PATCH, no POST)', async () => {
    const payload = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1])
    const files = new Map<string, Uint8Array>([['resume.bin', payload]])
    const uploadCalls: TUploadCall[] = []
    const resumeUrl = 'https://abc.storage.supabase.co/files/existing-upload'
    let offset = 3
    const methods: string[] = []
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      methods.push(method)

      if (method === 'HEAD' && url === resumeUrl) {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(payload.byteLength) },
        })
      }
      if (method === 'PATCH' && url === resumeUrl) {
        const body = init?.body
        let len = 0

        if (body instanceof Uint8Array) {
          len = body.byteLength
        } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
          len = body.size
        } else {
          const cl = (init?.headers as Record<string, string> | undefined)?.['Content-Length']

          len = cl !== undefined ? Number(cl) : 0
        }
        if (len === 0) {
          throw new Error('mock resume PATCH missing body length')
        }
        offset += len

        return new Response(null, {
          status: 204,
          headers: { 'Upload-Offset': String(offset) },
        })
      }
      // POST would mean create was called: fail loudly
      return new Response(`unexpected ${method} ${url}`, { status: 500 })
    }) as typeof fetch

    try {
      const transfer = createSupabaseTransfer({
        client: makeClient({ uploadCalls }),
        fileStore: memoryFileStore(files),
        singleShotMaxBytes: 1,
        tusEndpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
      })

      const handle = await transfer.createUpload(
        'resume.bin',
        { bucket: 'media', path: 'u1/resume.bin', contentType: 'application/octet-stream' },
        { sha256: 'resume-sha', resumeFingerprint: resumeUrl },
      )

      expect(handle.resumable).toBe(true)
      expect(handle.fingerprint).toBe(resumeUrl)
      await handle.done
      expect(handle.fingerprint).toBe(resumeUrl)
      expect(methods).toContain('HEAD')
      expect(methods).toContain('PATCH')
      expect(methods).not.toContain('POST')
      expect(uploadCalls).toHaveLength(0)
      expect(offset).toBe(payload.byteLength)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('bytes exactly at threshold still take the single-shot path', async () => {
    const payload = new Uint8Array([1, 2, 3])
    const files = new Map<string, Uint8Array>([['edge.bin', payload]])
    const uploadCalls: TUploadCall[] = []
    const transfer = createSupabaseTransfer({
      client: makeClient({ uploadCalls }),
      fileStore: memoryFileStore(files),
      singleShotMaxBytes: 3,
    })

    const handle = await transfer.createUpload(
      'edge.bin',
      { bucket: 'b', path: 'p', contentType: 'application/octet-stream' },
      { sha256: 'x' },
    )

    expect(handle.resumable).toBe(false)
    await handle.done
    expect(uploadCalls).toHaveLength(1)
  })
})

// MARK: - TUS termination

/**
 * The attachment queue drains `handle.progress` to completion BEFORE it awaits
 * `handle.done`, so a progress iterable that ends only on success turns one
 * failed or aborted >6 MiB upload into a permanent stall of every later sync.
 * Both tests iterate the progress to exhaustion under HANG_GUARD_MS: a
 * regression fails the test instead of hanging the suite.
 */

describe('createSupabaseTransfer TUS termination', () => {
  test(
    'a chunk failure mid-upload ends progress and surfaces through done',
    async () => {
      const payload = new Uint8Array(TUS_CHUNK_SIZE * 2)
      const files = new Map<string, Uint8Array>([['huge.bin', payload]])
      const uploadCalls: TUploadCall[] = []
      const rejections: unknown[] = []
      const recordRejection = (reason: unknown): void => {
        rejections.push(reason)
      }
      const originalFetch = globalThis.fetch
      let uploaded = 0

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()

        if (method === 'POST') {
          return new Response(null, {
            status: 201,
            headers: { Location: 'https://abc.storage.supabase.co/files/dying-1' },
          })
        }
        if (method === 'PATCH' && uploaded === 0) {
          uploaded = TUS_CHUNK_SIZE

          return new Response(null, { status: 204, headers: { 'Upload-Offset': String(uploaded) } })
        }
        return new Response('storage exploded', { status: 500 })
      }) as typeof fetch
      // bun-types@1.4.0 declares `off(event: "memoryPressure", ...)` directly on the Process interface, which hides the generic `off` inherited from EventEmitter, so this goes through a typed view of the base interface instead of a version pin.
      const emitter: NodeJS.EventEmitter = process

      process.on('unhandledRejection', recordRejection)

      try {
        const transfer = createSupabaseTransfer({
          client: makeClient({ uploadCalls }),
          fileStore: memoryFileStore(files),
          tusEndpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
        })
        const handle = await transfer.createUpload(
          'huge.bin',
          { bucket: 'media', path: 'u1/huge.bin', contentType: 'application/octet-stream' },
          { sha256: 'huge-sha' },
        )

        const seen: number[] = []

        for await (const value of handle.progress) {
          seen.push(value)
        }
        expect(seen).toEqual([50]) // one chunk landed, then the transfer died

        const failure = await handle.done.then(
          () => null,
          (error: unknown) => error,
        )

        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain('tus PATCH failed')
        // The rejection travels on done alone: draining progress first must not orphan it.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(rejections).toEqual([])
      } finally {
        emitter.off('unhandledRejection', recordRejection)
        globalThis.fetch = originalFetch
      }
    },
    HANG_GUARD_MS,
  )

  test(
    'abort ends progress, cancels the chunk fetch, and rejects done',
    async () => {
      const payload = new Uint8Array(TUS_CHUNK_SIZE + 1)
      const files = new Map<string, Uint8Array>([['aborted.bin', payload]])
      const uploadCalls: TUploadCall[] = []
      const originalFetch = globalThis.fetch
      let abortReachedFetch = false
      let inFlight: IUploadHandle | null = null

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()

        if (method === 'POST') {
          return new Response(null, {
            status: 201,
            headers: { Location: 'https://abc.storage.supabase.co/files/abort-1' },
          })
        }
        // The user cancels while the first chunk is in flight.
        await inFlight?.abort()
        abortReachedFetch = init?.signal?.aborted === true

        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }) as typeof fetch

      try {
        const transfer = createSupabaseTransfer({
          client: makeClient({ uploadCalls }),
          fileStore: memoryFileStore(files),
          tusEndpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
        })
        const handle = await transfer.createUpload(
          'aborted.bin',
          { bucket: 'media', path: 'u1/aborted.bin', contentType: 'application/octet-stream' },
          { sha256: 'abort-sha' },
        )

        inFlight = handle

        const seen: number[] = []

        for await (const value of handle.progress) {
          seen.push(value)
        }
        expect(seen).toEqual([]) // not one byte was acknowledged

        const failure = await handle.done.then(
          () => null,
          (error: unknown) => error,
        )

        expect((failure as Error).message).toContain('aborted')
        // A caller abort must never be mistaken for a blown deadline.
        expect((failure as { code?: string }).code).not.toBe(ETransferError.timedOut)
        expect(abortReachedFetch).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
    HANG_GUARD_MS,
  )
})

// MARK: - createSupabaseTransfer download

/**
 * download() must only re-queue (ETransferError.notYetAvailable) when the object is
 * plausibly not uploaded yet: a structured 404 from createSignedUrl or from the
 * signed-url fetch. Every other failure (403/401/5xx/network) is a real failure and
 * must surface as a plain Error so the attachment queue's failed-path (attempts++)
 * handles it, never an eternal silent 'queued' wait.
 */
type TSignedUrlResult = {
  data: { signedUrl: string } | null
  error: { message: string; status?: number; statusCode?: string; code?: string } | null
}

const clientWithSignedUrl = (signed: TSignedUrlResult): SupabaseClient =>
  ({
    /**
     * createSupabaseTransfer calls client.schema(SCHEMA) unconditionally at setup,
     * regardless of which method is exercised; download() never touches it.
     */
    schema: () => ({}),
    storage: { from: () => ({ createSignedUrl: async () => signed }) },
  }) as unknown as SupabaseClient

describe('createSupabaseTransfer download', () => {
  test('a 404 signed-url error throws the notYetAvailable transfer code (re-queueable)', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: null, error: { message: 'object not found', status: 404 } }),
      fileStore: memoryFileStore(new Map()),
    })

    const caught: { code?: string } = {}

    await transfer
      .download({ bucket: 'todos', path: 'missing.jpg' }, '/local/x.jpg')
      .catch((error: { code?: string }) => {
        caught.code = error.code
      })
    expect(caught.code).toBe(ETransferError.notYetAvailable)
  })

  test('a 403 signed-url error throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: null, error: { message: 'permission denied', status: 403 } }),
      fileStore: memoryFileStore(new Map()),
    })

    const caught: { code?: string; message?: string } = {}

    await transfer
      .download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')
      .catch((error: { code?: string; message?: string }) => {
        caught.code = error.code
        caught.message = error.message
      })
    expect(caught.code).toBeUndefined()
    expect(caught.message).toContain('403')
  })

  test('a 500 signed-url error throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: null, error: { message: 'internal error', status: 500 } }),
      fileStore: memoryFileStore(new Map()),
    })

    const caught: { code?: string; message?: string } = {}

    await transfer
      .download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')
      .catch((error: { code?: string; message?: string }) => {
        caught.code = error.code
        caught.message = error.message
      })
    expect(caught.code).toBeUndefined()
    expect(caught.message).toContain('500')
  })

  test('a 404 fetch response throws the notYetAvailable transfer code (re-queueable)', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
      fileStore: memoryFileStore(new Map()),
    })
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch

    try {
      const caught: { code?: string } = {}

      await transfer
        .download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')
        .catch((error: { code?: string }) => {
          caught.code = error.code
        })
      expect(caught.code).toBe(ETransferError.notYetAvailable)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a 403 fetch response throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
      fileStore: memoryFileStore(new Map()),
    })
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch

    try {
      const caught: { code?: string; message?: string } = {}

      await transfer
        .download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')
        .catch((error: { code?: string; message?: string }) => {
          caught.code = error.code
          caught.message = error.message
        })
      expect(caught.code).toBeUndefined()
      expect(caught.message).toContain('403')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a 500 fetch response throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
      fileStore: memoryFileStore(new Map()),
    })
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch

    try {
      const caught: { code?: string; message?: string } = {}

      await transfer
        .download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')
        .catch((error: { code?: string; message?: string }) => {
          caught.code = error.code
          caught.message = error.message
        })
      expect(caught.code).toBeUndefined()
      expect(caught.message).toContain('500')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// MARK: - createSupabaseTransfer deadlines

/**
 * Every call without its own abort support (single-shot upload, createSignedUrl,
 * storage.remove, auth.getSession) races withDeadline; every call with abort
 * support (TUS fetches, the download fetch, the confirm/vacuum RPCs, the
 * metadata select) uses createRequestSignal and rejects with
 * ETransferError.timedOut once its OWN deadline (not a caller abort, see the
 * abort test above) wins.
 */

describe('createSupabaseTransfer deadlines', () => {
  test(
    'single-shot upload times out under bytesTimeoutMs and progress still ends',
    async () => {
      const files = new Map<string, Uint8Array>([['local.bin', new Uint8Array([1, 2, 3, 4])]])
      const uploadCalls: TUploadCall[] = []
      const transfer = createSupabaseTransfer({
        client: makeClient({ uploadCalls, hangUpload: true }),
        fileStore: memoryFileStore(files),
        bytesTimeoutMs: 25,
      })

      const handle = await transfer.createUpload(
        'local.bin',
        { bucket: 'media', path: 'u1/p1.bin', contentType: 'application/octet-stream' },
        { sha256: 'deadbeef' },
      )

      const progress: number[] = []

      for await (const p of handle.progress) {
        progress.push(p)
      }
      expect(progress).toEqual([100])

      const failure = await handle.done.then(
        () => null,
        (error: unknown) => error,
      )

      expect((failure as { code?: string }).code).toBe(ETransferError.timedOut)
    },
    HANG_GUARD_MS,
  )

  test(
    'a stalled TUS PATCH times out under bytesTimeoutMs, keeps the session URL, and the signal observes the abort',
    async () => {
      const payload = new Uint8Array(TUS_CHUNK_SIZE + 1)
      const files = new Map<string, Uint8Array>([['huge.bin', payload]])
      const uploadCalls: TUploadCall[] = []
      const originalFetch = globalThis.fetch
      let patchSignalAborted = false

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()

        if (method === 'POST') {
          return new Response(null, {
            status: 201,
            headers: { Location: 'https://abc.storage.supabase.co/files/stall-1' },
          })
        }
        if (method === 'PATCH') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              patchSignalAborted = init?.signal?.aborted === true
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
            })
          })
        }
        return new Response('unexpected', { status: 500 })
      }) as typeof fetch

      try {
        const transfer = createSupabaseTransfer({
          client: makeClient({ uploadCalls }),
          fileStore: memoryFileStore(files),
          tusEndpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
          bytesTimeoutMs: 25,
        })
        const handle = await transfer.createUpload(
          'huge.bin',
          { bucket: 'media', path: 'u1/huge.bin', contentType: 'application/octet-stream' },
          { sha256: 'huge-sha' },
        )

        const sessions: string[] = []

        handle.onSessionCreated?.((url) => {
          sessions.push(url)
        })

        const seen: number[] = []

        for await (const value of handle.progress) {
          seen.push(value)
        }

        const failure = await handle.done.then(
          () => null,
          (error: unknown) => error,
        )

        expect((failure as { code?: string }).code).toBe(ETransferError.timedOut)
        // The session URL survived the chunk timeout: a later attempt resumes from it.
        expect(sessions).toEqual(['https://abc.storage.supabase.co/files/stall-1'])
        expect(handle.fingerprint).toBe('https://abc.storage.supabase.co/files/stall-1')
        expect(patchSignalAborted).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
    HANG_GUARD_MS,
  )

  test(
    'confirm times out under controlTimeoutMs',
    async () => {
      const uploadCalls: TUploadCall[] = []
      const transfer = createSupabaseTransfer({
        client: makeClient({ uploadCalls, hangConfirm: true }),
        fileStore: memoryFileStore(new Map()),
        controlTimeoutMs: 25,
      })

      const failure = await transfer
        .confirm(
          { bucket: 'media', path: 'u1/p1.bin' },
          { sha256: 'x', size: 4, contentType: 'application/octet-stream' },
          'todos',
        )
        .then(
          () => null,
          (error: unknown) => error,
        )

      expect((failure as { code?: string }).code).toBe(ETransferError.timedOut)
    },
    HANG_GUARD_MS,
  )

  test(
    'a hung auth session on the TUS path rejects done with AUTH_SESSION_TIMEOUT',
    async () => {
      const files = new Map<string, Uint8Array>([['big.bin', new Uint8Array(10)]])
      const uploadCalls: TUploadCall[] = []
      const transfer = createSupabaseTransfer({
        client: makeClient({ uploadCalls, hangGetSession: true }),
        fileStore: memoryFileStore(files),
        singleShotMaxBytes: 2, // force TUS, the only path that resolves an access token
        controlTimeoutMs: 25,
      })

      const handle = await transfer.createUpload(
        'big.bin',
        { bucket: 'media', path: 'u1/big.bin', contentType: 'application/octet-stream' },
        { sha256: 'big-sha' },
      )
      const failure = await handle.done.then(
        () => null,
        (error: unknown) => error,
      )

      expect((failure as { code?: string }).code).toBe(AUTH_SESSION_TIMEOUT)
    },
    HANG_GUARD_MS,
  )

  test('controlTimeoutMs: 0 and bytesTimeoutMs: 0 arm no timer', async () => {
    const throwingTimer = (): never => {
      throw new Error('setTimer/clearTimer must not be called when timeouts are disabled')
    }
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
      fileStore: memoryFileStore(new Map()),
      controlTimeoutMs: 0,
      bytesTimeoutMs: 0,
      setTimer: throwingTimer,
      clearTimer: throwingTimer,
    })
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () =>
      new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 })) as unknown as typeof fetch

    try {
      // Both createSignedUrl (control) and the signed fetch (bytes) run below: a throw from either injected timer would fail this test.
      await expect(transfer.download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// MARK: - Confirm and refusals

describe('createSupabaseTransfer confirm and refusals', () => {
  test('attachment_confirm names the table whose row carries the reference', async () => {
    const rpcCalls: Array<{ fn: string; args: unknown }> = []
    const transfer = createSupabaseTransfer({
      client: makeClient({ uploadCalls: [], rpcCalls }),
      fileStore: memoryFileStore(new Map()),
    })

    await transfer.confirm(
      { bucket: 'todos', path: 'u1/p1/up-1.png' },
      { sha256: 'abc', size: 4, contentType: 'image/png' },
      'todos',
    )

    expect(rpcCalls).toEqual([
      {
        fn: 'attachment_confirm',
        args: {
          p_bucket: 'todos',
          p_path: 'u1/p1/up-1.png',
          p_sha256: 'abc',
          p_size: 4,
          p_media_type: 'image/png',
          p_table: 'todos',
        },
      },
    ])
  })

  test('a refused RPC carries the HTTP status PostgREST answered', async () => {
    const transfer = createSupabaseTransfer({
      client: makeClient({
        uploadCalls: [],
        rpcResult: { data: null, error: { message: 'JWT expired' }, status: 401 },
      }),
      fileStore: memoryFileStore(new Map()),
    })
    const statusOf = (pending: Promise<unknown>): Promise<unknown> =>
      pending.then(
        () => 'resolved',
        (error: { status?: unknown }) => error.status,
      )

    expect(
      await statusOf(
        transfer.confirm({ bucket: 'todos', path: 'p' }, { sha256: 'abc', size: 4, contentType: 'image/png' }, 'todos'),
      ),
    ).toBe(401)
    expect(await statusOf(transfer.metadata({ bucket: 'todos', path: 'p' }))).toBe(401)
    expect(await statusOf(transfer.remove({ bucket: 'todos', path: 'p' }))).toBe(401)
  })

  test('a refused single-shot upload carries the status Storage answered', async () => {
    const files = new Map<string, Uint8Array>([['small.bin', new Uint8Array([1, 2])]])
    const transfer = createSupabaseTransfer({
      client: makeClient({ uploadCalls: [], uploadError: { message: 'refused', status: 403 } as { message: string } }),
      fileStore: memoryFileStore(files),
    })

    const handle = await transfer.createUpload(
      'small.bin',
      { bucket: 'todos', path: 'p', contentType: 'application/octet-stream' },
      { sha256: 'x' },
    )
    const status = await handle.done.then(
      () => 'resolved',
      (error: { status?: unknown }) => error.status,
    )

    expect(status).toBe(403)
  })
})

// MARK: - The status Storage means

/**
 * Supabase Storage answers most refusals with HTTP 400 and names the status it
 * means in the body: storage-js keeps the HTTP status in `status`, the body's
 * `statusCode` in `statusCode`, and the error name in `code`. The adapter
 * reports the status Storage means.
 */
const storageError = (statusCode: string, code: string) => ({ message: 'refused', status: 400, statusCode, code })

const failureOf = (pending: Promise<unknown>): Promise<{ code?: unknown; status?: unknown }> =>
  pending.then(
    () => ({}),
    (error: { code?: unknown; status?: unknown }) => ({ code: error.code, status: error.status }),
  )

describe('createSupabaseTransfer: the status Storage means', () => {
  test('a signed-url refusal whose body names 404, or NoSuchKey, is not yet available', async () => {
    for (const error of [storageError('404', 'not_found'), storageError('400', 'NoSuchKey')]) {
      const transfer = createSupabaseTransfer({
        client: clientWithSignedUrl({ data: null, error }),
        fileStore: memoryFileStore(new Map()),
      })

      expect(await failureOf(transfer.download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))).toEqual({
        code: ETransferError.notYetAvailable,
        status: 404,
      })
    }
  })

  test('a signed-url refusal whose body names 401, or InvalidJWT, refuses the session', async () => {
    for (const error of [storageError('401', 'Unauthorized'), storageError('400', 'InvalidJWT')]) {
      const transfer = createSupabaseTransfer({
        client: clientWithSignedUrl({ data: null, error }),
        fileStore: memoryFileStore(new Map()),
      })

      expect(await failureOf(transfer.download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))).toEqual({
        code: undefined,
        status: 401,
      })
    }
  })

  test('a signed fetch answering 400 with a body-carried 404 is not yet available', async () => {
    const transfer = createSupabaseTransfer({
      client: clientWithSignedUrl({ data: { signedUrl: 'https://storage.example/signed' }, error: null }),
      fileStore: memoryFileStore(new Map()),
    })
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), {
        status: 400,
      })) as unknown as typeof fetch

    try {
      expect(await failureOf(transfer.download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))).toEqual({
        code: ETransferError.notYetAvailable,
        status: 404,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a refused upload and a refused removal carry the status the body names', async () => {
    const files = new Map<string, Uint8Array>([['small.bin', new Uint8Array([1, 2])]])
    const upload = async (uploadError: unknown): Promise<unknown> => {
      const transfer = createSupabaseTransfer({
        client: makeClient({ uploadCalls: [], uploadError: uploadError as { message: string } }),
        fileStore: memoryFileStore(files),
      })
      const handle = await transfer.createUpload(
        'small.bin',
        { bucket: 'todos', path: 'p', contentType: 'application/octet-stream' },
        { sha256: 'x' },
      )

      return (await failureOf(handle.done)).status
    }
    const removal = createSupabaseTransfer({
      client: makeClient({ uploadCalls: [], removeError: storageError('403', 'AccessDenied') }),
      fileStore: memoryFileStore(new Map()),
    })

    expect(await upload(storageError('403', 'AccessDenied'))).toBe(403)
    expect(await upload(storageError('400', 'InvalidJWT'))).toBe(401)
    expect(await upload({ message: 'refused', status: 400 })).toBe(400)
    expect((await failureOf(removal.remove({ bucket: 'todos', path: 'p' }))).status).toBe(403)
  })
})
