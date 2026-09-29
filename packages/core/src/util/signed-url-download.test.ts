// MARK: - createSignedUrlDownload

/**
 * Proves the shared signed-URL download in isolation: the storage client, the
 * byte fetch, the file store and the timers are all fakes, so nothing reaches a
 * network or a wall clock. Only a 404 (from the sign request or from the fetch)
 * re-queues; every other failure reaches the queue's failed-path; both waits
 * are bounded and a blown deadline carries the retryable timeout code.
 */

import { describe, expect, test } from 'bun:test'
import { SIGNED_URL_TTL_SECONDS } from '../constants'
import type { IFileStore } from '../ports/file-store'
import { ETransferError } from '../ports/transfer'
import { EEngineErrorCode } from '../wire/types'
import { noopLogger, type ILogger } from './logger'
import { sha256Hex } from './sha256'
import { createSignedUrlDownload, type ICreateSignedUrlDownloadOptions } from './signed-url-download'

const BYTES = new TextEncoder().encode('hello attachment bytes').buffer as ArrayBuffer

const SIGNED_URL = 'https://storage.example/signed'

type TStorageBucket = ReturnType<ICreateSignedUrlDownloadOptions['client']['storage']['from']>

type TSignResult = Awaited<ReturnType<TStorageBucket['createSignedUrl']>>

type TFetchResult = Awaited<ReturnType<ICreateSignedUrlDownloadOptions['fetchBytes']>>

type TSignCall = { bucket: string; path: string; expiresIn: number }

const clientAnswering = (
  respond: () => Promise<TSignResult>,
  calls: TSignCall[] = [],
): ICreateSignedUrlDownloadOptions['client'] => ({
  storage: {
    from: (bucket) => ({
      createSignedUrl: (path, expiresIn) => {
        calls.push({ bucket, path, expiresIn })

        return respond()
      },
    }),
  },
})

const signed = (): Promise<TSignResult> => Promise.resolve({ data: { signedUrl: SIGNED_URL }, error: null })

const signFailure = (status: number | string, message: string): Promise<TSignResult> =>
  Promise.resolve({ data: null, error: { status, message } })

const answer = (status: number, bytes: ArrayBuffer = BYTES): TFetchResult => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => bytes,
})

const recordingFileStore = (): { fileStore: IFileStore; written: Array<{ path: string; bytes: ArrayBuffer }> } => {
  const written: Array<{ path: string; bytes: ArrayBuffer }> = []
  const fileStore = {
    writeAtomic: async (path: string, bytes: ArrayBuffer) => {
      written.push({ path, bytes })
    },
  } as unknown as IFileStore

  return { fileStore, written }
}

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

const failureOf = async (pending: Promise<void>): Promise<{ code?: string; message?: string }> =>
  pending.then(
    () => ({ message: 'resolved' }),
    (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }),
  )

