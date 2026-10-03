// MARK: - StoreLocator port

/**
 * What a JavaScript driver hands `createKizunaSync`: the store the Rust kernel
 * opens, or an engine the driver already runs. The kernel owns the only
 * connection to that store. A driver names it and never executes SQL against
 * it.
 *
 * Three drivers ship. `@kizunasync/expo`'s `createStoreLocator` reports the
 * `expo-sqlite` or `op-sqlite` file the kernel then opens through UniFFI, and
 * carries the loader for that engine.
 * `@kizunasync/web`'s `createWebWorkerDriver` reports the database its worker
 * opens on OPFS and carries the transport to the engine running there. A
 * host that wants a private store passes `{ databasePath: null }`.
 */

import type { TUniffiHandle } from '../query/rust-uniffi-engine'
import type { IConnectivity } from './connectivity'
import type { TEngineTransportFactory } from './engine-transport'
import type { IForeground } from './foreground'

/**
 * What a locator's `loadNativeEngine` answers: the handle the native build
 * links, or the message that says why it did not load.
 */
export type TNativeEngineLoadResult = { ok: true; handle: TUniffiHandle } | { ok: false; message: string }

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
   * Loads the Rust engine a native build links. The `@kizunasync/expo` drivers
   * fill it on iOS and Android through `@kizunasync/rn-uniffi`, which they
   * declare and this package does not, so a strict install layout resolves it
   * from them. The app client calls it once, on its first engine call, unless
   * the host injected a `uniffiHandle`; a failure fails that call with
   * `ENGINE_UNAVAILABLE` carrying `message`.
   */
  readonly loadNativeEngine?: () => TNativeEngineLoadResult

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
