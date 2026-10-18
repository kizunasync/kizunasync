import { Platform } from 'react-native'
import type { IStoreLocator } from '@kizunasync/core'
import { createWebWorkerDriver } from '@kizunasync/web'
import { createDevicePlatformPorts, loadDeviceNativeEngine } from './store-locator'
import { resolveWasmAssetUrl } from './wasm-asset'
import { expoDatabasePath } from './native-engine'

/**
 * Name the existing native database through Expo Modules API 2.0. The Rust
 * Turso engine owns the connection; resolving the path opens no SQL engine.
 * Web uses the dedicated worker and resolves its WASM asset when it starts.
 */
export function openExpoDriver(name: string): IStoreLocator {
  if (Platform.OS === 'web') {
    return createWebWorkerDriver(name, { wasmUrl: resolveWasmAssetUrl })
  }
  let databasePath: string | undefined

  return {
    get databasePath(): string {
      databasePath ??= expoDatabasePath(name)

      return databasePath
    },
    loadNativeEngine: loadDeviceNativeEngine,
    platformPorts: createDevicePlatformPorts(),
  }
}
