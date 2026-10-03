/// <reference types="bun" />
/**
 * @kizunasync/expo download decorator: proves createExpoSupabaseDownload composes a
 * working ITransfer['download'] over a signed URL + expo/fetch, headlessly.
 * expo/fetch is the only mocked dependency (a WHATWG Response fake); the
 * Supabase client and file store are plain fakes, because @supabase/supabase-js is a
 * type-only import in the module under test, never a runtime one, so nothing
 * ever reaches a real network.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ETransferError, sha256Hex, type IFileStore } from '@kizunasync/core'

let fetchCalls: string[] = []
let fetchSignals: Array<AbortSignal | undefined> = []
let fetchImpl: (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }> = async () => {
  throw new Error('fetchImpl not set for this test')
}

mock.module('expo/fetch', () => ({
  fetch: (url: string, init?: { signal?: AbortSignal }) => {
    fetchCalls.push(url)
    fetchSignals.push(init?.signal)

    return fetchImpl(url, init)
  },
}))

const { createExpoSupabaseDownload } = await import('./transfer')

const BYTES = new TextEncoder().encode('hello attachment bytes').buffer as ArrayBuffer

type TSignedUrlResult = {
  data: { signedUrl: string } | null
  error: { message: string; status?: number } | null
}

const clientWith = (signed: TSignedUrlResult): SupabaseClient =>
  ({
    storage: { from: () => ({ createSignedUrl: async () => signed }) },
  }) as unknown as SupabaseClient

const recordingFileStore = (): { fileStore: IFileStore; written: Array<{ path: string; bytes: ArrayBuffer }> } => {
  const written: Array<{ path: string; bytes: ArrayBuffer }> = []
  const fileStore = {
    writeAtomic: async (path: string, bytes: ArrayBuffer) => {
      written.push({ path, bytes })
    },
  } as unknown as IFileStore

  return { fileStore, written }
}

describe('createExpoSupabaseDownload', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchSignals = []
    fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => BYTES })
  })

  test('downloads bytes over a signed URL via expo/fetch and writes them atomically', async () => {
    const { fileStore, written } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
    const download = createExpoSupabaseDownload({ client, fileStore })

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    expect(fetchCalls).toEqual(['https://storage.example/signed'])
    expect(written).toHaveLength(1)
    expect(written[0]!.path).toBe('/local/1.jpg')
    expect(new Uint8Array(written[0]!.bytes)).toEqual(new Uint8Array(BYTES))
  })

  test('verifies the sha256 and rejects a mismatch before writing', async () => {
    const { fileStore, written } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
    const download = createExpoSupabaseDownload({ client, fileStore })

    await expect(
      download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg', { sha256: 'not-the-real-hash' }),
    ).rejects.toThrow('sha256 mismatch')
    expect(written).toHaveLength(0)

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg', { sha256: sha256Hex(BYTES) })
    expect(written).toHaveLength(1)
  })

  test('a 404 signed-url error throws the notYetAvailable transfer code (re-queueable)', async () => {
    const { fileStore } = recordingFileStore()
    const client = clientWith({ data: null, error: { message: 'object not found', status: 404 } })
    const download = createExpoSupabaseDownload({ client, fileStore })

    const caught: { code?: string } = {}

    await download({ bucket: 'todos', path: 'missing.jpg' }, '/local/x.jpg').catch((error: { code?: string }) => {
      caught.code = error.code
    })
    expect(caught.code).toBe(ETransferError.notYetAvailable)
  })

  test('a 403 signed-url error throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const { fileStore } = recordingFileStore()
    const client = clientWith({ data: null, error: { message: 'permission denied', status: 403 } })
    const download = createExpoSupabaseDownload({ client, fileStore })

    const caught: { code?: string; message?: string } = {}

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg').catch(
      (error: { code?: string; message?: string }) => {
        caught.code = error.code
        caught.message = error.message
      },
    )
    expect(caught.code).toBeUndefined()
    expect(caught.message).toContain('403')
  })

  test('a 500 signed-url error throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const { fileStore } = recordingFileStore()
    const client = clientWith({ data: null, error: { message: 'internal error', status: 500 } })
    const download = createExpoSupabaseDownload({ client, fileStore })

    const caught: { code?: string; message?: string } = {}

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg').catch(
      (error: { code?: string; message?: string }) => {
        caught.code = error.code
        caught.message = error.message
      },
    )
    expect(caught.code).toBeUndefined()
    expect(caught.message).toContain('500')
  })

  test('a 404 fetch response throws the notYetAvailable transfer code (re-queueable)', async () => {
    fetchImpl = async () => ({ ok: false, status: 404, arrayBuffer: async () => BYTES })
    const { fileStore } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
    const download = createExpoSupabaseDownload({ client, fileStore })

    const caught: { code?: string } = {}

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg').catch((error: { code?: string }) => {
      caught.code = error.code
    })
    expect(caught.code).toBe(ETransferError.notYetAvailable)
  })

  test('a 403 fetch response throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    fetchImpl = async () => ({ ok: false, status: 403, arrayBuffer: async () => BYTES })
    const { fileStore } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
    const download = createExpoSupabaseDownload({ client, fileStore })

    const caught: { code?: string; message?: string } = {}

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg').catch(
      (error: { code?: string; message?: string }) => {
        caught.code = error.code
        caught.message = error.message
      },
    )
    expect(caught.code).toBeUndefined()
    expect(caught.message).toContain('403')
  })

  test('a 500 fetch response throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    fetchImpl = async () => ({ ok: false, status: 500, arrayBuffer: async () => BYTES })
    const { fileStore } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
    const download = createExpoSupabaseDownload({ client, fileStore })

    const caught: { code?: string; message?: string } = {}

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg').catch(
      (error: { code?: string; message?: string }) => {
        caught.code = error.code
        caught.message = error.message
      },
    )
    expect(caught.code).toBeUndefined()
    expect(caught.message).toContain('500')
  })
})

// MARK: - Deadlines

/**
 * Both waits are bounded and the byte fetch carries a real AbortSignal, so a
 * hung socket is dropped rather than merely stopped being waited on. Timers are
 * injected so a blown deadline is fired on demand rather than waited out.
 */