describe('createSignedUrlDownload', () => {
  test('signs the object, fetches the signed URL, logs the size, and writes the bytes atomically', async () => {
    const { fileStore, written } = recordingFileStore()
    const signCalls: TSignCall[] = []
    const fetched: Array<{ url: string; signal: AbortSignal }> = []
    const logged: Array<{ message: string; meta: unknown }> = []
    const logger: ILogger = {
      ...noopLogger,
      debug: (message, meta) => {
        logged.push({ message, meta })
      },
    }
    const download = createSignedUrlDownload({
      client: clientAnswering(signed, signCalls),
      fileStore,
      logger,
      fetchBytes: async (url, signal) => {
        fetched.push({ url, signal })

        return answer(200)
      },
    })

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    expect(signCalls).toEqual([{ bucket: 'todos', path: 'u/1.jpg', expiresIn: SIGNED_URL_TTL_SECONDS }])
    expect(fetched.map((call) => call.url)).toEqual([SIGNED_URL])
    expect(fetched[0]?.signal.aborted).toBe(false)
    expect(logged).toEqual([{ message: 'download bytes', meta: { bytes: BYTES.byteLength, path: 'u/1.jpg' } }])
    expect(written).toHaveLength(1)
    expect(written[0]?.path).toBe('/local/1.jpg')
    expect(new Uint8Array(written[0]!.bytes)).toEqual(new Uint8Array(BYTES))
  })

  test('verifies the sha256 and rejects a mismatch under its catalog code before writing', async () => {
    const { fileStore, written } = recordingFileStore()
    const download = createSignedUrlDownload({
      client: clientAnswering(signed),
      fileStore,
      fetchBytes: async () => answer(200),
    })

    const caught = await failureOf(
      download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg', { sha256: 'not-the-real-hash' }),
    )

    expect(caught).toEqual({ code: EEngineErrorCode.ATTACHMENT_HASH_MISMATCH, message: 'attachment sha256 mismatch for u/1.jpg' })
    expect(written).toHaveLength(0)

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg', { sha256: sha256Hex(BYTES) })
    expect(written).toHaveLength(1)
  })

  test('a 404 sign error throws the notYetAvailable transfer code (re-queueable)', async () => {
    const { fileStore, written } = recordingFileStore()
    const download = createSignedUrlDownload({
      client: clientAnswering(() => signFailure(404, 'object not found')),
      fileStore,
      fetchBytes: async () => answer(200),
    })

    const caught = await failureOf(download({ bucket: 'todos', path: 'missing.jpg' }, '/local/x.jpg'))

    expect(caught).toEqual({ code: ETransferError.notYetAvailable, message: 'attachment not available: object not found' })
    expect(written).toEqual([])
  })

  test('any other sign error throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const { fileStore } = recordingFileStore()

    for (const status of [401, 403, 500, '404']) {
      const download = createSignedUrlDownload({
        client: clientAnswering(() => signFailure(status, 'refused')),
        fileStore,
        fetchBytes: async () => answer(200),
      })

      const caught = await failureOf(download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))

      expect(caught).toEqual({ code: undefined, message: `attachment sign failed (${status}): refused` })
    }
  })

  test('a sign answer with neither data nor error is a real failure too', async () => {
    const { fileStore } = recordingFileStore()
    const download = createSignedUrlDownload({
      client: clientAnswering(() => Promise.resolve({ data: null, error: null })),
      fileStore,
      fetchBytes: async () => answer(200),
    })

    const caught = await failureOf(download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))

    expect(caught).toEqual({ code: undefined, message: 'attachment sign failed (unknown): missing' })
  })

  test('a 404 fetch response throws the notYetAvailable transfer code (re-queueable)', async () => {
    const { fileStore, written } = recordingFileStore()
    const download = createSignedUrlDownload({
      client: clientAnswering(signed),
      fileStore,
      fetchBytes: async () => answer(404),
    })

    const caught = await failureOf(download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))

    expect(caught).toEqual({ code: ETransferError.notYetAvailable, message: 'attachment fetch failed: 404' })
    expect(written).toEqual([])
  })

  test('any other fetch status throws WITHOUT the notYetAvailable code (a real failure, not a re-queue)', async () => {
    const { fileStore, written } = recordingFileStore()

    for (const status of [401, 403, 500]) {
      const download = createSignedUrlDownload({
        client: clientAnswering(signed),
        fileStore,
        fetchBytes: async () => answer(status),
      })

      const caught = await failureOf(download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg'))

      expect(caught).toEqual({ code: undefined, message: `attachment fetch failed: ${status}` })
    }
    expect(written).toEqual([])
  })

  test('a refusal carries the HTTP status the host answered, so the queue can classify it', async () => {
    const { fileStore } = recordingFileStore()
    const statusOf = async (download: ReturnType<typeof createSignedUrlDownload>): Promise<unknown> =>
      download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg').then(
        () => 'resolved',
        (error: { status?: unknown }) => error.status,
      )

    for (const status of [401, 403, 404, 500]) {
      const signRefused = createSignedUrlDownload({
        client: clientAnswering(() => signFailure(status, 'refused')),
        fileStore,
        fetchBytes: async () => answer(200),
      })
      const fetchRefused = createSignedUrlDownload({
        client: clientAnswering(signed),
        fileStore,
        fetchBytes: async () => answer(status),
      })

      expect(await statusOf(signRefused)).toBe(status)
      expect(await statusOf(fetchRefused)).toBe(status)
    }
    const textStatus = createSignedUrlDownload({
      client: clientAnswering(() => signFailure('404', 'refused')),
      fileStore,
      fetchBytes: async () => answer(200),
    })

    expect(await statusOf(textStatus)).toBeUndefined()
  })

  test('a fetch that fails on its own rethrows the cause, never the timeout code', async () => {
    const { fileStore } = recordingFileStore()
    const cause = new Error('network down')
    const download = createSignedUrlDownload({
      client: clientAnswering(signed),
      fileStore,
      fetchBytes: async () => {
        throw cause
      },
    })

    await expect(download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')).rejects.toBe(cause)
  })
})

