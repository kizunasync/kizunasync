/**
 * @kizunasync/web file store: the content-addressed OPFS sandbox.
 *
 * The IFileStore for the browser. Attachment bytes live in OPFS under
 * `kizunasync-attachments/`, a subtree separate from the SQLite VFS: an
 * attachment write never contends with the DB's exclusive handle. Building the
 * store touches no storage, so an app can build it at module scope, even in a
 * render pass that has no OPFS. The first operation opens the subtree; where
 * OPFS is missing or refused, every operation fails with STORE_UNAVAILABLE.
 * writeAtomic relies on OPFS createWritable's commit-on-close behavior; the
 * repository does not run a forced-browser-termination test for it. Paths are
 * opaque keys ('/'-nested into OPFS dirs). importFromUri reads an
 * externally-picked file (a blob:/http object URL) via fetch, the
 * platform-specific read kept behind the port. Object URLs handed out by toUri
 * are cached per path and revoked on delete.
 */

// MARK: - @kizunasync/web file store

import { contentKey, createSha256, EEngineErrorCode, sha256Hex, TEngineError, type IFileStat, type IFileStore } from '@kizunasync/core'

const ROOT_DIR = 'kizunasync-attachments'

/** A `.` or `..` path segment, which would resolve a key outside the attachment subtree. */
const ESCAPING_SEGMENT = /^\.{1,2}$/

/** A backslash or a percent escape, either of which could stand for an escaping segment. */
const ESCAPING_CHARACTER = /[\\%]/

const splitPath = (path: string): { dirs: string[]; name: string } => {
  if (ESCAPING_CHARACTER.test(path) || path.split('/').some((segment) => ESCAPING_SEGMENT.test(segment))) {
    throw new Error(`kizunasync/web file store: path leaves the attachment root: ${path}`)
  }
  const parts = path.split('/').filter((part) => part.length > 0)
  const name = parts.pop()

  if (name === undefined) {
    throw new Error(`kizunasync/web file store: empty path`)
  }
  return { dirs: parts, name }
}

/** What every operation below reads: the attachment subtree and the object URLs handed out, by path. */
interface IWebFileStoreState {
  root: FileSystemDirectoryHandle
  uriCache: Map<string, string>
}

export function createWebFileStore(): IFileStore {
  let opened: Promise<IWebFileStoreState> | undefined
  // Every operation opens the subtree first, so where OPFS is missing each one fails the same typed way before it reads its arguments.
  const open = (): Promise<IWebFileStoreState> => {
    opened ??= openAttachmentRoot().then((root) => ({ root, uriCache: new Map() }))

    return opened
  }

  return {
    capabilities: { atomicRename: true, streams: true, quota: true, contentUris: true },
    writeAtomic: async (path, data) => writeAtomic(await open(), { path, data }),
    read: async (path) => (await getFile(await open(), path)).arrayBuffer(),
    readRange: async (path, offset, length) =>
      (await getFile(await open(), path)).slice(offset, offset + length).arrayBuffer(),
    exists: async (path) => (await fileHandle(await open(), { path, create: false })) !== null,
    stat: async (path) => statFile(await open(), path),
    delete: async (path) => deleteFile(await open(), path),
    list: async (prefix) => listPrefix(await open(), prefix),
    sha256: async (path) => hashFile(await open(), path),
    importFromUri: async (uri) => importFromUri(await open(), uri),
    toUri: async (path) => toUri(await open(), path),
  }
}

// MARK: - Handles