/** Fires whatever the code under test armed, in order, without a wall clock. */
const manualTimers = (): {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  armed: () => number[]
  fireAll: () => void
} => {
  const pending = new Map<number, { callback: () => void; delayMs: number }>()
  let next = 0

  return {
    setTimer: (callback, delayMs) => {
      next += 1
      pending.set(next, { callback, delayMs })

      return next
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
    armed: () => [...pending.values()].map((entry) => entry.delayMs),
    fireAll: () => {
      for (const [handle, entry] of [...pending]) {
        pending.delete(handle)
        entry.callback()
      }
    },
  }
}

const neverSettles = <T>(): Promise<T> => new Promise<T>(() => undefined)

describe('createExpoSupabaseDownload deadlines', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchSignals = []
    fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => BYTES })
  })

  test('a hung signed-URL request rejects with the retryable timeout code', async () => {
    const timers = manualTimers()
    const { fileStore } = recordingFileStore()
    const client = {
      storage: { from: () => ({ createSignedUrl: () => neverSettles<TSignedUrlResult>() }) },
    } as unknown as SupabaseClient
    const download = createExpoSupabaseDownload({
      client,
      fileStore,
      controlTimeoutMs: 30_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    const pending = download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    await Promise.resolve()
    expect(timers.armed()).toEqual([30_000])
    timers.fireAll()

    const caught: { code?: string; message?: string } = {}

    await pending.catch((error: { code?: string; message?: string }) => {
      caught.code = error.code
      caught.message = error.message
    })
    expect(caught.code).toBe(ETransferError.timedOut)
    expect(caught.message).toContain('30000ms')
    expect(fetchCalls).toEqual([])
  })

  test('a hung byte fetch is aborted and rejects with the retryable timeout code', async () => {
    const timers = manualTimers()
    const { fileStore, written } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })

    fetchImpl = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const download = createExpoSupabaseDownload({
      client,
      fileStore,
      bytesTimeoutMs: 120_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    const pending = download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    // The fetch having been issued is the observable point at which the byte deadline is the one armed, so wait for that rather than for a number of turns the implementation happens to take.
    while (fetchSignals.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(timers.armed()).toEqual([120_000])
    expect(fetchSignals[0]?.aborted).toBe(false)
    timers.fireAll()

    const caught: { code?: string; message?: string } = {}

    await pending.catch((error: { code?: string; message?: string }) => {
      caught.code = error.code
      caught.message = error.message
    })
    expect(caught.code).toBe(ETransferError.timedOut)
    expect(caught.message).toContain('120000ms')
    expect(fetchSignals[0]?.aborted).toBe(true)
    expect(written).toEqual([])
  })

  test('a download that settles disarms both deadlines', async () => {
    const timers = manualTimers()
    const { fileStore, written } = recordingFileStore()
    const client = clientWith({ data: { signedUrl: 'https://storage.example/signed' }, error: null })
    const download = createExpoSupabaseDownload({
      client,
      fileStore,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    expect(written).toHaveLength(1)
    expect(timers.armed()).toEqual([])
  })
})
