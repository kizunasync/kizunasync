/// <reference types="bun" />
/**
 * @kizunasync/expo file-store unit tests, against the REAL module.
 *
 * expo-file-system/legacy is mocked with an in-memory FS that faithfully models
 * iOS moveAsync (remove-the-destination-then-move; fail if the source is gone),
 * so the content-addressed atomic-write and import paths are exercised for real,
 * the concurrent-import race over a shared `.tmp` name included. Building the
 * store touches no file system; the first operation creates the sandbox
 * directory, and a missing documentDirectory fails every call with a typed
 * STORE_UNAVAILABLE.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EEngineErrorCode, TEngineError } from '@kizunasync/core'

type TFsCalls = { writes: string[]; moves: Array<{ from: string; to: string }>; directories: string[] }
let files: Map<string, string>
let calls: TFsCalls
/**
 * Optional barrier: when set, every moveAsync blocks on it, so a test can hold
 * two concurrent imports at the move step (both tmps written) and release them
 * together to force the shared-`.tmp` race deterministically.
 */
let moveGate: Promise<void> | null = null

const makeFs = () => ({
  documentDirectory: 'file:///doc/' as string | null,
  EncodingType: { UTF8: 'utf8', Base64: 'base64' } as const,
  makeDirectoryAsync: async (uri: string, _opts?: unknown) => {
    await Promise.resolve()
    calls.directories.push(uri)
  },
  writeAsStringAsync: async (uri: string, content: string, _opts?: unknown) => {
    await Promise.resolve()
    calls.writes.push(uri)
    files.set(uri, content)
  },
  readAsStringAsync: async (uri: string, _opts?: unknown) => {
    await Promise.resolve()
    const value = files.get(uri)

    if (value === undefined) {
      throw new Error(`readAsStringAsync: no such file ${uri}`)
    }
    return value
  },
  /**
   * `expo-file-system/legacy` iOS semantics: remove the destination (idempotent)
   * then move, so a move whose SOURCE was already consumed by a racing move
   * throws.
   */
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    if (moveGate !== null) {
      await moveGate
    }
    await Promise.resolve()
    calls.moves.push({ from, to })

    if (!files.has(from)) {
      throw new Error(`moveAsync: source gone ${from}`)
    }
    files.delete(to)
    files.set(to, files.get(from)!)
    files.delete(from)
  },
  getInfoAsync: async (uri: string) => {
    await Promise.resolve()

    return { exists: files.has(uri) }
  },
  deleteAsync: async (uri: string, _opts?: { idempotent?: boolean }) => {
    await Promise.resolve()
    files.delete(uri)
  },
  readDirectoryAsync: async (uri: string) => {
    await Promise.resolve()
    const prefix = uri.endsWith('/') ? uri : `${uri}/`

    return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  },
  copyAsync: async () => {
    await Promise.resolve()
  },
})

mock.module('expo-file-system/legacy', makeFs)

// Import the REAL module (after the mock is registered).
const { openExpoFileStore } = await import('./file-store')

beforeEach(() => {
  files = new Map()
  calls = { writes: [], moves: [], directories: [] }
})
afterEach(() => {
  files = new Map()
  mock.module('expo-file-system/legacy', makeFs)
})

const bytes = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer
const readBack = async (store: ReturnType<typeof openExpoFileStore>, path: string): Promise<number[]> =>
  [...new Uint8Array(await store.read(path))]

// A tiny base64 blob for the "external picked file" that importFromUri reads.
const EXTERNAL_URI = 'file:///picked/photo.jpg'
const EXTERNAL_B64 = Buffer.from([9, 8, 7, 6]).toString('base64')

