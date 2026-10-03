import { Platform } from 'react-native'
import * as SQLite from 'expo-sqlite'
import type { IStoreLocator } from '@kizunasync/core'
import { createWebWorkerDriver } from '@kizunasync/web'
import { createDevicePlatformPorts, loadDeviceNativeEngine } from './store-locator'
import { resolveWasmAssetUrl } from './wasm-asset'

/**
 * The two members of `SQLiteDatabase` this module reads. `expo-sqlite@~57.0.2`
 * declares both as required, so neither is guarded.
 */
type TExpoSqliteHandle = {
  databasePath: string
  closeSync(): void
}

/**
 * The Kizuna store locator for this platform. Building it opens nothing.
 *
 * Native: the locator names the expo-sqlite file for the Rust kernel to open
 * through UniFFI, carries the loader for that kernel, and carries NetInfo and
 * AppState as its platform ports.
 * expo-sqlite is opened to learn that path and closed again the first time the
 * app client reads it, which is on the app client's first engine call. A path
 * that read cannot produce fails that call, and every later one, with
 * `ENGINE_UNAVAILABLE` carrying the expo-sqlite message. Web:
 * `@kizunasync/web` hands back a locator carrying the Rust engine running in a
 * dedicated worker over OPFS (or the relaxed IndexedDB fallback). The worker
 * cannot read `import.meta.url` under Metro, so the driver gets the asset
 * resolver for the engine binary and calls it when the worker spawns; a static
 * render, which has no `location`, never does.
 */
export function openExpoDriver(name: string): IStoreLocator {
  if (Platform.OS === 'web') {
    return createWebWorkerDriver(name, { wasmUrl: resolveWasmAssetUrl })
  }
  let databasePath: string | undefined

  return {
    get databasePath(): string {
      databasePath ??= readExpoDatabasePath(name)

      return databasePath
    },
    loadNativeEngine: loadDeviceNativeEngine,
    platformPorts: createDevicePlatformPorts(),
  }
}

function readExpoDatabasePath(name: string): string {
  const db = SQLite.openDatabaseSync(name) as TExpoSqliteHandle

  try {
    const databasePath = db.databasePath

    if (typeof databasePath !== 'string' || databasePath.length === 0) {
      throw new Error(
        `openExpoDriver: expo-sqlite did not report a databasePath for "${name}"`,
      )
    }
    return databasePath
  } finally {
    db.closeSync()
  }
}
