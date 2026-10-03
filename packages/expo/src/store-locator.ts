import type { IStoreLocator, TNativeEngineLoadResult } from '@kizunasync/core'
import { describeUniffiLoadFailure, tryLoadUniffiNativeEngine } from '@kizunasync/rn-uniffi'
import { createExpoConnectivity } from './connectivity'
import { createExpoForeground } from './foreground'

/**
 * Name the database file the Rust kernel opens on device. The kernel holds the
 * only connection to it, so the locator carries the path, the loader for that
 * kernel, and the device's own network and foreground signals.
 */
export function createStoreLocator(databasePath: string): IStoreLocator {
  return { databasePath, loadNativeEngine: loadDeviceNativeEngine, platformPorts: createDevicePlatformPorts() }
}

/**
 * The Rust engine the native build links, through `@kizunasync/rn-uniffi`.
 * This package declares that dependency and `@kizunasync/core` does not, so the
 * import lives here, where a strict install layout resolves it and Metro
 * bundles it.
 */
export function loadDeviceNativeEngine(): TNativeEngineLoadResult {
  const result = tryLoadUniffiNativeEngine()

  return result.ok ? { ok: true, handle: result.engine } : { ok: false, message: describeUniffiLoadFailure(result) }
}

/**
 * NetInfo and AppState, the signals the app client follows on device when the
 * app passes none of its own. Neither subscribes before the app client asks.
 */
export function createDevicePlatformPorts(): NonNullable<IStoreLocator['platformPorts']> {
  return { connectivity: createExpoConnectivity(), foreground: createExpoForeground() }
}
