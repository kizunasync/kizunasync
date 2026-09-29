import type { IStoreLocator } from '@kizunasync/core'
import { createExpoConnectivity } from './connectivity'
import { createExpoForeground } from './foreground'

/**
 * Name the database file the Rust kernel opens on device. The kernel holds the
 * only connection to it, so the locator carries the path and the device's own
 * network and foreground signals.
 */
export function createStoreLocator(databasePath: string): IStoreLocator {
  return { databasePath, platformPorts: createDevicePlatformPorts() }
}

/**
 * NetInfo and AppState, the signals the app client follows on device when the
 * app passes none of its own. Neither subscribes before the app client asks.
 */
export function createDevicePlatformPorts(): NonNullable<IStoreLocator['platformPorts']> {
  return { connectivity: createExpoConnectivity(), foreground: createExpoForeground() }
}
