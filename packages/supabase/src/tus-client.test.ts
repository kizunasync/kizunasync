/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { ETransferError } from '@kizunasync/core'
import { SINGLE_SHOT_MAX_BYTES, TUS_CHUNK_SIZE, resolveTusLocation, tusEndpointFromSupabaseUrl, tusHeadOffset, tusPatchAll, tusUpload } from './tus-client'

/**
 * Every async timeout/hang test runs under an explicit cap so a termination
 * regression fails loudly instead of hanging the suite.
 */
const HANG_GUARD_MS = 5_000

describe('tus client', () => {
  test('threshold constants match Supabase 6 MiB policy', () => {
    expect(TUS_CHUNK_SIZE).toBe(6 * 1024 * 1024)
    expect(SINGLE_SHOT_MAX_BYTES).toBe(TUS_CHUNK_SIZE)
  })

  test('tusEndpointFromSupabaseUrl rewrites project host to storage host', () => {
    expect(tusEndpointFromSupabaseUrl('https://abc.supabase.co')).toBe(
      'https://abc.storage.supabase.co/storage/v1/upload/resumable',
    )
    expect(tusEndpointFromSupabaseUrl('https://abc.supabase.co/')).toBe(
      'https://abc.storage.supabase.co/storage/v1/upload/resumable',
    )
  })

  test('resolveTusLocation joins relative paths and rejects a foreign origin', () => {
    const endpoint = 'https://abc.storage.supabase.co/storage/v1/upload/resumable'

    expect(resolveTusLocation(endpoint, '/files/upload-1')).toBe(
      'https://abc.storage.supabase.co/files/upload-1',
    )
    expect(resolveTusLocation(endpoint, 'https://abc.storage.supabase.co/files/upload-1')).toBe(
      'https://abc.storage.supabase.co/files/upload-1',
    )
    expect(() => resolveTusLocation(endpoint, 'https://evil.example/steal')).toThrow(
      /origin mismatch/,
    )
  })

  test('tusEndpointFromSupabaseUrl keeps custom domains on rest path', () => {
    expect(tusEndpointFromSupabaseUrl('https://db.example.com')).toBe(
      'https://db.example.com/storage/v1/upload/resumable',
    )
  })

  test('tusUpload creates session and PATCHes chunks against a fake server', async () => {
    const chunks: number[] = []
    let offset = 0
    const total = 10
    const data = new Uint8Array(total).fill(7)

    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (method === 'POST' && url.includes('/upload/resumable')) {
        return new Response(null, {
          status: 201,
          headers: { Location: 'https://abc.storage.supabase.co/files/upload-1' },
        })
      }
      if (method === 'HEAD' && url.includes('upload-1')) {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': String(offset) },
        })
      }
      if (method === 'PATCH' && url.includes('upload-1')) {
        const body = init?.body
        const len =
          body instanceof Uint8Array
            ? body.byteLength
            : body instanceof ArrayBuffer
              ? body.byteLength
              : 0

        chunks.push(len)
        offset += len

        return new Response(null, {
          status: 204,
          headers: { 'Upload-Offset': String(offset) },
        })
      }
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

    try {
      const result = await tusUpload({
        endpoint: 'https://abc.storage.supabase.co/storage/v1/upload/resumable',
        accessToken: 'tok',
        bucket: 'media',
        objectName: 'u1/p1.bin',
        contentType: 'application/octet-stream',
        data,
        // Force multi-chunk by lowering effective path: data is small so one PATCH
      })

      expect(result.uploadUrl).toContain('upload-1')
      expect(result.bytesUploaded).toBe(total)
      expect(chunks.reduce((a, b) => a + b, 0)).toBe(total)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('tusUpload resumes from fingerprint offset', async () => {
    let offset = 4
    const data = new Uint8Array(8).fill(1)
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()

      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(data.byteLength) },
        })
      }
      if (method === 'PATCH') {
        const body = init?.body as Uint8Array

        offset += body.byteLength

        return new Response(null, {
          status: 204,
          headers: { 'Upload-Offset': String(offset) },
        })
      }
      return new Response('no', { status: 500 })
    }) as typeof fetch

    try {
      const result = await tusUpload({
        endpoint: 'https://x/storage/v1/upload/resumable',
        accessToken: 't',
        bucket: 'b',
        objectName: 'o',
        contentType: 'application/octet-stream',
        data,
        resumeUrl: 'https://x/files/existing',
      })

      expect(result.bytesUploaded).toBe(8)
      expect(result.uploadUrl).toBe('https://x/files/existing')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('tusPatchAll throws when a 409 HEAD offset is not a number', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()

      if (method === 'PATCH') {
        return new Response(null, { status: 409 })
      }
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': 'nope' },
        })
      }
      return new Response('no', { status: 500 })
    }) as typeof fetch

    try {
      await expect(
        tusPatchAll({ uploadUrl: 'https://x/files/u', accessToken: 't', data: new Uint8Array(8), startOffset: 0 }),
      ).rejects.toThrow(/non-numeric Upload-Offset/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('tusPatchAll throws when a 409 HEAD does not advance', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()

      if (method === 'PATCH') {
        return new Response(null, { status: 409 })
      }
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Upload-Offset': '0', 'Upload-Length': '8' },
        })
      }
      return new Response('no', { status: 500 })
    }) as typeof fetch

    try {
      await expect(
        tusPatchAll({ uploadUrl: 'https://x/files/u', accessToken: 't', data: new Uint8Array(8), startOffset: 0 }),
      ).rejects.toThrow(/409 did not advance offset/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// MARK: - tusPatchAll timeout

describe('tusPatchAll timeout', () => {
  test(
    'a stalled PATCH throws timedOut, and a later HEAD + PATCH resumes from the session URL',
    async () => {
      const uploadUrl = 'https://x/files/stall'
      let offset = 0
      let patchAttempt = 0
      const originalFetch = globalThis.fetch

      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()

        if (method === 'HEAD') {
          return new Response(null, { status: 200, headers: { 'Upload-Offset': String(offset) } })
        }
        if (method === 'PATCH') {
          patchAttempt += 1

          if (patchAttempt === 1) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
              })
            })
          }
          const body = init?.body as Uint8Array

          offset += body.byteLength

          return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } })
        }
        return new Response('unexpected', { status: 500 })
      }) as typeof fetch

      try {
        const data = new Uint8Array(8).fill(1)

        const failure = await tusPatchAll({
          uploadUrl,
          accessToken: 't',
          data,
          startOffset: 0,
          requestOptions: { timeoutMs: 10 },
        }).then(
          () => null,
          (error: unknown) => error,
        )

        expect((failure as { code?: string }).code).toBe(ETransferError.timedOut)
        expect(offset).toBe(0) // nothing landed server-side from the stalled attempt

        // Resume: the caller re-probes the offset and retries the PATCH against the SAME session URL: the timeout above never invalidated it.
        const probed = await tusHeadOffset(uploadUrl, 't')

        expect(probed).toBe(0)
        const result = await tusPatchAll({ uploadUrl, accessToken: 't', data, startOffset: probed })

        expect(result).toBe(8)
      } finally {
        globalThis.fetch = originalFetch
      }
    },
    HANG_GUARD_MS,
  )
})

