const stores = new Map()
let nextId = 1
const filenames = ['database', 'database-wal']
const decoder = new TextDecoder('utf-8', { fatal: true })

export function openMemoryStorage() {
  const id = nextId++

  stores.set(id, {
    kind: 0,
    files: new Map(filenames.map((path) => [path, new Uint8Array()])),
    ready: true,
  })

  return id
}

function failure(code, message) {
  return new Error(`${code}: ${message}`)
}
function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error)
  })
}
function committed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}
async function existingDatabase(name) {
  if (typeof indexedDB === 'undefined') return false

  if (typeof indexedDB.databases === 'function')
    return (await indexedDB.databases()).some(
      (database) => database.name === name,
    )

  return new Promise((resolve, reject) => {
    const operation = indexedDB.open(name)
    let absent = false

    operation.onupgradeneeded = () => {
      absent = true
      operation.transaction.abort()
    }
    operation.onerror = () =>
      absent ? resolve(false) : reject(operation.error)
    operation.onsuccess = () => {
      operation.result.close()
      resolve(true)
    }
  })
}
async function placement(key, kind) {
  if (typeof indexedDB === 'undefined') return null
  const db = await database('kizunasync-turso-placement-v1', 'databases')

  try {
    const tx = db.transaction('databases', kind === undefined ? 'readonly' : 'readwrite')
    const complete = committed(tx)
    const table = tx.objectStore('databases')

    if (kind !== undefined) table.put(kind, key)
    const selected = kind === undefined ? await request(table.get(key)) : kind

    await complete

    return selected
  } finally { db.close() }
}
async function existingFallback(name, legacy) {
  return await existingDatabase(name) || await existingDatabase(legacy)
}
async function database(name, storeName) {
  const operation = indexedDB.open(name, 1)

  operation.onupgradeneeded = () =>
    operation.result.createObjectStore(storeName)

  return request(operation)
}
async function directory(root, path, create) {
  let current = root

  for (const component of path.split('/').filter(Boolean))
    current = await current.getDirectoryHandle(component, { create })

  return current
}
async function maybeDirectory(root, path) {
  try {
    return await directory(root, path, false)
  } catch (error) {
    if (error?.name === 'NotFoundError') return null

    throw error
  }
}
function matches(path, name) {
  return path.replace(/^\/+/, '') === name.replace(/^\/+/, '')
}
function image(handle, offset = 0) {
  const bytes = new Uint8Array(Math.max(0, handle.getSize() - offset))

  if (handle.read(bytes, { at: offset }) !== bytes.length)
    throw new Error('Short database read')

  return bytes
}
function writeImage(handle, bytes) {
  handle.truncate(0)

  if (handle.write(bytes, { at: 0 }) !== bytes.length)
    throw new Error('Short database write')
  handle.flush()
}
function validImage(bytes) {
  if (
    bytes.length !== 0 &&
    (bytes.length < 100 ||
      decoder.decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0')
  )
    throw new Error('Invalid legacy SQLite database header')
}
function legacyImage(handle, name, result) {
  if (handle.getSize() < 4096) return
  const header = new Uint8Array(516)

  if (handle.read(header) !== header.length)
    throw new Error('Short legacy metadata read')
  const flags = new DataView(header.buffer).getUint32(512)

  if ((flags & 8) !== 0 || (flags & 0x84900) === 0) return
  const end = header.subarray(0, 512).indexOf(0)

  if (end <= 0) return
  const pathName = decoder.decode(header.subarray(0, end))
  const suffix = ['', '-wal', '-journal'].find((suffix) =>
    matches(pathName, name + suffix),
  )

  if (suffix === undefined) return

  if (result.has(suffix))
    throw new Error('Multiple legacy database files have the same name')
  result.set(suffix, image(handle, 4096))
}
async function legacyPool(root, path, name, held) {
  const pool = await maybeDirectory(root, `${path}/.opaque`)
  const result = new Map()

  if (!pool) return result

  for await (const [, entry] of pool.entries()) {
    if (entry.kind !== 'file') continue
    const handle = await entry.createSyncAccessHandle()

    held.push(handle)
    legacyImage(handle, name, result)
  }
  if (
    result
      .get('-journal')
      ?.subarray(0, 8)
      .some((byte) => byte !== 0)
  )
    throw new Error(
      'Legacy SQLite has an unfinished rollback journal; recover it with the previous app before upgrading',
    )

  if (result.has('')) validImage(result.get(''))

  return result
}
async function legacyIndexedDb(name, path) {
  if (!(await existingDatabase(name))) return null
  const legacy = await request(indexedDB.open(name))

  try {
    if (!legacy.objectStoreNames.contains('blocks'))
      throw new Error('Unrecognized legacy IndexedDB schema')
    const tx = legacy.transaction('blocks', 'readonly')
    const blocks = (await request(tx.objectStore('blocks').getAll())).filter(
      (block) => matches(block.path, path),
    )

    if (blocks.length === 0) return null
    const bytes = new Uint8Array(
      blocks.reduce(
        (size, block) => Math.max(size, block.offset + block.data.byteLength),
        0,
      ),
    )

    for (const block of blocks)
      bytes.set(
        new Uint8Array(
          block.data.buffer ?? block.data,
          block.data.byteOffset ?? 0,
          block.data.byteLength,
        ),
        block.offset,
      )
    validImage(bytes)

    return bytes
  } finally {
    legacy.close()
  }
}
async function idbStorage(name, legacyName, newName) {
  const db = await database(newName, 'files')
  const tx = db.transaction('files', 'readonly')
  const table = tx.objectStore('files')
  const loaded = await Promise.all(
    [...filenames, 'ready'].map((path) => request(table.get(path))),
  )
  const ready = loaded[2] === true
  const legacy = ready ? null : await legacyIndexedDb(legacyName, name)
  const files = new Map(
    filenames.map((path, index) => [
      path,
      new Uint8Array(
        ready ? (loaded[index] ?? 0) : index === 0 ? (legacy ?? 0) : 0,
      ),
    ]),
  )

  return {
    kind: 2,
    db,
    files,
    ready,
    readyRequested: ready,
    dirty: !ready,
    chain: Promise.resolve(),
  }
}
async function opfsStorage(name, path, root) {
  const held = []

  try {
    const legacy = await legacyPool(root, path, name, held)
    const location = await directory(root, `${path}/turso-v1`, true)
    const files = new Map()

    for (const path of [...filenames, 'ready']) {
      const entry = await location.getFileHandle(path, { create: true })
      const handle = await entry.createSyncAccessHandle()

      files.set(path, handle)
      held.push(handle)
    }
    const ready = image(files.get('ready'))[0] === 1

    if (!ready) {
      writeImage(files.get('database'), legacy.get('') ?? new Uint8Array())
      writeImage(
        files.get('database-wal'),
        legacy.get('-wal') ?? new Uint8Array(),
      )
    }
    return { kind: 1, files, held, ready, readyRequested: ready }
  } catch (error) {
    for (const handle of held) handle.close()

    throw error
  }
}

async function opfsRoot() {
  try {
    return await globalThis.navigator.storage.getDirectory()
  } catch (error) {
    if (error?.name === 'SecurityError') return null

    if (error?.name === 'UnknownError') return false

    throw failure('STORE_UNAVAILABLE', String(error))
  }
}
async function openOpfs(name, path, root) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await opfsStorage(name, path, root)
    } catch (error) {
      if (error?.name === 'SecurityError') return null

      if (
        !['NoModificationAllowedError', 'InvalidStateError'].includes(
          error?.name,
        )
      )
        throw failure('STORE_UNAVAILABLE', String(error))

      if (attempt === 9) throw failure('STORE_BUSY', name)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw failure('STORE_BUSY', name)
}
async function rejectDivergentOpfs(root, path, name) {
  const location = await maybeDirectory(root, `${path}/turso-v1`)

  if (location) {
    try {
      const ready = await location.getFileHandle('ready')

      if ((await ready.getFile()).size > 0)
        throw new Error(
          'Both OPFS and IndexedDB databases exist; export and reconcile them before upgrading',
        )
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error
    }
  }
  const held = []

  try {
    const images = await legacyPool(root, path, name, held)

    if (images.get('')?.length)
      throw new Error(
        'Both legacy OPFS and IndexedDB databases exist; export and reconcile them before upgrading',
      )
  } finally {
    for (const handle of held) handle.close()
  }
}
function opfsAvailable() {
  return (
    typeof globalThis.navigator?.storage?.getDirectory === 'function' &&
    typeof globalThis.FileSystemFileHandle?.prototype
      ?.createSyncAccessHandle === 'function'
  )
}
async function chooseStorage(name, path, legacyName) {
  const idbName = `kizunasync-turso-v1:${legacyName}`
  const root = opfsAvailable() ? await opfsRoot() : null
  const previous = await placement(legacyName)

  if (previous === 1 && !root) throw new Error('The existing OPFS database is inaccessible; restore storage permission before opening it')

  // Continue using an existing fallback after a browser upgrade adds OPFS.
  if (
    await existingFallback(idbName, legacyName)
  ) {
    if (root) await rejectDivergentOpfs(root, path, name)

    return idbStorage(name, legacyName, idbName)
  }
  if (root === false)
    return {
      kind: 0,
      files: new Map(filenames.map((path) => [path, new Uint8Array()])),
      ready: false,
    }
  const state = root ? await openOpfs(name, path, root) : null

  return state ?? idbStorage(name, legacyName, idbName)
}
export async function openStorage(name, path, legacyName) {
  let state
  const release = await storageLock(name, legacyName)

  try {
    state = await chooseStorage(name, path, legacyName)

    if (state.kind === 2 && !release)
      throw new Error(
        'IndexedDB persistence requires Web Locks to prevent concurrent writers',
      )

    if (state.kind !== 0) await placement(legacyName, state.kind)
    state.release = release
  } catch (error) {
    abandonStorage(state)
    release?.()

    if (String(error).includes('STORE_BUSY:')) throw error

    throw failure('STORE_UNAVAILABLE', String(error))
  }
  const id = nextId++

  stores.set(id, state)

  return { id, kind: state.kind, ready: state.ready }
}

