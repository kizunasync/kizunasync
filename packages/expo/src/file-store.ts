/**
 * @kizunasync/expo file store: a content-addressed sandbox over expo-file-system.
 *
 * The IFileStore for native (iOS/Android). Bytes live under documentDirectory
 * (NOT cacheDirectory, whose contents the OS evicts, which would lose a pending
 * upload). On SDK 54+ the functional API lives at `expo-file-system/legacy`; we pin
 * that so readAsStringAsync({position,length}) range reads stay available.
 * importFromUri copies an externally-picked file:// into the content-addressed
 * sandbox; toUri returns the file:// uri (React Native <Image> renders it). The
 * JS sha256 keeps hashing platform-free (no expo-crypto dependency). Building
 * the store touches no file system; the first operation creates the sandbox,
 * and without a documentDirectory every operation fails with
 * STORE_UNAVAILABLE.
 */

import * as FileSystem from 'expo-file-system/legacy'
import { contentKey, createSha256, EEngineErrorCode, mimeForExt, sha256Hex, TEngineError, type IFileStat, type IFileStore } from '@kizunasync/core'

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = globalThis.atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return globalThis.btoa(binary)
}

/**
 * Per-write temp suffix so two concurrent writeAtomic calls to the SAME dest
 * (content-addressed: different refs, identical bytes) never share a `.tmp`.
 */
let tmpSeq = 0
const nextTmpId = (): number => (tmpSeq += 1)

/** Where the sandbox lives, as every operation below addresses it. */
interface IExpoFileStoreState {
  root: string
}

export function openExpoFileStore(): IFileStore {
  let opened: Promise<IExpoFileStoreState> | undefined
  // Every operation opens the sandbox first, so without a documentDirectory each one fails the same typed way before it reads its arguments.
  const open = (): Promise<IExpoFileStoreState> => {
    opened ??= openSandbox()

    return opened
  }

  return {
    capabilities: { atomicRename: true, streams: true, quota: false, contentUris: true },
    writeAtomic: async (path, data) => writeAtomic(await open(), { path, data }),
    read: async (path) => copyToArrayBuffer(await readBytes(await open(), { path })),
    readRange: async (path, offset, length) =>
      copyToArrayBuffer(await readBytes(await open(), { path, range: { position: offset, length } })),
    exists: async (path) => (await FileSystem.getInfoAsync(fullPath(await open(), path))).exists,
    stat: async (path) => statFile(await open(), path),
    delete: async (path) => {
      await FileSystem.deleteAsync(fullPath(await open(), path), { idempotent: true }).catch(() => undefined)
    },
    list: async (prefix) => listPrefix(await open(), prefix),
    sha256: async (path) => {
      const hasher = createSha256()

      hasher.update(await readBytes(await open(), { path }))

      return hasher.digest()
    },
    importFromUri: async (uri) => importFromUri(await open(), uri),
    toUri: async (path) => fullPath(await open(), path),
  }
}

/** The sandbox under documentDirectory, created on the first operation, or STORE_UNAVAILABLE where the platform exposes no documentDirectory. */
async function openSandbox(): Promise<IExpoFileStoreState> {
  const docDir = FileSystem.documentDirectory

  if (docDir === null) {
    throw new TEngineError(EEngineErrorCode.STORE_UNAVAILABLE, 'kizunasync/expo file store: documentDirectory is unavailable')
  }
  const state: IExpoFileStoreState = { root: `${docDir}kizunasync-attachments/` }

  await FileSystem.makeDirectoryAsync(state.root, { intermediates: true }).catch(() => undefined)

  return state
}

// MARK: - Paths and reads

/** A `.` or `..` path segment, which would resolve a key outside the store's root. */
const ESCAPING_SEGMENT = /^\.{1,2}$/

/** A backslash or a percent escape, either of which a file URI could turn into an escaping segment. */
const ESCAPING_CHARACTER = /[\\%]/

function fullPath(state: IExpoFileStoreState, path: string): string {
  if (ESCAPING_CHARACTER.test(path) || path.split('/').some((segment) => ESCAPING_SEGMENT.test(segment))) {
    throw new Error(`kizunasync/expo file store: path leaves the attachment root: ${path}`)
  }
  return `${state.root}${path}`
}

