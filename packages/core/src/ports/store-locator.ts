// MARK: - StoreLocator port

/**
 * What a JavaScript driver hands `createKizunaSync`: the store the Rust kernel
 * opens, or an engine the driver already runs. The kernel owns the only
 * connection to that store. A driver names it and never executes SQL against
 * it.
 *
 * Three drivers ship. `@kizunasync/expo`'s `createStoreLocator` reports the
 * `expo-sqlite` or `op-sqlite` file the kernel then opens through UniFFI.
 * `@kizunasync/web`'s `createWebWorkerDriver` reports the database its worker
 * opens on OPFS and carries the transport to the engine running there. A
 * host that wants a private store passes `{ databasePath: null }`.
 */

import type { IConnectivity } from './connectivity'
import type { TEngineTransportFactory } from './engine-transport'
import type { IForeground } from './foreground'

export interface IStoreLocator {
  /**
   * The SQLite database the kernel opens: a file path, or `null` for a private
   * in-memory store that dies with the process. The literal `':memory:'` names
   * that same private store, so a driver may report either.
   */
  readonly databasePath: string | null

  /**
   * A locator carrying `engineTransport` hands the core an engine the driver
   * already runs. `createKizunaSync` builds on it; it does not load one. The
   * browser worker driver is the case that needs it: the page can load no addon,
   * and the rows behind the transport are reachable nowhere else.
   */
  readonly engineTransport?: TEngineTransportFactory

  /**
   * The platform's own network and foreground signals, which the driver knows
   * and the app need not pass by hand. An explicit `connectivity` or
   * `foreground` option wins over these, and these win over the built-in
   * defaults.
   */
  readonly platformPorts?: { connectivity?: IConnectivity; foreground?: IForeground }
}

/**
 * Durability of an acknowledged write, as the engine's `store_kind` reports it:
 * 'full' survives an abrupt termination, 'relaxed' only an orderly one, 'none'
 * nothing beyond the process.
 */
export type TStoreDurability = 'full' | 'relaxed' | 'none'
