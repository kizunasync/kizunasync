/**
 * createSupabaseKizunaSync wires the browser worker store (@kizunasync/web), the fenced
 * kizunasync.pull/push RPC remote it builds (talking to the SQL pack), and the
 * bucketless todosConfig from @kizunasync/utilities, whose visible rows are
 * constrained by server RLS. Normal todo CRUD goes through kizunasync.from('todos').
 * supabase-js owns auth. The conflict lab uses one direct update to create an
 * out-of-band change.
 */

import { createLogger, type IConnectivity, type IKizunaSync, type ILogger, type IWakeup } from '@kizunasync/core'
import { createRealtimeWakeup, createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createConnectivityGate, createEngineEventLog, createGatedWakeup, createLiveSyncGate, createQueryLog, TODOS_TABLE, todosConfig, wireLabControls, type IQueryLog, type TEngineEventLogEntry } from '@kizunasync/utilities'
import { createWebConnectivity, createWebFileStore, createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

// MARK: - The kizunasync wrapper

const DB_FILE = 'kizunasync-todos.db'

// MARK: - Live-sync gate

/**
 * Live sync defaults ON. Settings "Offline (simulated)" is airplane-mode
 * emulation on top. While either is off, the engine skips every automatic wake
 * (`shouldSyncAutomatically` asks the gate) and the realtime doorbell channel
 * is torn down. While simulated-offline is on, engine connectivity also reports
 * offline (mutations stay queued, the UI dot flips) and sync() no-ops. Turning
 * either back on is a transition the engine wakes on: it flushes the outbox
 * and live behavior resumes. Manual sync() is gated by the offline switch
 * alone.
 */
const gate = createLiveSyncGate()

// MARK: - Engine event log

/**
 * Bounded ring of every TEngineEvent, from @kizunasync/utilities. App.vue is the
 * single writer: its one kizunasync.on() subscription records every event, so the
 * ring holds the full stream, including events that never toast.
 */
const engineEventLog = createEngineEventLog()

export const recordEngineEvent = engineEventLog.record

// MARK: - The shim client surface

export interface IKizunaSyncShim extends IKizunaSync {
  setLiveSync(enabled: boolean): void
  setOffline(value: boolean): void

  /**
   * The query-log ring buffer the Cache tab renders: the entries the views
   * record at each read and write. The kernel runs the store's own SQL in the
   * worker, so nothing else reaches it.
   */
  queryLog: IQueryLog

  /**
   * The bounded engine-event ring the Cache tab's "Engine events" section
   * renders: every TEngineEvent, newest last, capped by createEngineEventLog.
   * App.vue is the sole writer via recordEngineEvent().
   */
  engineEvents: {
    read(): readonly TEngineEventLogEntry[]
    subscribe(listener: () => void): () => void
  }

  /**
   * Atomic local wipe: store, outbox, attachment sandbox, and the Debug rings
   * (queued / all operations / verdicts).
   */
  resetLocal(): Promise<void>

  /**
   * Rewind the durable cursor so the next pull re-walks history (the lab's
   * local approximation of the server's typed CHECKPOINT_EXPIRED signal).
   */
  expireCheckpoint(): Promise<void>

  /**
   * Write a conflicting edit directly to the server (bypassing the client) so
   * a later local edit plus sync demonstrates last-write-wins. Returns a
   * status line.
   */
  forceServerConflict(): Promise<string>
}

/**
 * Memoize the client so a re-invoked mount or HMR re-run never builds a second
 * client on the same database: the second loses the leader election to the first
 * and becomes its follower, a second client over the one engine. Building it
 * opens nothing; the engine opens on the first call that needs it.
 */
let shim: IKizunaSyncShim | null = null

export const openKizunaSync = (): IKizunaSyncShim => {
  shim ??= openKizunaSyncOnce()

  return shim
}

const openKizunaSyncOnce = (): IKizunaSyncShim => {
  const queryLog = createQueryLog()
  const driver = createWebWorkerDriver(DB_FILE)
  // Attachment ports: OPFS content-addressed sandbox + Supabase Storage/confirm. The engine's sync() drives uploads once the ref column reaches the server.
  const fileStore = createWebFileStore()
  const logger = createLogger({ level: 'debug' })
  const client = createSupabaseKizunaSync({
    supabase,
    driver,
    config: todosConfig,
    logging: { logger },
    connectivity: createConnectivityGate({ inner: createWebConnectivity(), gate }),
    wakeup: gatedRealtimeWakeup(logger),
    shouldSyncAutomatically: () => gate.isActive(),
    inspector: true,
    fileStore,
  })
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
    connectivity: client.connectivity,
    setLiveSync: gate.setLiveSync,
    setOffline: gate.setOffline,
    queryLog,
    // No-op a sync while offline: a real push/pull would fail at the socket, so this matches airplane mode: the outbox keeps queuing and flushes on return. Online, the engine's sync() funnel uploads queued attachment bytes after the outbox drains.
    sync: runSync,
    engineEvents: {
      read: engineEventLog.entries,
      subscribe: engineEventLog.subscribe,
    },
    ...labControls,
  }
}

// MARK: - Image helpers

/**
 * A picked File as an object-URL the UI previews immediately and hands to the
 * attachment port on Save: fromFile fetches the blob, hashes it, enqueues the
 * upload, and writes the ref it returns into image_path.
 */
export function previewUrlForFile(file: File): string {
  return URL.createObjectURL(file)
}

// MARK: - UI connectivity

/**
 * What useSyncStatus subscribes to so the status dot flips with the offline
 * toggle. Not the engine's gated connectivity: the dot must keep tracking the
 * real network even while the Live-sync toggle is off, whereas the engine's
 * wrapper swallows those transitions to keep its auto-flush quiet.
 */
export function createUiConnectivity(): IConnectivity {
  const real = createWebConnectivity()
  const isOnline = (): boolean => !gate.isOfflineSimulated() && real.isOnline()

  return {
    isOnline,
    subscribe: (onChange) => {
      const stopReal = real.subscribe(() => onChange(isOnline()))
      const stopGate = gate.subscribeOnline(() => onChange(isOnline()))

      return () => {
        stopReal()
        stopGate()
      }
    },
  }
}

/**
 * Realtime doorbell: a contentless wake hint on the 'todos' broadcast channel
 * (server triggers live in 0001_kizuna_init.sql). createRealtimeWakeup
 * from @kizunasync/supabase re-subscribes a dropped socket (expired token, sleeping
 * laptop). createGatedWakeup binds that channel to effective live sync:
 * toggling live-sync off or going simulated-offline removes the subscription
 * and the client stops being woken. The payload is a hint, never data, so it
 * is dropped. A missed signal delays the next manual sync.
 */
function gatedRealtimeWakeup(logger: ILogger): IWakeup {
  return createGatedWakeup({
    inner: createRealtimeWakeup(supabase, { tables: [TODOS_TABLE], logger }),
    gate,
  })
}

