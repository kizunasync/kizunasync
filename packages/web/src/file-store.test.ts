/// <reference types="bun" />
/**
 * @kizunasync/web file store over an in-memory OPFS.
 *
 * The fake models what the store relies on: nested directory handles, file
 * handles whose writable commits only on `close()` (the OPFS swap file),
 * `removeEntry`, and async iteration. `fetch` and the object-URL pair are
 * stubbed per test, so every assertion is about the store itself: building it
 * touches no storage, the first operation opens the `kizunasync-attachments/`
 * subtree, then atomic writes and overwrites, reads, ranges, stats and
 * listings, deletes, content-addressed imports, the per-path object-URL cache
 * and its revocation, and the typed refusal when OPFS is absent.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { EEngineErrorCode, sha256Hex, TEngineError, type IFileStore } from '@kizunasync/core'
import { createWebFileStore } from './file-store'

// MARK: - In-memory OPFS

/** What a test steers and reads back in the fake. */
interface IFakeControls {
  now: number
  failWrites: boolean
  readonly aborted: string[]
}

interface IFakeWritable {
  write(data: ArrayBuffer): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

interface IFakeFile {
  readonly kind: 'file'
  readonly name: string
  bytes: Uint8Array<ArrayBuffer>
  lastModified: number
  getFile(): Promise<File>
  createWritable(): Promise<IFakeWritable>
}

interface IFakeDirectory {
  readonly kind: 'directory'
  readonly name: string
  readonly entries: Map<string, IFakeDirectory | IFakeFile>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<IFakeDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<IFakeFile>
  removeEntry(name: string): Promise<void>
  [Symbol.asyncIterator](): AsyncIterator<[string, IFakeDirectory | IFakeFile]>
}

const notFound = (name: string): DOMException => new DOMException(`${name} not found`, 'NotFoundError')

const createFakeWritable = (file: IFakeFile, controls: IFakeControls): IFakeWritable => {
  let staged: Uint8Array<ArrayBuffer> | null = null

  return {
    write: async (data) => {
      if (controls.failWrites) {
        throw new Error('quota exceeded')
      }
      staged = new Uint8Array(data.slice(0))
    },
    // Nothing is visible until close() commits the swap file, as in OPFS.
    close: async () => {
      if (staged !== null) {
        controls.now += 1
        file.bytes = staged
        file.lastModified = controls.now
      }
    },
    abort: async () => {
      controls.aborted.push(file.name)
    },
  }
}

const createFakeFile = (name: string, controls: IFakeControls): IFakeFile => {
  const file: IFakeFile = {
    kind: 'file',
    name,
    bytes: new Uint8Array(0),
    lastModified: controls.now,
    getFile: async () => new File([file.bytes], name, { lastModified: file.lastModified }),
    createWritable: async () => createFakeWritable(file, controls),
  }

  return file
}

const createFakeDirectory = (name: string, controls: IFakeControls): IFakeDirectory => {
  const entries = new Map<string, IFakeDirectory | IFakeFile>()

  return {
    kind: 'directory',
    name,
    entries,
    getDirectoryHandle: async (child, options) => {
      const entry = entries.get(child)

      if (entry?.kind === 'directory') {
        return entry
      }
      if (entry !== undefined) {
        throw new DOMException(`${child} is a file`, 'TypeMismatchError')
      }
      if (options?.create !== true) {
        throw notFound(child)
      }
      const created = createFakeDirectory(child, controls)

      entries.set(child, created)

      return created
    },
    getFileHandle: async (child, options) => {
      const entry = entries.get(child)

      if (entry?.kind === 'file') {
        return entry
      }
      if (entry !== undefined) {
        throw new DOMException(`${child} is a directory`, 'TypeMismatchError')
      }
      if (options?.create !== true) {
        throw notFound(child)
      }
      const created = createFakeFile(child, controls)

      entries.set(child, created)

      return created
    },
    removeEntry: async (child) => {
      if (!entries.delete(child)) {
        throw notFound(child)
      }
    },
    [Symbol.asyncIterator]: async function* () {
      yield* entries
    },
  }
}

// MARK: - Fixtures

/** The fake installed as `navigator.storage`, and what the store asked of it. */
interface IInstalledOpfs {
  readonly root: IFakeDirectory
  readonly controls: IFakeControls
  readonly persistCalls: () => number
  readonly directoryCalls: () => number
}

const ORIGINAL_CREATE_OBJECT_URL = URL.createObjectURL

const ORIGINAL_REVOKE_OBJECT_URL = URL.revokeObjectURL

const ORIGINAL_FETCH = globalThis.fetch

/** The Bun test runtime has no `navigator.storage`; each test installs its own and the hook below removes it. */
const installStorage = (storage: unknown): void => {
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: storage })
}

