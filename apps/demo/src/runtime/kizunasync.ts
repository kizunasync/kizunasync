/**
 * What makes a pane a separate DEVICE: its own OPFS database, supabase-js
 * client (hence its own anonymous session), engine, and simulated-offline
 * switch. None of that is module-scope. The todo-react example can keep
 * singletons because it is one device; this demo is two, so every piece of
 * mutable state lives inside the closure below. Gate, connectivity, and
 * wakeup wrappers come from @kizunasync/utilities, the same pieces the React and
 * Vue examples share. This demo has no separate live-sync toggle: the gate's
 * live-sync flag stays permanently on, and only its offline switch is
 * driven.
 */

import { createLogger, EWireEntryKind, type IKizunaSync, type TEngineEvent } from '@kizunasync/core'
import { createRealtimeWakeup, createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createConnectivityGate, createGatedWakeup, createLiveSyncGate } from '@kizunasync/utilities'
import { createWebConnectivity, createWebWorkerDriver } from '@kizunasync/web'
import type { SupabaseClient } from '@supabase/supabase-js'
import { demoConfig, PANE_DB_FILES, SESSION_OWNER_PANE, TODOS_TABLE, type TPaneId } from '@/runtime/demo-config'
import { createPaneSupabaseClient } from '@/runtime/supabase-client'
import type { IWireLog } from '@/runtime/wire-log'

// MARK: - One pane = one whole client

export interface IPaneClient extends IKizunaSync {
  readonly pane: TPaneId

  /**
   * The supabase-js client behind this pane, for the sign-in the RLS fixture
   * requires (every public.todos policy is `to authenticated`).
   */
  readonly supabase: SupabaseClient

  isOffline(): boolean
  setOffline(value: boolean): void
  subscribeOffline(listener: (offline: boolean) => void): () => void

  /**
   * The pane's signed-in uid. Inserts must stamp it: the fixture's INSERT policy
   * is `with check (auth.uid() = user_id)`, so a row claiming another owner is
   * refused. null until sign-in completes.
   */
  getOwnerId(): string | null

  setOwnerId(id: string | null): void

  /** Atomic local wipe: store, outbox, and durable cursor. */
  resetLocal(): Promise<void>
}

export const openPaneKizunaSync = (pane: TPaneId, wireLog: IWireLog): IPaneClient => {
  const supabase = createPaneSupabaseClient({ pane, wireLog })
  const driver = createWebWorkerDriver(PANE_DB_FILES[pane])

  let ownerId: string | null = null
  const gate = createLiveSyncGate()
  const logger = createLogger({ level: 'warn' })

  // The simulated-offline override layered over real browser connectivity. When on: isOnline() reports false (the engine keeps mutations queued, the dot flips), the realtime channel is torn down, the engine's own local-write wake reaches no wire, and sync() no-ops: airplane mode, not a slow network. One instance feeds BOTH the engine and useSyncStatus so the dot and the gating share a source.
  const connectivity = createConnectivityGate({ inner: createWebConnectivity(), gate })

  // The realtime DOORBELL: a contentless wake hint on the todos broadcast channel (the fixture's server triggers fire it). createGatedWakeup binds it to the pane's offline switch, so the channel exists only while the pane is online. "Offline" stops the pane being woken; it does not merely ignore the ring.
  const wakeup = createGatedWakeup({
    inner: createRealtimeWakeup(supabase, { tables: [TODOS_TABLE], logger }),
    gate,
  })

  const client = createSupabaseKizunaSync({
    supabase,
    driver,
    config: demoConfig,
    connectivity,
    wakeup,
    shouldSyncAutomatically: () => gate.isActive(),
    logging: { logger },
    // Only the session-owner pane may rotate the shared refresh token. The follower still wakes on visibility so it syncs after adopting tokens.
    refreshOnForeground: pane === SESSION_OWNER_PANE,
  })

  // Every engine event reaches the wire log tagged with this pane. The viewer renders them; this handler does not write to the console.
  const unsubscribeEvents = client.on((event: TEngineEvent) => {
    wireLog.record(pane, { kind: EWireEntryKind.engine, event })
  })

  // A "sync now" tap while simulated-offline is airplane mode, not a failed request. The engine's own scheduler is gated by the same switch through `shouldSyncAutomatically` and `connectivity`, so this only covers the manual path.
  const runSync = async (): Promise<void> => {
    if (gate.isOfflineSimulated()) {
      return
    }
    await client.sync()
  }

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
    setRemoteAccessToken: (token) => client.setRemoteAccessToken(token),
    get engine() {
      return client.engine
    },
    inspector: client.inspector,
    attachments: client.attachments,
    pane,
    supabase,
    connectivity,
    isOffline: gate.isOfflineSimulated,
    setOffline: gate.setOffline,
    getOwnerId: () => ownerId,
    setOwnerId: (id) => {
      ownerId = id
    },
    subscribeOffline: (listener) => gate.subscribeOnline((online) => listener(!online)),
    sync: runSync,
    resetLocal: () => client.reset(),
    dispose() {
      unsubscribeEvents()
      client.dispose()
    },
  }
}