// MARK: - Resume and refusals

/**
 * A fake TUS host: `head` answers the offset probe of `existing`, a create
 * opens `created`, and every PATCH lands whole. Each request is recorded as
 * `METHOD url`.
 */
const fakeTusHost = (head: () => Response) => {
  const requests: string[] = []
  const created = 'https://abc.storage.supabase.co/files/created-1'
  let offset = 0
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    requests.push(`${method} ${url}`)

    if (method === 'HEAD') {
      return head()
    }
    if (method === 'POST') {
      return new Response(null, { status: 201, headers: { Location: created } })
    }
    if (method === 'PATCH') {
      offset += (init?.body as Uint8Array).byteLength

      return new Response(null, { status: 204, headers: { 'Upload-Offset': String(offset) } })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch

  return { requests, created, fetchImpl }
}

const withFetch = async <T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = fetchImpl

  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const ENDPOINT = 'https://abc.storage.supabase.co/storage/v1/upload/resumable'
const EXISTING = 'https://abc.storage.supabase.co/files/existing-1'

const resumeUpload = (resumeUrl: string) =>
  tusUpload({
    endpoint: ENDPOINT,
    accessToken: 't',
    bucket: 'b',
    objectName: 'o',
    contentType: 'application/octet-stream',
    data: new Uint8Array(8).fill(3),
    resumeUrl,
  })

const failureOf = (pending: Promise<unknown>): Promise<{ code?: unknown; status?: unknown }> =>
  pending.then(
    () => ({}),
    (error: { code?: unknown; status?: unknown }) => ({ code: error.code, status: error.status }),
  )

describe('tus resume and refusals', () => {
  test('a session the probe says is gone (404/410) is replaced by a new one', async () => {
    for (const status of [404, 410]) {
      const host = fakeTusHost(() => new Response(null, { status }))
      const result = await withFetch(host.fetchImpl, () => resumeUpload(EXISTING))

      expect(result).toEqual({ uploadUrl: host.created, bytesUploaded: 8 })
    }
  })

  test('any other refused probe drops the session: the upload-expired code and the status, no new session', async () => {
    const host = fakeTusHost(() => new Response(null, { status: 403 }))
    const failure = await withFetch(host.fetchImpl, () => failureOf(resumeUpload(EXISTING)))

    expect(failure).toEqual({ code: ETransferError.expired, status: 403 })
    expect(host.requests).toEqual([`HEAD ${EXISTING}`])
  })

  test('a server error on the probe carries its status and keeps the session', async () => {
    const host = fakeTusHost(() => new Response(null, { status: 503 }))
    const failure = await withFetch(host.fetchImpl, () => failureOf(resumeUpload(EXISTING)))

    expect(failure).toEqual({ code: undefined, status: 503 })
  })

  test('a persisted session on another origin is never contacted: a new session replaces it', async () => {
    const host = fakeTusHost(() => new Response(null, { status: 200, headers: { 'Upload-Offset': '0', 'Upload-Length': '8' } }))
    const result = await withFetch(host.fetchImpl, () => resumeUpload('https://evil.example/files/stolen'))

    expect(result.uploadUrl).toBe(host.created)
    expect(host.requests.some((request) => request.includes('evil.example'))).toBe(false)
  })

  test('a persisted session that declares another length, or none, is replaced by a new one', async () => {
    const headersVariants: Record<string, string>[] = [{ 'Upload-Offset': '0', 'Upload-Length': '7' }, { 'Upload-Offset': '0' }]

    for (const headers of headersVariants) {
      const host = fakeTusHost(() => new Response(null, { status: 200, headers }))
      const result = await withFetch(host.fetchImpl, () => resumeUpload(EXISTING))

      expect(result).toEqual({ uploadUrl: host.created, bytesUploaded: 8 })
    }
  })

  test('a refused PATCH and a refused create carry their status', async () => {
    const refusedPatch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET').toUpperCase() === 'PATCH'
        ? new Response('no', { status: 403 })
        : new Response(null, { status: 200, headers: { 'Upload-Offset': '0', 'Upload-Length': '8' } })) as typeof fetch
    const refusedCreate = (async () => new Response('no', { status: 400 })) as unknown as typeof fetch

    expect(await withFetch(refusedPatch, () => failureOf(resumeUpload(EXISTING)))).toEqual({ code: undefined, status: 403 })
    expect(
      await withFetch(refusedCreate, () =>
        failureOf(
          tusUpload({ endpoint: ENDPOINT, accessToken: 't', bucket: 'b', objectName: 'o', contentType: 'x', data: new Uint8Array(8) }),
        ),
      ),
    ).toEqual({ code: undefined, status: 400 })
  })

  test('a refusal whose body names the status Storage means carries that status', async () => {
    const storageRefusal = (statusCode: string, code: string): Response =>
      new Response(JSON.stringify({ statusCode, code, error: code, message: 'refused' }), { status: 400 })
    const refusingPatchWith = (refusal: () => Response) =>
      (async (_input: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? 'GET').toUpperCase() === 'PATCH'
          ? refusal()
          : new Response(null, { status: 200, headers: { 'Upload-Offset': '0', 'Upload-Length': '8' } })) as typeof fetch
    const create = () =>
      failureOf(tusUpload({ endpoint: ENDPOINT, accessToken: 't', bucket: 'b', objectName: 'o', contentType: 'x', data: new Uint8Array(8) }))

    expect(
      await withFetch(refusingPatchWith(() => storageRefusal('401', 'Unauthorized')), () => failureOf(resumeUpload(EXISTING))),
    ).toEqual({ code: undefined, status: 401 })
    expect(
      await withFetch((async () => storageRefusal('403', 'AccessDenied')) as unknown as typeof fetch, create),
    ).toEqual({ code: undefined, status: 403 })
    expect(
      await withFetch((async () => storageRefusal('400', 'InvalidJWT')) as unknown as typeof fetch, create),
    ).toEqual({ code: undefined, status: 401 })
  })

  test('a conflict re-probe the host refuses drops the session', async () => {
    const conflicted = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET').toUpperCase() === 'PATCH'
        ? new Response(null, { status: 409 })
        : new Response(null, { status: 403 })) as typeof fetch
    const failure = await withFetch(conflicted, () =>
      failureOf(tusPatchAll({ uploadUrl: EXISTING, accessToken: 't', data: new Uint8Array(8), startOffset: 0 })),
    )

    expect(failure).toEqual({ code: ETransferError.expired, status: 403 })
  })
})