const installOpfs = (persist: () => Promise<boolean> = async () => true): IInstalledOpfs => {
  const controls: IFakeControls = { now: 1_700_000_000_000, failWrites: false, aborted: [] }
  const root = createFakeDirectory('', controls)
  let persistCalls = 0
  let directoryCalls = 0

  installStorage({
    getDirectory: async () => {
      directoryCalls += 1

      return root
    },
    persist: () => {
      persistCalls += 1

      return persist()
    },
  })

  return { root, controls, persistCalls: () => persistCalls, directoryCalls: () => directoryCalls }
}

const openStore = async (): Promise<{ store: IFileStore; opfs: IInstalledOpfs }> => {
  const opfs = installOpfs()

  return { store: createWebFileStore(), opfs }
}

/** Every entry under `directory`, directories suffixed with `/`, sorted. */
const layoutOf = (directory: IFakeDirectory, prefix = ''): string[] =>
  [...directory.entries]
    .flatMap(([name, entry]) =>
      entry.kind === 'directory' ? [`${prefix}${name}/`, ...layoutOf(entry, `${prefix}${name}/`)] : [`${prefix}${name}`],
    )
    .sort()

const bytesOf = (text: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(text)
  const buffer = new ArrayBuffer(encoded.byteLength)

  new Uint8Array(buffer).set(encoded)

  return buffer
}

const textOf = (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer)

const missingPath = (path: string): string => `@kizunasync/web file store: missing ${path}`

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, 'storage')
  URL.createObjectURL = ORIGINAL_CREATE_OBJECT_URL
  URL.revokeObjectURL = ORIGINAL_REVOKE_OBJECT_URL
  globalThis.fetch = ORIGINAL_FETCH
})

// MARK: - Opening