describe('opening the expo file-store', () => {
  test('building the store touches no file system', () => {
    const store = openExpoFileStore()

    expect(store).not.toBeInstanceOf(Promise)
    expect(store.capabilities).toEqual({ atomicRename: true, streams: true, quota: false, contentUris: true })
    expect(calls.directories).toEqual([])
    expect(calls.writes).toEqual([])
  })

  test('the first operation creates the sandbox directory, once', async () => {
    const store = openExpoFileStore()

    expect(await store.exists('content/abc')).toBe(false)
    await store.writeAtomic('content/abc', bytes([1]))

    expect(calls.directories.filter((uri) => uri === 'file:///doc/kizunasync-attachments/')).toHaveLength(1)
    expect(calls.directories[0]).toBe('file:///doc/kizunasync-attachments/')
  })

  test('building the store without a documentDirectory does not throw, and every call fails with a typed STORE_UNAVAILABLE', async () => {
    // Re-mocking updates the live binding the store reads, so this models a platform that exposes no documentDirectory.
    mock.module('expo-file-system/legacy', () => ({ ...makeFs(), documentDirectory: null }))
    const store = openExpoFileStore()

    for (const call of [() => store.read('content/abc'), () => store.importFromUri(EXTERNAL_URI), () => store.toUri('content/abc')]) {
      const failure = await call().then(
        () => expect.unreachable('expected STORE_UNAVAILABLE'),
        (error: unknown) => error,
      )

      expect(failure).toBeInstanceOf(TEngineError)
      expect((failure as TEngineError).code).toBe(EEngineErrorCode.STORE_UNAVAILABLE)
      expect((failure as TEngineError).message).toBe('@kizunasync/expo file store: documentDirectory is unavailable')
    }
    expect(calls.directories).toEqual([])
  })
})

describe('expo file-store (real module)', () => {
  test('writeAtomic round-trips bytes to the content-addressed path', async () => {
    const store = openExpoFileStore()

    await store.writeAtomic('content/abc', bytes([1, 2, 3]))
    expect(await readBack(store, 'content/abc')).toEqual([1, 2, 3])
  })

  test('writeAtomic to an already-present dest is skipped (content-addressed)', async () => {
    const store = openExpoFileStore()

    await store.writeAtomic('content/dup', bytes([5, 5]))
    calls.moves.length = 0
    await store.writeAtomic('content/dup', bytes([5, 5])) // identical bytes already there
    expect(calls.moves).toHaveLength(0)
    expect(await readBack(store, 'content/dup')).toEqual([5, 5])
  })

  test('a path that leaves the attachment root is refused, and nothing outside it is touched', async () => {
    const outside = 'file:///doc/outside.bin'

    files.set(outside, EXTERNAL_B64)
    const store = openExpoFileStore()

    for (const path of ['../outside.bin', 'downloads/../../outside.bin', './content/abc', 'content/%2e%2e/abc', 'content\\..\\abc']) {
      const refusal = `@kizunasync/expo file store: path leaves the attachment root: ${path}`

      await expect(store.delete(path)).rejects.toThrow(refusal)
      await expect(store.writeAtomic(path, bytes([1]))).rejects.toThrow(refusal)
      await expect(store.read(path)).rejects.toThrow(refusal)
    }
    expect(files.get(outside)).toBe(EXTERNAL_B64)
    expect(calls.writes).toEqual([])
  })

  test('importFromUri content-addresses the picked file', async () => {
    files.set(EXTERNAL_URI, EXTERNAL_B64)
    const store = openExpoFileStore()
    const result = await store.importFromUri(EXTERNAL_URI)

    expect(result.contentType).toBe('image/jpeg')
    expect(await readBack(store, result.path)).toEqual([9, 8, 7, 6])
  })

  test('two concurrent imports of the SAME file never lose the bytes (race fix)', async () => {
    files.set(EXTERNAL_URI, EXTERNAL_B64)
    const store = openExpoFileStore()

    // Hold both imports at the move step (both tmps written), then release together, which is the deterministic form of the shared-`.tmp` hazard.
    let releaseMoves!: () => void

    moveGate = new Promise<void>((r) => {
      releaseMoves = r
    })

    const settled = Promise.allSettled([
      store.importFromUri(EXTERNAL_URI),
      store.importFromUri(EXTERNAL_URI),
    ])

    // Wait until both imports have written a temp and are parked on the move gate.
    const isTmp = (w: string): boolean => /\.tmp$/.test(w)

    for (let i = 0; i < 200 && calls.writes.filter(isTmp).length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 1))
    }
    releaseMoves()
    moveGate = null
    const results = await settled

    // Both imports succeed. A shared `.tmp` name would throw "source gone" on the second move, whose tmp the first one consumed.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const path = (results[0] as PromiseFulfilledResult<{ path: string }>).value.path

    // The committed content survives (was not deleted by a racing move).
    expect(await readBack(store, path)).toEqual([9, 8, 7, 6])
    // Each import wrote a DISTINCT temp path, never a shared `.tmp`.
    const tmpWrites = calls.writes.filter(isTmp)

    expect(new Set(tmpWrites).size).toBe(tmpWrites.length)
  })
})