/** The `kizunasync-attachments/` directory, or STORE_UNAVAILABLE where OPFS is missing or refused. */
async function openAttachmentRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = (globalThis as { navigator?: Navigator & { storage?: StorageManager } }).navigator?.storage

  if (storage?.getDirectory === undefined) {
    throw new TEngineError(EEngineErrorCode.STORE_UNAVAILABLE, 'kizunasync/web file store: OPFS is unavailable in this browser')
  }
  // Best-effort persistence so the OS doesn't evict pending uploads.
  void storage.persist?.().catch(() => undefined)

  try {
    const opfsRoot = await storage.getDirectory()

    return await opfsRoot.getDirectoryHandle(ROOT_DIR, { create: true })
  } catch (error) {
    throw new TEngineError(
      EEngineErrorCode.STORE_UNAVAILABLE,
      `kizunasync/web file store: OPFS refused the attachment directory: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** One directory lookup under the root, and whether it creates what is missing. */
type TDirLookup = {
  dirs: string[]
  create: boolean
}

async function dirFor(state: IWebFileStoreState, lookup: TDirLookup): Promise<FileSystemDirectoryHandle | null> {
  let handle = state.root

  for (const dir of lookup.dirs) {
    try {
      handle = await handle.getDirectoryHandle(dir, { create: lookup.create })
    } catch {
      return null
    }
  }
  return handle
}

/** One file lookup by opaque path, and whether it creates what is missing. */
type TFileLookup = {
  path: string
  create: boolean
}

async function fileHandle(state: IWebFileStoreState, lookup: TFileLookup): Promise<FileSystemFileHandle | null> {
  const { create } = lookup
  const { dirs, name } = splitPath(lookup.path)
  const dir = await dirFor(state, { dirs, create })

  if (dir === null) {
    return null
  }
  try {
    return await dir.getFileHandle(name, { create })
  } catch {
    return null
  }
}

async function getFile(state: IWebFileStoreState, path: string): Promise<File> {
  const handle = await fileHandle(state, { path, create: false })

  if (handle === null) {
    throw new Error(`kizunasync/web file store: missing ${path}`)
  }
  return handle.getFile()
}

function revoke(state: IWebFileStoreState, path: string): void {
  const uri = state.uriCache.get(path)

  if (uri !== undefined) {
    URL.revokeObjectURL(uri)
    state.uriCache.delete(path)
  }
}

// MARK: - Operations

type TWrite = {
  path: string
  data: ArrayBuffer
}

async function writeAtomic(state: IWebFileStoreState, write: TWrite): Promise<void> {
  const { path, data } = write

  revoke(state, path)
  const handle = await fileHandle(state, { path, create: true })

  if (handle === null) {
    throw new Error(`kizunasync/web file store: cannot create ${path}`)
  }
  const writable = await handle.createWritable()

  try {
    await writable.write(data)
  } catch (error) {
    await writable.abort().catch(() => undefined)

    throw error
  }
  // close() commits the swap file atomically, so partial writes never show.
  await writable.close()
}

async function statFile(state: IWebFileStoreState, path: string): Promise<IFileStat | null> {
  const handle = await fileHandle(state, { path, create: false })

  if (handle === null) {
    return null
  }
  const file = await handle.getFile()

  return { size: file.size, modifiedAt: file.lastModified }
}

async function deleteFile(state: IWebFileStoreState, path: string): Promise<void> {
  revoke(state, path)
  const { dirs, name } = splitPath(path)
  const dir = await dirFor(state, { dirs, create: false })

  if (dir === null) {
    return
  }
  try {
    await dir.removeEntry(name)
  } catch {
    // already gone, and the delete is best-effort.
  }
}

async function listPrefix(state: IWebFileStoreState, prefix: string): Promise<string[]> {
  // OPFS has no recursive glob, so this is a shallow prefix listing.
  const dirs = prefix.split('/').filter((part) => part.length > 0)
  const dir = await dirFor(state, { dirs, create: false })

  if (dir === null) {
    return []
  }
  const names: string[] = []

  for await (const [name] of (dir as unknown as AsyncIterable<[string, unknown]>)) {
    names.push(dirs.length === 0 ? name : `${dirs.join('/')}/${name}`)
  }
  return names
}

async function hashFile(state: IWebFileStoreState, path: string): Promise<string> {
  const file = await getFile(state, path)
  const hasher = createSha256()
  const reader = file.stream().getReader()

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }
    hasher.update(value)
  }
  return hasher.digest()
}

async function importFromUri(state: IWebFileStoreState, uri: string): ReturnType<IFileStore['importFromUri']> {
  const response = await fetch(uri)

  if (!response.ok) {
    throw new Error(`kizunasync/web file store: cannot read ${uri} (${response.status})`)
  }
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const sha = sha256Hex(bytes)
  const path = contentKey(sha)
  const handle = await fileHandle(state, { path, create: true })

  if (handle === null) {
    throw new Error(`kizunasync/web file store: cannot create ${path}`)
  }
  const writable = await handle.createWritable()

  try {
    await writable.write(buffer)
  } catch (error) {
    await writable.abort().catch(() => undefined)

    throw error
  }
  await writable.close()
  const contentType = response.headers.get('content-type')

  return { path, sha256: sha, size: bytes.length, contentType }
}

async function toUri(state: IWebFileStoreState, path: string): Promise<string> {
  const cached = state.uriCache.get(path)

  if (cached !== undefined) {
    return cached
  }
  const file = await getFile(state, path)
  const uri = URL.createObjectURL(file)

  state.uriCache.set(path, uri)

  return uri
}