describe('createWebFileStore', () => {
  test('building the store touches no storage and declares its capabilities', () => {
    const opfs = installOpfs()
    const store = createWebFileStore()

    expect(store).not.toBeInstanceOf(Promise)
    expect(store.capabilities).toEqual({ atomicRename: true, streams: true, quota: true, contentUris: true })
    expect(opfs.directoryCalls()).toBe(0)
    expect(opfs.persistCalls()).toBe(0)
    expect(layoutOf(opfs.root)).toEqual([])
  })

  test('building the store where the browser exposes no storage does not throw', () => {
    installStorage(undefined)

    expect(() => createWebFileStore()).not.toThrow()
  })

  test('the first operation opens its kizunasync-attachments subtree and asks for persistence, once', async () => {
    const opfs = installOpfs()
    const store = createWebFileStore()

    expect(await store.exists('a.bin')).toBe(false)
    await store.writeAtomic('a.bin', bytesOf('a'))

    expect(layoutOf(opfs.root)).toEqual(['kizunasync-attachments/', 'kizunasync-attachments/a.bin'])
    expect(opfs.directoryCalls()).toBe(1)
    expect(opfs.persistCalls()).toBe(1)
  })

  test('a refused persistence request does not stop the store from opening', async () => {
    const opfs = installOpfs(async () => {
      throw new Error('persistence denied')
    })
    const store = createWebFileStore()

    await expect(store.exists('a.bin')).resolves.toBe(false)
    expect(opfs.persistCalls()).toBe(1)
  })

  test.each([
    { name: 'no storage manager', storage: undefined },
    { name: 'a storage manager with no getDirectory', storage: { persist: async () => true } },
  ])('with $name, every call fails with a typed STORE_UNAVAILABLE', async ({ storage }) => {
    installStorage(storage)
    const store = createWebFileStore()

    for (const call of [() => store.read('a.bin'), () => store.importFromUri('blob:a'), () => store.exists('a.bin')]) {
      const failure = await call().then(
        () => expect.unreachable('expected STORE_UNAVAILABLE'),
        (error: unknown) => error,
      )

      expect(failure).toBeInstanceOf(TEngineError)
      expect((failure as TEngineError).code).toBe(EEngineErrorCode.STORE_UNAVAILABLE)
      expect((failure as TEngineError).message).toBe('@kizunasync/web file store: OPFS is unavailable in this browser')
    }
  })

  test('a directory the browser refuses fails the call with a typed STORE_UNAVAILABLE carrying its message', async () => {
    installStorage({
      getDirectory: async () => {
        throw new DOMException('The request is not allowed', 'SecurityError')
      },
    })
    const store = createWebFileStore()
    const failure = await store.list('').then(
      () => expect.unreachable('expected STORE_UNAVAILABLE'),
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(TEngineError)
    expect((failure as TEngineError).code).toBe(EEngineErrorCode.STORE_UNAVAILABLE)
    expect((failure as TEngineError).message).toContain('The request is not allowed')
  })
})

// MARK: - Writes and reads

describe('writes and reads', () => {
  test('writeAtomic then read returns the committed bytes', async () => {
    const { store } = await openStore()

    await store.writeAtomic('a/b/c.bin', bytesOf('hello world'))

    expect(textOf(await store.read('a/b/c.bin'))).toBe('hello world')
  })

  test('each path segment becomes a directory under kizunasync-attachments', async () => {
    const { store, opfs } = await openStore()

    await store.writeAtomic('a/b/c.bin', bytesOf('nested'))
    await store.writeAtomic('top.bin', bytesOf('flat'))

    expect(layoutOf(opfs.root)).toEqual([
      'kizunasync-attachments/',
      'kizunasync-attachments/a/',
      'kizunasync-attachments/a/b/',
      'kizunasync-attachments/a/b/c.bin',
      'kizunasync-attachments/top.bin',
    ])
  })

  test('writeAtomic over an existing path replaces its bytes', async () => {
    const { store } = await openStore()

    await store.writeAtomic('a.txt', bytesOf('first version'))
    await store.writeAtomic('a.txt', bytesOf('second'))

    expect(textOf(await store.read('a.txt'))).toBe('second')
    expect((await store.stat('a.txt'))?.size).toBe('second'.length)
  })

  test('a failed write aborts the writable, rejects, and keeps the last committed bytes', async () => {
    const { store, opfs } = await openStore()

    await store.writeAtomic('docs/a.txt', bytesOf('committed'))
    opfs.controls.failWrites = true

    await expect(store.writeAtomic('docs/a.txt', bytesOf('never lands'))).rejects.toThrow('quota exceeded')
    expect(opfs.controls.aborted).toEqual(['a.txt'])
    expect(textOf(await store.read('docs/a.txt'))).toBe('committed')
  })

  test('reading a missing path rejects with the missing-path error and creates nothing', async () => {
    const { store, opfs } = await openStore()

    await store.writeAtomic('dir/present.bin', bytesOf('x'))

    await expect(store.read('dir/absent.bin')).rejects.toThrow(missingPath('dir/absent.bin'))
    await expect(store.read('nowhere/absent.bin')).rejects.toThrow(missingPath('nowhere/absent.bin'))
    await expect(store.readRange('dir/absent.bin', 0, 1)).rejects.toThrow(missingPath('dir/absent.bin'))
    await expect(store.sha256('dir/absent.bin')).rejects.toThrow(missingPath('dir/absent.bin'))
    expect(layoutOf(opfs.root)).toEqual([
      'kizunasync-attachments/',
      'kizunasync-attachments/dir/',
      'kizunasync-attachments/dir/present.bin',
    ])
  })

  test('an empty path is refused', async () => {
    const { store } = await openStore()

    await expect(store.read('')).rejects.toThrow('@kizunasync/web file store: empty path')
    await expect(store.writeAtomic('///', bytesOf('x'))).rejects.toThrow('@kizunasync/web file store: empty path')
  })

  test('readRange returns the requested slice', async () => {
    const { store } = await openStore()

    await store.writeAtomic('r.bin', bytesOf('0123456789'))

    expect(textOf(await store.readRange('r.bin', 2, 5))).toBe('23456')
  })

  test('exists and stat describe a written file, and nothing for a missing one', async () => {
    const { store, opfs } = await openStore()

    await store.writeAtomic('s/f.bin', bytesOf('12345'))

    expect(await store.exists('s/f.bin')).toBe(true)
    expect(await store.exists('s/missing.bin')).toBe(false)
    expect(await store.stat('s/f.bin')).toEqual({ size: 5, modifiedAt: opfs.controls.now })
    expect(await store.stat('s/missing.bin')).toBeNull()
  })

  test('sha256 digests the committed bytes', async () => {
    const { store } = await openStore()
    const large = new Uint8Array(1024 * 1024 + 7).map((_, index) => index % 251)

    await store.writeAtomic('h/small.txt', bytesOf('hello world'))
    await store.writeAtomic('h/large.bin', large.buffer)

    expect(await store.sha256('h/small.txt')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
    expect(await store.sha256('h/large.bin')).toBe(sha256Hex(large))
  })
})

// MARK: - Delete and list

describe('delete and list', () => {
  test('delete removes the file and treats a missing path as already gone', async () => {
    const { store, opfs } = await openStore()

    await store.writeAtomic('d/gone.bin', bytesOf('bye'))
    await store.delete('d/gone.bin')

    expect(await store.exists('d/gone.bin')).toBe(false)
    await expect(store.read('d/gone.bin')).rejects.toThrow(missingPath('d/gone.bin'))
    await store.delete('d/gone.bin')
    await store.delete('never/was.bin')
    expect(layoutOf(opfs.root)).toEqual(['kizunasync-attachments/', 'kizunasync-attachments/d/'])
  })

  test('a path that leaves the attachment subtree is refused', async () => {
    const { store, opfs } = await openStore()

    for (const path of ['../outside.bin', 'a/../../outside.bin', './a.bin', 'a/%2e%2e/b.bin', 'a\\..\\b.bin']) {
      const refusal = `@kizunasync/web file store: path leaves the attachment root: ${path}`

      await expect(store.delete(path)).rejects.toThrow(refusal)
      await expect(store.writeAtomic(path, bytesOf('x'))).rejects.toThrow(refusal)
      await expect(store.read(path)).rejects.toThrow(refusal)
    }
    expect(layoutOf(opfs.root)).toEqual(['kizunasync-attachments/'])
  })

  test('list is a shallow listing of one directory', async () => {
    const { store } = await openStore()

    await store.writeAtomic('l/1.bin', bytesOf('1'))
    await store.writeAtomic('l/2.bin', bytesOf('2'))
    await store.writeAtomic('l/sub/3.bin', bytesOf('3'))
    await store.writeAtomic('top.bin', bytesOf('t'))

    expect((await store.list('l')).sort()).toEqual(['l/1.bin', 'l/2.bin', 'l/sub'])
    expect((await store.list('l/')).sort()).toEqual(['l/1.bin', 'l/2.bin', 'l/sub'])
    expect((await store.list('')).sort()).toEqual(['l', 'top.bin'])
    expect(await store.list('missing')).toEqual([])
  })
})

// MARK: - Imports

describe('importFromUri', () => {
  test('fetches the picked file and stores it under its content key', async () => {
    const { store, opfs } = await openStore()
    const picked = bytesOf('picked image bytes')
    const sha = sha256Hex(picked)
    const fetched: string[] = []

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input))

      return new Response(picked, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch

    const imported = await store.importFromUri('blob:picked/1')

    expect(fetched).toEqual(['blob:picked/1'])
    expect(imported).toEqual({
      path: `content/${sha}`,
      sha256: sha,
      size: picked.byteLength,
      contentType: 'image/png',
    })
    expect(layoutOf(opfs.root)).toEqual([
      'kizunasync-attachments/',
      'kizunasync-attachments/content/',
      `kizunasync-attachments/content/${sha}`,
    ])
    expect(textOf(await store.read(imported.path))).toBe('picked image bytes')
  })

  test('refuses a response that is not ok', async () => {
    const { store, opfs } = await openStore()

    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response('gone', { status: 404 })) as typeof fetch

    await expect(store.importFromUri('blob:picked/2')).rejects.toThrow(
      '@kizunasync/web file store: cannot read blob:picked/2 (404)',
    )
    expect(layoutOf(opfs.root)).toEqual(['kizunasync-attachments/'])
  })
})

// MARK: - Object URLs

describe('toUri', () => {
  test('hands out one object URL per path until a write or a delete revokes it', async () => {
    const { store } = await openStore()
    const revoked: string[] = []
    let minted = 0

    URL.createObjectURL = (): string => {
      minted += 1

      return `blob:fake/${minted}`
    }
    URL.revokeObjectURL = (uri: string): void => {
      revoked.push(uri)
    }

    await store.writeAtomic('img/a.png', bytesOf('first'))
    const first = await store.toUri('img/a.png')

    expect(await store.toUri('img/a.png')).toBe(first)
    expect(minted).toBe(1)

    await store.writeAtomic('img/a.png', bytesOf('second'))
    const second = await store.toUri('img/a.png')

    expect(revoked).toEqual([first])
    expect(second).not.toBe(first)

    await store.delete('img/a.png')

    expect(revoked).toEqual([first, second])
    await expect(store.toUri('img/a.png')).rejects.toThrow(missingPath('img/a.png'))
  })
})
