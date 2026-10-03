/**
 * `createSupabaseKizunaSync` wires the browser worker store (`@kizunasync/web`), the
 * fenced `kizunasync.pull` / `kizunasync.push` RPC remote it builds (talking to
 * the SQL pack), and a bucketless config whose visible rows are still
 * constrained by server RLS.
 *
 * Normal todo CRUD goes through `kizunasync.from('todos')`. supabase-js owns auth.
 * The conflict lab uses one direct update to create an out-of-band change.
 * KizunaSync owns the local store and sync path.
 */

import { createLogger, type IKizunaSync, type ILogger, type IWakeup } from '@kizunasync/core'
import { createRealtimeWakeup, createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createConnectivityGate, createEngineEventLog, createGatedWakeup, createLiveSyncGate, createQueryLog, TODOS_TABLE, todosConfig, wireLabControls, type IQueryLog, type TEngineEventLogEntry } from '@kizunasync/utilities'
import { createWebConnectivity, createWebFileStore, createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

// MARK: - The kizunasync wrapper

const DB_FILE = 'kizunasync-todos.db'

// MARK: - Live-sync gate

/**
 * Effective live sync = the Live-sync toggle and not the Network "Offline
 * (simulated)" toggle, which force-suspends it regardless. The engine asks the
 * gate before every automatic wake (`shouldSyncAutomatically`), so while it is
 * inactive no poll tick, doorbell, return to connectivity or to the
 * foreground, or local write starts a sync, and "sync now" still runs unless
 * simulated-offline is on. The realtime doorbell also tears its channel down
 * while inactive, and turning live sync back on wakes the engine once.
 */
const gate = createLiveSyncGate()

// MARK: - Engine-event ring

/**
 * Bounded ring of every TEngineEvent, from @kizunasync/utilities. app.tsx is the
 * single writer: its one client.on() subscription (wired beside
 * subscribeVerdictToasts) records every event, so the ring holds the full
 * stream, including events that never toast. In memory only: a reload starts
 * an empty ring.
 */
const engineEventLog = createEngineEventLog()

export const recordEngineEvent = engineEventLog.record

// MARK: - The shim client surface

export interface IKizunaSyncShim extends IKizunaSync {
  /**
   * The examples-devtools query log: the reads and writes the board issues.
   * The kernel runs the store's own SQL in the worker, so nothing else reaches
   * it. The Cache tab subscribes for the live operations feed.
   */
  readonly queryLog: IQueryLog

  setLiveSync(enabled: boolean): void
  setOffline(value: boolean): void

  /**
   * The bounded engine-event ring the Cache tab's "Engine events" section
   * renders: every TEngineEvent, oldest first, capped by createEngineEventLog.
   * app.tsx is the sole writer via recordEngineEvent().
   */
  getEngineEvents(): readonly TEngineEventLogEntry[]

  /** Notifies on every recorded engine event. */
  subscribeEngineEvents(listener: () => void): () => void

  /**
   * Atomic local wipe: store, outbox, attachment sandbox, and the Debug rings
   * (queued / All operations / verdicts).
   */
  resetLocal(): Promise<void>

  /**
   * Rewind the durable cursor so the next pull re-walks history (the lab's
   * local approximation of the server's typed CHECKPOINT_EXPIRED signal).
   */
  expireCheckpoint(): Promise<void>

  /**
   * Write a conflicting edit directly to the server (bypassing the client) so a
   * later local edit + sync demonstrates last-write-wins. Returns a status line.
   */
  forceServerConflict(): Promise<string>
}

/**
 * Memoize the client so a re-invoked mount (React StrictMode double-invokes the
 * effect in dev) never builds a second client on the same database: the second
 * loses the leader election to the first and becomes its follower, a second
 * client over the one engine. Building it opens nothing; the engine opens on
 * the first call that needs it.
 */
let shim: IKizunaSyncShim | null = null

export const openKizunaSync = (): IKizunaSyncShim => {
  shim ??= openKizunaSyncOnce()

  return shim
}

const openKizunaSyncOnce = (): IKizunaSyncShim => {
  const queryLog = createQueryLog()
  const driver = createWebWorkerDriver(DB_FILE)
  // The one connectivity instance feeds both the engine and useSyncStatus, so the dot and the gating share a single source of truth: isOnline() is false while simulated-offline (the engine keeps mutations queued, going back online auto-flushes) and real transitions reach the engine only while live sync is active.
  const connectivity = createConnectivityGate({ inner: createWebConnectivity(), gate })
  // Attachment ports: bytes live in an OPFS content-addressed sandbox (createWebFileStore) and move via Supabase Storage + the confirm RPC: the fileStore alone is enough, the transfer comes with it. The engine's sync() drives uploads once the ref column has reached the server.
  const fileStore = createWebFileStore()
  const logger = createLogger({ level: 'debug' })
  const client = createSupabaseKizunaSync({
    supabase,
    driver,
    config: todosConfig,
    logging: { logger },
    connectivity,
    wakeup: gatedRealtimeWakeup(logger),
    shouldSyncAutomatically: () => gate.isActive(),
    inspector: true,
    fileStore,
  })
  // Skip the network round-trip while simulated-offline, so a "sync now" tap in the lab's offline mode is a no-op, like airplane mode. Online, the engine's sync() funnel uploads any queued attachment bytes once the outbox drains.
  const runSync = async (): Promise<void> => {
    if (gate.isOfflineSimulated()) {
      return
    }
    await client.sync()
  }
  const labControls = wireLabControls({ client, queryLog, remote: supabase, table: TODOS_TABLE })

  // Every member delegates by name: a spread would read the `engine` getter, and reading it opens the engine.
  return {
    from: (table) => client.from(table),
    rpc: (...args) => client.rpc(...args),
    schema: (...args) => client.schema(...args),
    getOpenApiSpec: (...args) => client.getOpenApiSpec(...args),
    on: (handler) => client.on(handler),
    setBucket: (params) => {
      client.setBucket(params)
    },
    pullOnce: () => client.pullOnce(),
    pushOnce: () => client.pushOnce(),
    getCheckpoint: () => client.getCheckpoint(),
    getOutboxDepth: () => client.getOutboxDepth(),
    getSyncHealth: () => client.getSyncHealth(),
    onSyncHealth: (listener) => client.onSyncHealth(listener),
    rejections: (options) => client.rejections(options),
    dismissRejection: (mutationId) => client.dismissRejection(mutationId),
    overwrites: (options) => client.overwrites(options),
    dismissOverwrite: (id) => client.dismissOverwrite(id),
    reset: () => client.reset(),
    seedCheckpoint: (cursor) => client.seedCheckpoint(cursor),
    dispose: () => {
      client.dispose()
    },
    setRemoteAccessToken: (token) => client.setRemoteAccessToken(token),
    get engine() {
      return client.engine
    },
    inspector: client.inspector,
    attachments: client.attachments,
    connectivity,
    queryLog,
    ...labControls,
    setLiveSync: gate.setLiveSync,
    setOffline: gate.setOffline,
    getEngineEvents: engineEventLog.entries,
    subscribeEngineEvents: engineEventLog.subscribe,
    sync: runSync,
  }
}

// MARK: - internal

/**
 * Realtime doorbell: a contentless wake hint on the 'todos' broadcast channel
 * (server triggers live in 0001_kizuna_init.sql). createRealtimeWakeup
 * from @kizunasync/supabase re-subscribes a dropped socket (expired token, sleeping
 * laptop). createGatedWakeup binds that channel to effective live sync: going
 * offline, or off the Live-sync toggle, removes the subscription and the client
 * stops being woken. The payload is a hint, never data, so it is dropped. A
 * missed signal delays the next poll.
 */
function gatedRealtimeWakeup(logger: ILogger): IWakeup {
  return createGatedWakeup({
    inner: createRealtimeWakeup(supabase, { tables: [TODOS_TABLE], logger }),
    gate,
  })
}
