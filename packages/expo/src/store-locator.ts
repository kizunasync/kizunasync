import type { IStoreLocator, TNativeEngineLoadResult } from '@kizunasync/core'
import { loadExpoNativeEngine } from './native-engine'
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

/** Load the shared Rust engine through the Expo Modules API 2.0 host. */
export function loadDeviceNativeEngine(): TNativeEngineLoadResult {
  return loadExpoNativeEngine()
}

/**
 * NetInfo and AppState, the signals the app client follows on device when the
 * app passes none of its own. Neither subscribes before the app client asks.
 */
export function createDevicePlatformPorts(): NonNullable<IStoreLocator['platformPorts']> {
  return { connectivity: createExpoConnectivity(), foreground: createExpoForeground() }
}
