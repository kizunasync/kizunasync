import 'react-native-url-polyfill/auto'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store'
import { alwaysOnline, createConsoleLogger, type IConnectivity, type IKizunaSync, type ISyncHealth, type IWakeup, type TColumnValues } from '@kizunasync/core'
import { createExpoConnectivity, openExpoDriver } from '@kizunasync/expo'
import { openExpoFileStore } from '@kizunasync/expo/file-store'
import { createExpoSupabaseDownload } from '@kizunasync/expo/transfer'
import { createWebFileStore } from '@kizunasync/web'
import { createRealtimeWakeup, createSupabaseKizunaSync, createSupabaseTransfer } from '@kizunasync/supabase'
import { createConnectivityGate, createGatedWakeup, createLiveSyncGate, createQueryLog, messageOf, TODOS_TABLE, todosConfig, wireLabControls, type ILabControls, type IQueryLog } from '@kizunasync/utilities'

/**
 * Kizuna todo config/app client: thin glue over the REAL client.
 *
 * Engine + reconciliation live in @kizunasync/core; the expo-sqlite open lives in
 * @kizunasync/expo (openExpoDriver); the React data wiring lives in @kizunasync/react
 * hooks (app/(tabs)/(home)/index.tsx). What stays here is the example-specific
 * glue the hooks don't own: the todos defineConfig, the supabase remote binding
 * (sync upload + adapter), owner identity, and the booting placeholder for
 * web's async warm-up. Reads/writes themselves go through the exposed IKizunaSync
 * via the hooks.
 */
// MARK: - Kizuna todo config/app client

const DB_NAME = resolveDbName()
const BOOTING_NOTICE = 'starting local database…'

/**
 * Web database name. Every window on this origin has to resolve the SAME name or
 * the leader election in @kizunasync/web would give each one its own engine, so the id
 * is minted once and kept in localStorage. Native keeps one shared file.
 */