// MARK: - Deadlines

/**
 * Both waits are bounded and the byte fetch carries a real AbortSignal, so a
 * hung socket is dropped rather than merely stopped being waited on. Timers are
 * injected so a blown deadline is fired on demand rather than waited out.
 */
describe('createSignedUrlDownload deadlines', () => {
  test('a hung sign request rejects with the retryable timeout code and never fetches', async () => {
    const timers = manualTimers()
    const { fileStore } = recordingFileStore()
    const fetched: string[] = []
    const download = createSignedUrlDownload({
      client: clientAnswering(() => neverSettles<TSignResult>()),
      fileStore,
      controlTimeoutMs: 30_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      fetchBytes: async (url) => {
        fetched.push(url)

        return answer(200)
      },
    })

    const pending = download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    expect(timers.armed()).toEqual([30_000])
    timers.fireAll()

    const caught = await failureOf(pending)

    expect(caught).toEqual({ code: ETransferError.timedOut, message: 'attachment sign timed out after 30000ms' })
    expect(fetched).toEqual([])
  })

  test('a hung byte fetch is aborted and rejects with the retryable timeout code', async () => {
    const timers = manualTimers()
    const { fileStore, written } = recordingFileStore()
    const signals: AbortSignal[] = []
    const download = createSignedUrlDownload({
      client: clientAnswering(signed),
      fileStore,
      bytesTimeoutMs: 120_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      fetchBytes: (_url, signal) => {
        signals.push(signal)

        return new Promise<TFetchResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    })

    const pending = download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    // The fetch having been issued is the observable point at which the byte deadline is the one armed, so wait for that rather than for a number of turns the implementation happens to take.
    while (signals.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(timers.armed()).toEqual([120_000])
    expect(signals[0]?.aborted).toBe(false)
    timers.fireAll()

    const caught = await failureOf(pending)

    expect(caught).toEqual({ code: ETransferError.timedOut, message: 'attachment download timed out after 120000ms' })
    expect(signals[0]?.aborted).toBe(true)
    expect(written).toEqual([])
  })

  test('a download that settles disarms both deadlines', async () => {
    const timers = manualTimers()
    const { fileStore, written } = recordingFileStore()
    const download = createSignedUrlDownload({
      client: clientAnswering(signed),
      fileStore,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      fetchBytes: async () => answer(200),
    })

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    expect(written).toHaveLength(1)
    expect(timers.armed()).toEqual([])
  })

  test('controlTimeoutMs: 0 and bytesTimeoutMs: 0 arm no timer', async () => {
    const throwingTimer = (): never => {
      throw new Error('setTimer/clearTimer must not be called when timeouts are disabled')
    }
    const { fileStore, written } = recordingFileStore()
    const download = createSignedUrlDownload({
      client: clientAnswering(signed),
      fileStore,
      controlTimeoutMs: 0,
      bytesTimeoutMs: 0,
      setTimer: throwingTimer,
      clearTimer: throwingTimer,
      fetchBytes: async () => answer(200),
    })

    await download({ bucket: 'todos', path: 'u/1.jpg' }, '/local/1.jpg')

    expect(written).toHaveLength(1)
  })
})