function abandonStorage(state) {
  if (!state) return
  state.db?.close()

  for (const handle of state.held ?? []) handle.close()
}

async function storageLock(name, key) {
  const locks = globalThis.navigator?.locks

  if (!locks) return null

  for (let attempt = 0; attempt < 10; attempt++) {
    const release = await new Promise((resolve, reject) => {
      void locks
        .request(
          `kizunasync-turso-storage:${key}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              resolve(null)

              return
            }
            await new Promise((release) => resolve(release))
          },
        )
        .catch(reject)
    })

    if (release) return release

    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw failure('STORE_BUSY', name)
}
function store(id) {
  const state = stores.get(id)

  if (!state) throw new Error('Storage handle is closed')

  if (state.error) throw state.error

  return state
}
function file(id, path) {
  const state = store(id)

  if (!state.files.has(path))
    throw new Error(`Unregistered Turso file: ${path}`)

  return [state, state.files.get(path)]
}
export function fileRead(id, path, offset, output) {
  const [state, value] = file(id, path)

  output.fill(0)

  if (state.kind === 1) return value.read(output, { at: offset })
  const count = Math.max(0, Math.min(output.length, value.length - offset))

  output.set(value.subarray(offset, offset + count))

  return count
}
export function fileWrite(id, path, offset, bytes) {
  const [state, value] = file(id, path)

  if (state.kind === 1) {
    const count = value.write(bytes, { at: offset })

    if (count !== bytes.length) throw new Error('Short database write')

    return count
  }
  const output =
    value.length >= offset + bytes.length
      ? value
      : new Uint8Array(offset + bytes.length)

  if (output !== value) output.set(value)
  output.set(bytes, offset)
  state.files.set(path, output)
  state.dirty = true

  return bytes.length
}
export function fileSize(id, path) {
  const [state, value] = file(id, path)

  return state.kind === 1 ? value.getSize() : value.length
}
export function fileTruncate(id, path, length) {
  const [state, value] = file(id, path)

  if (state.kind === 1) value.truncate(length)
  else {
    const bytes = new Uint8Array(length)

    bytes.set(value.subarray(0, length))
    state.files.set(path, bytes)
    state.dirty = true
  }
}
export function fileSync(id, path) {
  const [state, value] = file(id, path)

  if (state.kind === 1) value.flush()
}
export function markReady(id) {
  const state = store(id)

  state.readyRequested = true
  state.dirty = true
}
export async function flushStorage() {
  await Promise.all(
    [...stores.values()].map(async (state) => {
      if (state.error) throw state.error

      if (state.kind === 1) {
        for (const handle of state.files.values()) handle.flush()

        if (!state.ready && state.readyRequested) {
          writeImage(state.files.get('ready'), new Uint8Array([1]))
          state.ready = true
        }
      } else if (state.kind === 2) {
        if (state.dirty) {
          const snapshot = filenames.map((path) => [
            path,
            state.files.get(path).slice(),
          ])
          const ready = state.readyRequested

          state.dirty = false
          state.chain = state.chain
            .then(async () => {
              const tx = state.db.transaction('files', 'readwrite')
              const complete = committed(tx)

              for (const [path, bytes] of snapshot)
                tx.objectStore('files').put(bytes, path)
              tx.objectStore('files').put(ready, 'ready')
              await complete
              state.ready = ready
            })
            .catch((error) => {
              state.error = error

              throw error
            })
        }
        await state.chain
      }
    }),
  )
}
export function closeStorage(id) {
  const state = stores.get(id)

  if (!state) return

  for (const handle of state.held ?? []) handle.close()

  if (state.db)
    state.chain
      .finally(() => {
        state.db.close()
        state.release?.()
      })
      .catch(() => {})
  else state.release?.()
  stores.delete(id)
}