function mintDatabaseId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto

  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${performance.now().toString(36)}`
}

function resolveDbName(): string {
  if (Platform.OS !== 'web') {
    return 'kizunasync-todo-shim.db'
  }
  const store = (globalThis as { localStorage?: Storage }).localStorage
  const KEY = 'kizunasync-todo-id'
  let id = store?.getItem(KEY) ?? null

  if (id === null) {
    id = mintDatabaseId()
    store?.setItem(KEY, id)
  }
  return `kizunasync-todo-${id}.db`
}

/**
 * One client for the whole app: the screens import it for auth (sign-in /
 * account switch) and it is the same instance the remote, the realtime wakeup
 * and the transfer bind to. Built here so it exists at boot, when
 * createSupabaseKizunaSync composes all three.
 */
// MARK: - Supabase client

const SUPABASE_URL = (Constants.expoConfig?.extra?.supabaseUrl as string) ?? ''
const SUPABASE_PUBLISHABLE_KEY =
  (Constants.expoConfig?.extra?.supabasePublishableKey as string) ??
  (Constants.expoConfig?.extra?.supabaseAnonKey as string) ??
  ''

/**
 * Persist the Supabase session across launches so a relaunch RECOVERS the
 * signed-in user (e.g. Mary) instead of falling back to a fresh anonymous
 * identity, whose queued outbox would push under the wrong uid and be
 * RLS-rejected (the home screen's sign-in reuses an existing session). Per
 * Supabase's Expo guide: native persists in the SecureStore keychain, web in
 * AsyncStorage (localStorage). SecureStore warns above ~2KB; the demo's
 * anonymous/password sessions stay well under it.
 */
const sessionStore =
  Platform.OS === 'web'
    ? AsyncStorage
    : {
        getItem: (key: string) => getItemAsync(key),
        setItem: (key: string, value: string) => setItemAsync(key, value),
        removeItem: (key: string) => deleteItemAsync(key),
      }

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: sessionStore,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})

// MARK: - App-facing types

export interface ITodo {
  id: string

  /**
   * Owner of the row, the column the RLS policy filters on. Empty for an
   * inserted local row until the server round-trip stamps it, and the UI
   * treats empty as "mine".
   */
  user_id: string

  title: string
  done: boolean
  image_path: string | null
  archived_at: string | null
}

// MARK: - Edit a todo

/**
 * The fields an edit can change. `title` updates the row's text; `imagePath`
 * set to `null` removes the image, and `undefined` leaves it untouched. A
 * picked replacement never comes through here:
 * kizunasync.attachments.fromFile writes its ref onto the row itself.
 */
export interface ITodoEdit {
  title?: string
  imagePath?: null
}

/**
 * Single update mutation for an edit, same engine path as toggle/add/delete.
 * The caller passes the live client from useMutation's
 * mutate(k => editTodo(k, id, …)); the write syncs and reconciles normally.
 *
 * image_path is a normal synced column; the attachment port owns the bytes
 * and writes a replacement's ref itself. Removing nulls image_path; that
 * clear syncs to the server.
 */
export function editTodo(kizunasync: IKizunaSync, id: string, edit: ITodoEdit): PromiseLike<unknown> {
  const values: TColumnValues = {}

  if (edit.title !== undefined) {
    values.title = edit.title
  }
  if (edit.imagePath !== undefined) {
    values.image_path = edit.imagePath
  }
  queryLog.record({ op: 'UPDATE', label: 'todos · edit title/image', rows: 1 })

  return kizunasync.from(TODOS_TABLE).update(values).eq('id', id)
}

/**
 * Sessions are App state but the app client is created at module scope, so the owner
 * id flows through this setter: index.tsx calls it after sign-in. It pins image
 * paths to <ownerId>/… and stamps inserts with user_id (RLS-with-check).
 * Until it is set, image pushes fail; they do not write to a foreign path.
 */
// MARK: - Owner identity

let ownerId: string | null = null

export function setOwnerId(id: string | null): void {
  ownerId = id
}

/**
 * A ring buffer recording the reads and writes the screens issue. The kernel
 * owns the store on both targets, so nothing else reaches the log. Created at
 * module scope so the read sites can record before the live client lands.
 */
// MARK: - Query log

const queryLog: IQueryLog = createQueryLog()

export function getQueryLog(): IQueryLog {
  return queryLog
}

// MARK: - App client-local sync state

/**
 * Effective live sync, meaning the Live-sync master switch AND not the Network
 * "Offline (simulated)" toggle. The engine never learns the lab exists: the gate
 * reshapes the connectivity and wakeup ports handed to it at boot and answers
 * its `shouldSyncAutomatically` switch.
 */
const gate = createLiveSyncGate()
let bootNotice: string | null = BOOTING_NOTICE

/**
 * When a sync cycle last resolved successfully (ms epoch), or null before the
 * first one. The engine's own sync-health tracker owns it, so a poll tick and
 * the engine's local-write wake stamp it as surely as the screen's manual "sync
 * now" does.
 */
export function getLastSyncAt(): number | null {
  return kizunasync.getSyncHealth().lastSuccessAt
}

/** Subscribe to sync-health changes (useSyncExternalStore's contract). */
export function subscribeLastSync(listener: () => void): () => void {
  return kizunasync.onSyncHealth(() => listener())
}

/**
 * A non-null notice means the live client isn't wired yet: the boot placeholder
 * is in place (web before warm-up, or a failed/unsupported web boot). The
 * SyncBar shows it so the page explains itself; it clears once the real client
 * lands.
 */
export function getBootNotice(): string | null {
  return bootNotice
}

/**
 * The shim composes ONE Supabase client at boot: the module-scope `supabase`
 * above backs the remote, the realtime doorbell AND the transfer. supabase-js
 * mutates that client's session in place and the account switcher never swaps
 * instances, so a second client reaching sync() can only be a programming
 * error, and silently syncing through the composed one would hide it (@../../../CONVENTIONS.md).
 */
class ForeignClientError extends Error {
  readonly code = 'FOREIGN_SUPABASE_CLIENT'
  constructor() {
    super(
      'the shim composes one Supabase client at boot; account switching reuses it, so a second client is a programming error',
    )
    this.name = 'ForeignClientError'
  }
}

/**
 * openExpoDriver names the native file (then closes expo-sqlite) or returns the
 * web worker driver. The boot builds the client and its attachment file store
 * at module init and opens neither. A boot that throws leaves a booting
 * placeholder carrying the failure as its notice; the app awaits whenReady()
 * and wires its <KizunaSyncProvider> to whichever client it hands back.
 */
// MARK: - Client

let kizunasync: IKizunaSync = createBootingKizunaSync()

/**
 * Rebuilt at client construction (module init, and each time boot() lands a
 * new kizunasync below), never per button press: the same rule the other two
 * examples follow for their own lab controls.
 */
let labControls: ILabControls = wireLabControls({ client: kizunasync, queryLog, remote: supabase, table: TODOS_TABLE })

/**
 * Memoize the boot on globalThis, not module scope. Expo web Fast Refresh /
 * expo-router re-evaluating this module must not start a second boot: the
 * second client loses the leader election to the first and runs its own
 * scheduler and outbox drain over the same engine. One boot per page session,
 * surviving HMR.
 */
const bootHost = globalThis as typeof globalThis & { __kizunasyncBoot?: IKizunaSync }
const booted: IKizunaSync = (bootHost.__kizunasyncBoot ??= boot())

/**
 * Resolves with the booted client. The layout awaits it to hand the
 * IKizunaSync to <KizunaSyncProvider>. Never rejects: a failed boot resolves
 * with the placeholder and leaves its notice visible.
 */
export function whenReady(): Promise<IKizunaSync> {
  return Promise.resolve(booted)
}

/**
 * The current client (the booting placeholder until boot() lands the live
 * one). The app's initial render uses it; whenReady hands back the booted one.
 */
export function getClient(): IKizunaSync {
  return kizunasync
}

// MARK: - Sync

export async function sync(client: SupabaseClient): Promise<void> {
  if (gate.isOfflineSimulated()) {
    return
  }
  if (client !== supabase) {
    throw new ForeignClientError()
  }
  // Nobody is signed in until setOwnerId lands a session user, and a push under no identity is refused by RLS, so the round trip waits for sign-in.
  if (ownerId === null || ownerId === '') {
    return
  }
  // The engine's sync() funnel uploads any queued attachment bytes after the outbox drains (no manual upload pass).
  await kizunasync.sync()
}

// MARK: - Edge-case lab hooks

/**
 * Network toggle (Settings → Network). ON emulates offline: the realtime
 * doorbell channel is torn down, not ignored; the engine's own local-write wake
 * reaches no wire; connectivity reports offline; sync() no-ops. Effective
 * live-sync = live && !offline. Flipping back online re-subscribes the doorbell
 * and auto-flushes the queued outbox.
 */
export function setOfflineSimulated(value: boolean): void {
  gate.setOffline(value)
}

export function isOfflineSimulated(): boolean {
  return gate.isOfflineSimulated()
}

/**
 * Live-sync master switch (default ON). Off ⇒ the engine skips every automatic
 * wake (poll, doorbell, reconnect, foreground, local write) and the gated
 * wakeup drops realtime doorbells, so the client only syncs when the user taps
 * "sync now". On ⇒ the engine wakes once, and a peer's write wakes this client
 * to pull (server doorbell in 0001_kizuna_init.sql). Manual sync() ignores this
 * flag: it is gated only by the simulated-offline toggle.
 */
export function setLiveSync(value: boolean): void {
  gate.setLiveSync(value)
}

export function isLiveSyncEnabled(): boolean {
  return gate.isLiveSyncEnabled()
}

/**
 * Rewind the durable cursor to bootstrap so the next pull re-walks history.
 * The REAL mechanism is the server-driven typed CHECKPOINT_EXPIRED signal;
 * this is only the lab's local approximation. Fire-and-forget, matching the
 * settings screens' own call sites, which never await it.
 */
export function expireCheckpoint(): void {
  void labControls.expireCheckpoint()
}

/**
 * Atomic, quiet local wipe: store + outbox + attachment sandbox (kizunasync.reset)
 * + the Debug tab's two in-memory rings (the query log / all-operations list and
 * the inspector's verdict ring). The rings are cleared LAST so the reset's own
 * SQL is wiped too.
 * Awaiting matters on account switch: the caller re-pulls right after, and a
 * fire-and-forget reset would race the pull's apply.
 */
export async function resetLocal(): Promise<void> {
  await labControls.resetLocal()
}

/**
 * Write a conflicting edit DIRECTLY to the server (bypassing the client) so a
 * later local edit + sync shows last-write-wins.
 */
export async function forceServerConflict(): Promise<string> {
  return labControls.forceServerConflict()
}

// MARK: - Boot

function boot(): IKizunaSync {
  try {
    // Web opens the @kizunasync/web driver: the Rust engine runs in a dedicated worker over OPFS (or the relaxed IndexedDB fallback), one leading tab per database with the others proxied to it, so no cross-origin isolation and no per-tab database name are needed. Native names the expo-sqlite file and closes it.
    const driver = openExpoDriver(DB_NAME)
    // Real device connectivity drives auto-flush on reconnect; the edge-case lab's "go offline" toggle stays a manual override in sync() above. Attachment ports (ALL platforms): bytes live in a content-addressed sandbox and move via Supabase Storage + the confirm RPC. Native uses the documentDirectory store (openExpoFileStore); web uses an OPFS store (createWebFileStore), separate from the engine's own store. The UI renders the resolved LOCAL object URL on both.
    const fileStore = Platform.OS === 'web' ? createWebFileStore() : openExpoFileStore()
    const logger = createConsoleLogger('debug')
    // Native needs the expo-file-system download (RN forbids Blob-from-ArrayBuffer, which supabase-js download / fetch().blob() both hit); web uses the base transfer unmodified. The native transfer composes the base's four methods with the expo download decorator overriding only `download`.
    const transferPorts = { client: supabase, fileStore, logger: logger.child('transfer') }
    const transfer =
      Platform.OS === 'web'
        ? createSupabaseTransfer(transferPorts)
        : { ...createSupabaseTransfer(transferPorts), download: createExpoSupabaseDownload(transferPorts) }

    kizunasync = createSupabaseKizunaSync({
      supabase,
      driver,
      config: todosConfig,
      logging: { logger },
      connectivity: createConnectivityGate({ inner: createExpoConnectivity(), gate }),
      // Realtime DOORBELL: a contentless wake hint on the 'todos' channel that debounces into a sync(). The engine subscribes synchronously here, so the client must exist at boot, hence the module-scope supabase above. The logger surfaces the adapter's drop/reconnect transitions, which are otherwise invisible: a dead doorbell looks exactly like a quiet table.
      wakeup: createGatedWakeup({
        inner: createRealtimeWakeup(supabase, { tables: [TODOS_TABLE], logger }),
        gate,
      }),
      shouldSyncAutomatically: () => gate.isActive(),
      inspector: true,
      fileStore,
      transfer,
    })
    labControls = wireLabControls({ client: kizunasync, queryLog, remote: supabase, table: TODOS_TABLE })
    bootNotice = null
    void writeEngineProbe(kizunasync.engine)

    return kizunasync
  } catch (error) {
    kizunasync = createBootingKizunaSync(`local database failed to start: ${messageOf(error)}`)
    labControls = wireLabControls({ client: kizunasync, queryLog, remote: supabase, table: TODOS_TABLE })

    return kizunasync
  }
}

/** Simulator-smoke probe: the launched app writes `kizunasync.engine` to Documents. */
const ENGINE_PROBE_FILE_NAME = 'kizunasync-engine.txt'

/** A hoisted declaration on purpose: `boot()` calls it while the module is still evaluating, above this line. */
async function writeEngineProbe(engine: string): Promise<void> {
  if (Platform.OS === 'web') {
    return
  }
  try {
    const FileSystem = await import('expo-file-system/legacy')
    const dir = FileSystem.documentDirectory

    if (dir === null || dir === undefined) {
      return
    }
    await FileSystem.writeAsStringAsync(`${dir}${ENGINE_PROBE_FILE_NAME}`, engine)
  } catch {
    // Smoke-only. A missing FS module must not fail boot.
  }
}

// MARK: - internal

/** The placeholder has no sync loop, so its health is a frozen idle snapshot. */
const BOOTING_SYNC_HEALTH: ISyncHealth = Object.freeze({
  phase: 'idle',
  consecutiveFailures: 0,
  nextAttemptAt: null,
  attemptStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
})

/**
 * Same surface as the client, inert until the real one swaps in. Reads return
 * empty/booting state so the UI renders a calm "starting" view. Writes and
 * syncs throw; they do not drop mutations.
 */
function createBootingKizunaSync(notice: string = BOOTING_NOTICE): IKizunaSync {
  bootNotice = notice
  const refuse = async (): Promise<never> => {
    throw new Error(notice)
  }
  const refusingBuilder = {
    insert: refuse,
    update: () => {
      throw new Error(notice)
    },
    delete: () => {
      throw new Error(notice)
    },
    select: () => ({
      eq: () => refusingBuilder.select(),
      order: () => refusingBuilder.select(),
      limit: () => refusingBuilder.select(),
      then: (onfulfilled: (value: { data: TColumnValues[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(onfulfilled),
    }),
    upsert: () => {
      throw new Error(notice)
    },
    rpc: () => {
      throw new Error(notice)
    },
  }

  return {
    engine: 'rust',
    from: () => refusingBuilder as unknown as ReturnType<IKizunaSync['from']>,
    rpc: () => {
      throw new Error(notice)
    },
    schema: () => {
      throw new Error(notice)
    },
    getOpenApiSpec: () => {
      throw new Error(notice)
    },
    on: () => () => {},
    setBucket: () => {},
    sync: refuse,
    pullOnce: refuse,
    pushOnce: refuse,
    getCheckpoint: () => Promise.resolve({ cursor: '0', schemaVersion: 1, softBlocked: false }),
    getOutboxDepth: () => Promise.resolve(0),
    getSyncHealth: () => BOOTING_SYNC_HEALTH,
    onSyncHealth: () => () => {},
    rejections: () => Promise.resolve([]),
    dismissRejection: async () => {},
    overwrites: () => Promise.resolve([]),
    dismissOverwrite: async () => {},
    reset: async () => {},
    seedCheckpoint: async () => {},
    dispose: () => {},
    setRemoteAccessToken: async () => {},
    attachments: {
      fromFile: refuse,
      resolveDownload: refuse,
      vacuum: refuse,
      getStatus: refuse,
      watch: () => () => {},
      retry: refuse,
      cancel: refuse,
      remove: refuse,
    },
    connectivity: alwaysOnline,
  }
}