async function ensureParent(state: IExpoFileStoreState, path: string): Promise<void> {
  const slash = path.lastIndexOf('/')

  if (slash > 0) {
    await FileSystem.makeDirectoryAsync(fullPath(state, path.slice(0, slash)), {
      intermediates: true,
    }).catch(() => undefined)
  }
}

/** One base64 read of a sandbox file, whole or as a byte range. */
type TByteRead = {
  path: string
  range?: { position: number; length: number }
}

async function readBytes(state: IExpoFileStoreState, read: TByteRead): Promise<Uint8Array> {
  const base64 = await FileSystem.readAsStringAsync(fullPath(state, read.path), {
    encoding: FileSystem.EncodingType.Base64,
    ...read.range,
  })

  return base64ToBytes(base64)
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)

  new Uint8Array(out).set(bytes)

  return out
}

// MARK: - Operations

type TWrite = {
  path: string
  data: ArrayBuffer
}

async function writeAtomic(state: IExpoFileStoreState, write: TWrite): Promise<void> {
  const { path, data } = write
  const dest = fullPath(state, path)

  await ensureParent(state, path)
  const tmp = `${dest}.${nextTmpId()}.tmp`

  await FileSystem.writeAsStringAsync(tmp, bytesToBase64(new Uint8Array(data)), {
    encoding: FileSystem.EncodingType.Base64,
  })

  // Content-addressed: a concurrent writer may have already produced these exact bytes at dest. Skip rather than collide on the move.
  if ((await FileSystem.getInfoAsync(dest)).exists) {
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => undefined)

    return
  }
  try {
    await FileSystem.moveAsync({ from: tmp, to: dest })
  } catch (error) {
    // Lost the race between the check and the move: the bytes are identical (same sha), so the existing dest is correct; otherwise rethrow.
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => undefined)

    if (!(await FileSystem.getInfoAsync(dest)).exists) {
      throw error
    }
  }
}

async function statFile(state: IExpoFileStoreState, path: string): Promise<IFileStat | null> {
  const info = await FileSystem.getInfoAsync(fullPath(state, path))

  if (!info.exists) {
    return null
  }
  return {
    size: typeof info.size === 'number' ? info.size : 0,
    modifiedAt: typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0,
  }
}

async function listPrefix(state: IExpoFileStoreState, prefix: string): Promise<string[]> {
  const info = await FileSystem.getInfoAsync(fullPath(state, prefix))

  if (!info.exists) {
    return []
  }
  const entries = await FileSystem.readDirectoryAsync(fullPath(state, prefix))
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`

  return entries.map((name) => `${base}${name}`)
}

async function importFromUri(state: IExpoFileStoreState, uri: string): ReturnType<IFileStore['importFromUri']> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  })
  const bytes = base64ToBytes(base64)
  const sha = sha256Hex(bytes)
  const path = contentKey(sha)
  const ext = uri.split('.').pop()?.toLowerCase() ?? ''
  const result = { path, sha256: sha, size: bytes.length, contentType: mimeForExt(ext) }

  await ensureParent(state, path)
  const dest = fullPath(state, path)

  // Content-addressed: identical bytes may already be committed. Skip rather than collide on the move (which on iOS deletes dest first).
  if ((await FileSystem.getInfoAsync(dest)).exists) {
    return result
  }
  // Per-import temp suffix so two concurrent imports of the SAME file never share a `.tmp` and destroy each other's committed content/<sha>.
  const tmp = `${dest}.${nextTmpId()}.tmp`

  await FileSystem.writeAsStringAsync(tmp, base64, {
    encoding: FileSystem.EncodingType.Base64,
  })

  try {
    await FileSystem.moveAsync({ from: tmp, to: dest })
  } catch (error) {
    // Lost the race between the check and the move: the same sha means the existing dest is correct; otherwise the failure is real.
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => undefined)

    if (!(await FileSystem.getInfoAsync(dest)).exists) {
      throw error
    }
  }
  return result
}
