// MARK: - The app client's engine port + which engine backs it

/**
 * `createKizunaSync` builds ONE app client (query builder, scheduler, inspector,
 * rejection journal) over the port below. The Rust core is the only engine
 * that backs it.
 *
 * Selection walks four candidates, in this order, and never degrades:
 *
 * 1. the locator CARRIES an engine (`engineTransport`, which `@kizunasync/web`'s
 *    worker driver reports): its rows are reachable through the transport
 *    and nowhere else;
 * 2. a UniFFI handle is linked, which is the React Native path;
 * 3. the NAPI addon loads, which is the Node and Bun path;
 * 4. nothing resolved: `ENGINE_UNAVAILABLE`, naming the artifact to install.
 *
 * The Rust core is the only protocol implementation here. A runtime that
 * ships no engine says so on the app client's first use; it does not run a
 * second one behind the app's back (a difference an app would only discover in
 * production).
 *
 * The engine owns the only connection to the store the locator names, and a
 * `databasePath` of `null` asks it for a private in-memory one.
 *
 * Attachments are not such a case: the engine mounts the same queue
 * (`host/attachment-queue.ts`) over its own store, so a config declaring
 * `attachment()` runs like any other. The missing-ports refusal sits one
 * layer up: `createKizunaSync` throws `ATTACHMENT_PORTS_MISSING` before an engine
 * is ever chosen.
 */

import type { ISyncHealth } from '../host/sync-health'
import type { IAttachmentClient } from '../host/attachment-queue'
import type { IStoreLocator } from '../ports/store-locator'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { ILogger } from '../util/logger'
import type { IInspectorSnapshot } from './inspector'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import { loadNapiAddon, napiLoadFailures, napiPlatformPackage } from './napi-loader'
import { createRustEngine } from './rust-engine'
import { createRustUniffiEngine } from './rust-uniffi-engine'
import { probeUniffiFailureMessage, probeUniffiHandle } from './uniffi-probe'
import type { ISyncEngine, TBucketParams, TEngineConfig, TEngineDeps, TOverwriteRecord, TRejectionRecord, TUuid } from '../wire/types'

// MARK: - The port

/**
 * Everything `createKizunaSync` needs from an engine: `ISyncEngine` plus the four
 * surfaces the app client exposes on top of it.
 */
export interface IAppClientEngine extends ISyncEngine {
  /** Set the runtime bucket equality values (`byColumn` / `byOwner`) the pull request's buckets carry. */
  setBucket(params: TBucketParams): void

  rejections(options?: { includeDismissed?: boolean }): Promise<TRejectionRecord[]>
  dismissRejection(mutationId: TUuid): Promise<void>
  overwrites(options?: { includeDismissed?: boolean }): Promise<TOverwriteRecord[]>
  dismissOverwrite(id: number): Promise<void>

  /** One coherent point-in-time read of the local command queue (devtools). */
  inspect(): Promise<IInspectorSnapshot>

  /**
   * Point-in-time state of the automatic sync loop (phase, failure streak, next
   * attempt, last error). Diagnostics, deliberately outside TEngineEvent.
   */
  getSyncHealth(): ISyncHealth

  onSyncHealth(listener: (health: ISyncHealth) => void): () => void
  readonly attachments: IAttachmentClient | null

  /**
   * Replace the user JWT on the native HTTP remote. No-op on the NAPI callback
   * remote (supabase-js already attaches the session).
   */
  setRemoteAccessToken?(token: string | null): Promise<void>
}

/**
 * What `kizunasync.engine` reports. One value: `createKizunaSync` runs the Rust core or
 * throws.
 */
export type TEngineKind = 'rust'

// MARK: - Selection

interface ISelectedEngine {
  engine: IAppClientEngine
  kind: TEngineKind
}

function unavailable(message: string): TEngineError {
  return new TEngineError(EEngineErrorCode.ENGINE_UNAVAILABLE, message)
}

/**
 * React Native answers this and nothing else does; a browser reports the engine
 * name, and Node has no `navigator.product` at all. Read defensively because a
 * runtime is free to ship no `navigator`.
 */
function isReactNative(): boolean {
  return (globalThis as { navigator?: { product?: string } }).navigator?.product === 'ReactNative'
}

/**
 * What to install, and everywhere the loader looked with why each place
 * failed. A developer reading this in a stack trace needs all three: the
 * package name is the fix, the paths tell them a build they thought they had
 * is not where they think, and the reason tells a missing file from a build
 * for another architecture or ABI.
 */
function napiFailure(): string {
  const packageName = napiPlatformPackage()
  const install =
    packageName === null
      ? 'no @kizunasync/napi platform package is published for this platform, so build the addon with `cargo build -p kizunasync-napi`'
      : `install ${packageName} (it ships with @kizunasync/core as an optional dependency), or build the addon with \`cargo build -p kizunasync-napi\``
  const failures = napiLoadFailures()
  const where =
    failures.length === 0
      ? 'this runtime exposes no way to load one'
      : `tried ${failures.map(({ path, reason }) => `${path} (${reason})`).join(', ')}`

  return `no Rust engine is loadable in this process: ${install}; ${where}`
}

const UNIFFI_MISSING =
  'no Rust engine is linked into this React Native app: install @kizunasync/rn-uniffi and register its ' +
  'Turbo Module in a native rebuild (a JavaScript reload cannot load one)'

interface IEngineSelectionOptions {
  db: IStoreLocator
  remote: IProtocolRemote
  config: TEngineConfig
  clientId: string
  deps: TEngineDeps
  logger: ILogger
  now: () => string
  uuid: () => string

  /** The token the app client was handed before the open; see `IRustEngineOptions.accessToken`. */
  accessToken?: string | null
}

export const selectEngine = (options: IEngineSelectionOptions): ISelectedEngine => {
  const { db, remote, config, deps, logger } = options
  const { databasePath, engineTransport } = db

  // A locator that carries its own engine (the browser worker) has already made the choice: its rows are reachable through the transport and nowhere else (@../../../../CONVENTIONS.md).
  if (engineTransport !== undefined) {
    logger.debug('engine: rust (driver transport)')

    return {
      engine: createRustEngine({
        engineFactory: engineTransport,
        databasePath,
        remote,
        config,
        clientId: options.clientId,
        now: options.now,
        uuid: options.uuid,
        logger,
        deps,
        accessToken: options.accessToken,
      }),
      kind: 'rust',
    }
  }
  const uniffi = deps.uniffiHandle ?? probeUniffiHandle()

  if (uniffi !== null) {
    logger.debug('engine: rust (uniffi)')

    return {
      engine: createRustUniffiEngine({
        handle: uniffi,
        databasePath,
        remote,
        config,
        clientId: options.clientId,
        now: options.now,
        uuid: options.uuid,
        logger,
        deps,
        accessToken: options.accessToken,
      }),
      kind: 'rust',
    }
  }
  const addon = loadNapiAddon()

  if (addon === null) {
    // React Native loads no addon by construction, so naming one would send the reader after an artifact their platform never had. `@kizunasync/rn-uniffi` names the exact reason (Expo Go, or any build without the package) when the probe above reached it; `UNIFFI_MISSING` is the fallback for when the package itself did not resolve.
    throw unavailable(isReactNative() ? (probeUniffiFailureMessage() ?? UNIFFI_MISSING) : napiFailure())
  }
  return {
    engine: createRustEngine({
      addon,
      databasePath,
      remote,
      config,
      clientId: options.clientId,
      now: options.now,
      uuid: options.uuid,
      logger,
      deps,
      accessToken: options.accessToken,
    }),
    kind: 'rust',
  }
}
