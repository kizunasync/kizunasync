// MARK: - createSupabaseKizunaSync composition

/**
 * The one-call entry point owes the caller three things: the remote is ALWAYS
 * the fenced kizunasync RPC remote, and the transfer / wakeup ports are derived
 * from what the caller already passed (fileStore, config.realtimeWakeups) unless
 * the caller supplied its own: an explicit port always wins.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { attachment, defineConfig, EEngineErrorCode, EVerdictKind, type IFileStore, type IForeground, type IKizunaSync, type ILogger, type IStoreLocator, type ISyncHealth, type ITransfer, type IWakeup, type TPullResponse, type TPushRequest, type TUniffiHandle } from '@kizunasync/core'
import { createTempDatabase } from '@kizunasync/core/testing'
import { createDocumentForeground, createSupabaseKizunaSync } from './create-supabase-kizunasync'

const EMPTY_PULL: TPullResponse = { cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }

type TTodoRow = {
  id: string
  user_id: string
  title: string
  image_path: string | null

  /**
   * Device-only: the server has no slot for it, so a remote built with
   * localOnlyColumns must strip it before push.
   */
  local_image_uri: string | null
}

type TTodoDatabase = {
  public: { Tables: { todos: { Row: TTodoRow } } }
}

/**
 * Wake-ups default ON, so the ports under test opt out explicitly to keep the
 * realtime channel out of every assertion that is not about it.
 */
const CONFIG = defineConfig<TTodoDatabase>({
  realtimeWakeups: false,
  tables: { todos: { sync: 'read-write' } },
})

const ATTACHMENT_CONFIG = defineConfig<TTodoDatabase>({
  realtimeWakeups: false,
  tables: {
    todos: {
      sync: 'read-write',
      attachments: { image_path: attachment('todos', { ownerColumn: 'user_id' }) },
    },
  },
})

const WAKEUP_CONFIG = defineConfig<TTodoDatabase>({
  realtimeWakeups: true,
  tables: { todos: { sync: 'read-write' } },
})

// MARK: - Fakes

/**
 * The transfer and the file store are never driven here, only the DECISION to
 * build them is under test, so a bare sentinel is enough.
 */
const FAKE_FILE_STORE = {} as unknown as IFileStore
const FAKE_TRANSFER = {} as unknown as ITransfer

const makeDriver = (): IStoreLocator => createTempDatabase().driver

/**
 * Inert host so bun's `document` cannot attach `visibilitychange` and wake
 * a NAPI engine the test is about to close. Tests that assert foreground
 * pass their own port and override this.
 */
const INERT_FOREGROUND: IForeground = { subscribe: () => () => undefined }

/** Composition under test, with the poll loop off so a NAPI close cannot race a tick. */
const compose = (
  options: Parameters<typeof createSupabaseKizunaSync>[0],
): ReturnType<typeof createSupabaseKizunaSync> =>
  createSupabaseKizunaSync({
    pollIntervalMs: 0,
    inspector: false,
    foreground: INERT_FOREGROUND,
    ...options,
  })

/**
 * Drain the fire-and-forget `getSession` → `setRemoteAccessToken` hop, then
 * close. Closing while a `call()` is in flight rejects it as `kizunasync engine
 * stopped before replying`, which bun attributes to the next test.
 */
const dispose = async (kizunasync: Pick<IKizunaSync, 'dispose' | 'getCheckpoint'>): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()

  try {
    await kizunasync.getCheckpoint()
  } catch {
    // Already closed, or a call already failed; still drop the handle.
  }
  kizunasync.dispose()
}

/**
 * Virtual setTimer/clearTimer pair for a test that races two real timers
 * chained through createSupabaseKizunaSync (the session deadline via withDeadline,
 * then the scheduler's WAKE_DEBOUNCE_MS): both flow through the same injected
 * pair, so advance() fires each in turn deterministically instead of a wall-clock
 * wait. setImmediate flushes both microtasks and any pending NAPI callback
 * between timers, mirroring the scheduler's own virtual-clock test helper.
 */
const createVirtualClock = (): {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  advance: (ms: number) => Promise<void>
} => {
  const pending = new Map<number, { at: number; callback: () => void }>()
  let nowMs = 0
  let nextHandle = 0
  // More rounds than the scheduler's own virtual-clock helper needs: firing the wake timer here drives a REAL NAPI round trip (engine call queued behind `pending`, dispatched to Rust, answered through a threadsafe function callback), which can take several event-loop turns to settle.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return {
    setTimer: (callback, delayMs) => {
      nextHandle += 1
      pending.set(nextHandle, { at: nowMs + delayMs, callback })

      return nextHandle
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
    advance: async (ms) => {
      const target = nowMs + ms

      for (;;) {
        let dueHandle: number | null = null
        let dueAt = Number.POSITIVE_INFINITY

        for (const [handle, entry] of pending) {
          if (entry.at <= target && entry.at < dueAt) {
            dueHandle = handle
            dueAt = entry.at
          }
        }
        if (dueHandle === null) {
          break
        }
        const entry = pending.get(dueHandle)!

        pending.delete(dueHandle)
        nowMs = entry.at
        entry.callback()
        await flush()
      }
      nowMs = target
    },
  }
}

/**
 * The forwarded wake's own completion, not a count of milliseconds. Firing the
 * scheduler's debounce starts a real N-API round trip, and how long that takes
 * is the machine's business: the loop publishes each attempt it starts and
 * settles through `onSyncHealth`, so the next attempt settling is the one
 * signal that means "the wake has landed its pull". Subscribe BEFORE the wake,
 * or the transition can be missed. Subscribing opens the engine.
 */
const whenWakeSettles = (kizunasync: {
  onSyncHealth: (listener: (health: ISyncHealth) => void) => () => void
}): Promise<void> =>
  new Promise((resolve) => {
    let hasStarted = false
    const stop = kizunasync.onSyncHealth((health) => {
      if (health.attemptStartedAt !== null) {
        hasStarted = true

        return
      }
      if (hasStarted) {
        stop()
        resolve()
      }
    })
  })

/**
 * Opens the client's engine, which is when the client subscribes its
 * wakeup, foreground, and connectivity ports and arms the loop's start attempt.
 */
const openEngine = (kizunasync: { getSyncHealth: () => ISyncHealth }): void => {
  kizunasync.getSyncHealth()
}

/**
 * Opens the engine, waits out the loop's start attempt on real timers, and
 * forgets the RPCs it made, so a later assertion sees only what the test's own
 * signal caused.
 */
const settleStart = async (
  kizunasync: { onSyncHealth: (listener: (health: ISyncHealth) => void) => () => void },
  supabase: IFakeSupabase,
): Promise<void> => {
  await whenWakeSettles(kizunasync)
  supabase.rpcCalls.length = 0
}

type TFakeChannel = { on: () => TFakeChannel; subscribe: () => TFakeChannel }

interface IFakeSupabase {
  client: SupabaseClient

  /**
   * Every schema() handle opened: createRpcRemote takes one, and
   * createSupabaseTransfer takes a second one IF it is built at all.
   */
  schemaCalls: string[]

  rpcCalls: string[]
  pushedBatches: TPushRequest['batch'][]
  channelNames: string[]
  authListeners: Array<(event: string, session: { access_token?: string } | null) => void>
  refreshCalls: number
  setSession: (token: string | null) => void

  /**
   * Makes `getSession()`/`refreshSession()` never settle, so a test can drive
   * `sessionTimeoutMs` without a fake auth-js hang implementation of its own.
   */
  hangGetSession: () => void

  hangRefreshSession: () => void

  /**
   * Settles every hung `getSession()`/`refreshSession()` call with the
   * current session value and clears both hung flags, so a test that armed
   * a permanent hang can let it resolve before disposing the client.
   */
  releaseHangs: () => void
}

/**
 * createRpcRemote arms a per-request deadline, so a fake .rpc() must answer the
 * same awaitable-and-chainable builder supabase-js returns.
 */
const answering = (result: { data: unknown; error: unknown }) => {
  const settled = Promise.resolve(result)

  return {
    abortSignal: () => settled,
    then: settled.then.bind(settled),
  }
}

/**
 * Minimal fake of the `SupabaseClient.realtime` surface the foreground path
 * probes before reconnecting; absence (the default across every other test)
 * must stay a no-op, so this is only ever injected explicitly.
 */
interface IFakeRealtime {
  getChannels: () => unknown[]
  isConnected: () => boolean
  connect: () => void
}

interface IMakeFakeSupabaseOptions {
  realtime?: IFakeRealtime

  /**
   * Overrides the built-in `auth` fake entirely; used by the method-binding
   * regression tests, which need a real CLASS instance (prototype methods
   * reading `this`) rather than this factory's closures.
   */
  auth?: unknown
}

/** The minimal supabase-js surface the three adapters touch while composing. */
const makeFakeSupabase = (options: IMakeFakeSupabaseOptions = {}): IFakeSupabase => {
  const schemaCalls: string[] = []
  const rpcCalls: string[] = []
  const pushedBatches: TPushRequest['batch'][] = []
  const channelNames: string[] = []
  const authListeners: Array<(event: string, session: { access_token?: string } | null) => void> = []
  let refreshCalls = 0
  let sessionToken: string | null = 'session-jwt-1'
  let getSessionHung = false
  let refreshSessionHung = false
  // Resolvers of every currently hung `getSession()`/`refreshSession()` promise, so `releaseHangs()` can settle them instead of leaving them permanently in flight past the end of the test.
  const hangResolvers: Array<(result: { data: { session: { access_token: string } | null } }) => void> = []
  const channel: TFakeChannel = {
    on: () => channel,
    subscribe: () => channel,
  }
  const defaultAuth = {
    getSession: async () => {
      if (getSessionHung) {
        return new Promise<{ data: { session: { access_token: string } | null } }>((resolve) => {
          hangResolvers.push(resolve)
        })
      }
      return { data: { session: sessionToken === null ? null : { access_token: sessionToken } } }
    },
    refreshSession: async () => {
      if (refreshSessionHung) {
        return new Promise<{ data: { session: { access_token: string } | null } }>((resolve) => {
          hangResolvers.push(resolve)
        })
      }
      refreshCalls += 1

      return { data: { session: sessionToken === null ? null : { access_token: sessionToken } } }
    },
    onAuthStateChange: (
      cb: (event: string, session: { access_token?: string } | null) => void,
    ) => {
      authListeners.push(cb)

      return { data: { subscription: { unsubscribe: () => undefined } } }
    },
  }
  const client = {
    supabaseUrl: 'https://abc.supabase.co',
    supabaseKey: 'pub-key',
    auth: options.auth ?? defaultAuth,
    schema: (name: string) => {
      schemaCalls.push(name)

      return {
        rpc: (fn: string, args: Record<string, unknown>) => {
          rpcCalls.push(fn)

          if (fn !== 'push') {
            return answering({ data: EMPTY_PULL, error: null })
          }
          // Applied for every mutation: the engine enforces the verdict bijection, so a blanket empty response would fail the push.
          const batch = args.batch as TPushRequest['batch']

          pushedBatches.push(batch)
          const verdicts = batch.mutations.map((mutation) => ({
            mutation_id: mutation.mutation_id,
            verdict: EVerdictKind.applied,
          }))

          return answering({ data: { verdicts }, error: null })
        },
      }
    },
    channel: (name: string) => {
      channelNames.push(name)

      return channel
    },
    removeChannel: () => undefined,
    realtime: options.realtime,
  } as unknown as SupabaseClient

  return {
    client,
    schemaCalls,
    rpcCalls,
    pushedBatches,
    channelNames,
    authListeners,
    get refreshCalls() {
      return refreshCalls
    },
    setSession: (token) => {
      sessionToken = token
      const session = token === null ? null : { access_token: token }

      for (const listener of authListeners) {
        listener(token === null ? 'SIGNED_OUT' : 'TOKEN_REFRESHED', session)
      }
    },
    hangGetSession: () => {
      getSessionHung = true
    },
    hangRefreshSession: () => {
      refreshSessionHung = true
    },
    releaseHangs: () => {
      getSessionHung = false
      refreshSessionHung = false
      const result = { data: { session: sessionToken === null ? null : { access_token: sessionToken } } }

      for (const resolve of hangResolvers) {
        resolve(result)
      }
      hangResolvers.length = 0
    },
  }
}

interface IRecordingUniffiHandle {
  handle: TUniffiHandle
  creates: string[]
  calls: Array<{ method: string; params: string }>
  isShutdown: () => boolean
}

/**
 * A linked UniFFI engine that records every call and answers the few reads the
 * app client makes. The blocking `call` is refused: the adapter reaches the
 * engine only through `callAsync`.
 */
const recordingUniffiHandle = (): IRecordingUniffiHandle => {
  const creates: string[] = []
  const calls: Array<{ method: string; params: string }> = []
  let shutdownCalled = false
  const handle: TUniffiHandle = {
    create(configJson) {
      creates.push(configJson)
    },
    call(method) {
      throw new Error(`the adapter called the blocking call(${method})`)
    },
    async callAsync(method, paramsJson) {
      calls.push({ method, params: paramsJson })

      if (method === 'checkpoint') {
        return JSON.stringify({ ok: true, value: { cursor: '0', soft_blocked: false } })
      }
      if (method === 'outbox_depth') {
        return JSON.stringify({ ok: true, value: 0 })
      }
      if (method === 'inspect') {
        return JSON.stringify({ ok: true, value: { queued: [], depth: 0, last_mutation_id: null, cursor: '0' } })
      }
      return JSON.stringify({ ok: true, value: null })
    },
    subscribe() {
      return 1n
    },
    unsubscribe() {
      // No engine event fires in these tests, so there is nothing to release.
    },
    shutdown() {
      shutdownCalled = true
    },
  }

  return { handle, creates, calls, isShutdown: () => shutdownCalled }
}

/** The token each `set_access_token` call handed the engine, in call order. */
const tokensHandedToEngine = (calls: IRecordingUniffiHandle['calls']): Array<string | null> =>
  calls
    .filter((entry) => entry.method === 'set_access_token')
    .map((entry) => (JSON.parse(entry.params) as { token: string | null }).token)

interface ILogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta: unknown
}

/** A caller sink for `logging.logger`: every namespace lands in one list. */
const recordingLogger = (): { logger: ILogger; entries: ILogEntry[] } => {
  const entries: ILogEntry[] = []
  const logger: ILogger = {
    debug: (message, meta) => {
      entries.push({ level: 'debug', message, meta })
    },
    info: (message, meta) => {
      entries.push({ level: 'info', message, meta })
    },
    warn: (message, meta) => {
      entries.push({ level: 'warn', message, meta })
    },
    error: (message, meta) => {
      entries.push({ level: 'error', message, meta })
    },
    child: () => logger,
  }

  return { logger, entries }
}

type TRefreshAnswer = {
  data: { session: { access_token: string } | null }
  error: { name: string; message: string; status?: number; code?: string } | null
}

/**
 * An auth whose token changes without telling any listener, so a test can tell
 * a token the session gate read apart from one the auth listener pushed.
 */
const scriptedAuth = (initialToken: string | null) => {
  const state = {
    token: initialToken,
    getSessionCalls: 0,
    refreshAnswer: { data: { session: null }, error: null } as TRefreshAnswer,
  }
  const auth = {
    getSession: async () => {
      state.getSessionCalls += 1

      return { data: { session: state.token === null ? null : { access_token: state.token } } }
    },
    refreshSession: async () => state.refreshAnswer,
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
  }

  return { state, auth }
}

/** Every microtask and pending callback queued so far, drained. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** How many microtask turns `waitUntil` yields before it gives up. */
const WAIT_UNTIL_TURNS = 1_000

/**
 * Yields one microtask at a time until `isDone` holds or the turn budget runs
 * out, so a test does not depend on how many awaits sit ahead of the call it
 * waits for. The caller's own assertion reports a budget that ran out.
 */
const waitUntil = async (isDone: () => boolean): Promise<void> => {
  for (let turn = 0; turn < WAIT_UNTIL_TURNS && !isDone(); turn += 1) {
    await Promise.resolve()
  }
}

// MARK: - Tests

describe('createSupabaseKizunaSync', () => {
  test('session JWT is pushed to setRemoteAccessToken and refreshed', async () => {
    const supabase = makeFakeSupabase()
    const tokens: Array<string | null> = []
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: CONFIG,
    })
    const original = kizunasync.setRemoteAccessToken

    kizunasync.setRemoteAccessToken = async (token) => {
      tokens.push(token)
      await original?.(token)
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(tokens).toContain('session-jwt-1')
    supabase.setSession('session-jwt-2')
    expect(tokens.at(-1)).toBe('session-jwt-2')
    supabase.setSession(null)
    expect(tokens.at(-1)).toBeNull()
    await dispose(kizunasync)
  })

  test('UniFFI create receives the Supabase HTTP remote and session JWT', async () => {
    const supabase = makeFakeSupabase()
    const { handle, creates, calls, isShutdown } = recordingUniffiHandle()
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: CONFIG,
      pollIntervalMs: 0,
      inspector: false,
      uniffiHandle: handle,
    })

    expect(kizunasync.engine).toBe('rust')
    expect(creates).toHaveLength(1)
    const created = JSON.parse(creates[0]!) as {
      remote: { url: string; publishable_key: string }
    }

    expect(created.remote.url).toBe('https://abc.supabase.co')
    expect(created.remote.publishable_key).toBe('pub-key')
    await waitUntil(() => calls.some((entry) => entry.method === 'set_access_token'))
    const tokenCall = calls.find((entry) => entry.method === 'set_access_token')

    expect(tokenCall).toBeDefined()
    expect((JSON.parse(tokenCall!.params) as { token: string }).token).toBe('session-jwt-1')
    supabase.setSession('session-jwt-2')
    // The forwarding path awaits the engine call chain, so the second token lands a few ticks later than the first; poll instead of counting ticks.
    const deadline = Date.now() + 1_000
    let lastToken = [...calls].reverse().find((entry) => entry.method === 'set_access_token')

    while (
      Date.now() < deadline &&
      (JSON.parse(lastToken!.params) as { token: string }).token !== 'session-jwt-2'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      lastToken = [...calls].reverse().find((entry) => entry.method === 'set_access_token')
    }
    expect((JSON.parse(lastToken!.params) as { token: string }).token).toBe('session-jwt-2')
    await dispose(kizunasync)
    expect(isShutdown()).toBe(true)
  })

  test('the remote is always the fenced kizunasync RPC remote', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG })

    await kizunasync.pullOnce()
    expect(supabase.rpcCalls).toEqual(['pull'])
    await dispose(kizunasync)
  })

  test('a fileStore with no transfer derives the Supabase transfer', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: ATTACHMENT_CONFIG,
      fileStore: FAKE_FILE_STORE,
    })

    // An attachment column with only one of the two ports throws in createKizunaSync, so composing at all proves the transfer was derived.
    expect(kizunasync.attachments).not.toBeNull()
    expect(supabase.schemaCalls).toHaveLength(2)
    await dispose(kizunasync)
  })

  test('an explicit transfer wins over the derived one', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: ATTACHMENT_CONFIG,
      fileStore: FAKE_FILE_STORE,
      transfer: FAKE_TRANSFER,
    })

    expect(kizunasync.attachments).not.toBeNull()
    // Only the remote opened a handle: no Supabase transfer was constructed.
    expect(supabase.schemaCalls).toHaveLength(1)
    await dispose(kizunasync)
  })

  test('realtimeWakeups derives a doorbell on the configured tables, joined when the engine opens', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: WAKEUP_CONFIG })

    expect(supabase.channelNames).toEqual([])
    openEngine(kizunasync)
    expect(supabase.channelNames).toEqual(['kizunasync:todos'])
    await dispose(kizunasync)
  })

  test('an explicit wakeup wins over the derived doorbell', async () => {
    const supabase = makeFakeSupabase()
    let subscribed = false
    const wakeup: IWakeup = {
      subscribe: () => {
        subscribed = true

        return () => undefined
      },
    }
    const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: WAKEUP_CONFIG, wakeup })

    openEngine(kizunasync)
    expect(subscribed).toBe(true)
    expect(supabase.channelNames).toEqual([])
    await dispose(kizunasync)
  })

  test('wakeupOptions reach the derived doorbell', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: WAKEUP_CONFIG,
      wakeupOptions: { topicPrefix: 'kizunasync-demo' },
    })

    openEngine(kizunasync)
    expect(supabase.channelNames).toEqual(['kizunasync-demo:todos'])
    await dispose(kizunasync)
  })

  test('an explicit wakeup replaces the doorbell, so wakeupOptions do nothing', async () => {
    const supabase = makeFakeSupabase()
    const wakeup: IWakeup = { subscribe: () => () => undefined }
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: WAKEUP_CONFIG,
      wakeup,
      wakeupOptions: { topicPrefix: 'kizunasync-demo' },
    })

    openEngine(kizunasync)
    expect(supabase.channelNames).toEqual([])
    await dispose(kizunasync)
  })

  test('no fileStore and no attachments composes with neither port', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG })

    await expect(kizunasync.attachments.getStatus('u1/p1/a.png')).rejects.toMatchObject({ code: EEngineErrorCode.ATTACHMENT_PORTS_MISSING })
    await dispose(kizunasync)
  })

  test('pull without a session never hits PostgREST', async () => {
    const supabase = makeFakeSupabase()

    supabase.setSession(null)
    const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG })

    try {
      await Promise.resolve()
      await Promise.resolve()
      let caughtError: (Error & { code?: string; retryable?: boolean }) | undefined

      try {
        await kizunasync.pullOnce()
      } catch (cause) {
        caughtError = cause as Error & { code?: string; retryable?: boolean }
      }
      expect(caughtError?.message).toMatch(/AUTH_SESSION_MISSING/)
      expect(caughtError?.code).toBe('AUTH_SESSION_MISSING')
      expect(supabase.rpcCalls).toEqual([])
    } finally {
      await dispose(kizunasync)
    }
  })

  test('a foreground signal refreshes the JWT then wakes the scheduler', async () => {
    const supabase = makeFakeSupabase()
    let onForeground: (() => void) | undefined
    let unsubCalls = 0
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: CONFIG,
      foreground: {
        subscribe: (cb) => {
          onForeground = cb

          return () => {
            unsubCalls += 1
          }
        },
      },
    })

    openEngine(kizunasync)
    expect(onForeground).toBeDefined()
    onForeground?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(supabase.refreshCalls).toBe(1)
    await dispose(kizunasync)
    expect(unsubCalls).toBe(1)
  })

  test('refreshOnForeground false still subscribes but does not rotate the token', async () => {
    const supabase = makeFakeSupabase()
    let onForeground: (() => void) | undefined
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: CONFIG,
      refreshOnForeground: false,
      foreground: {
        subscribe: (cb) => {
          onForeground = cb

          return () => undefined
        },
      },
    })

    openEngine(kizunasync)
    expect(onForeground).toBeDefined()
    onForeground?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(supabase.refreshCalls).toBe(0)
    await dispose(kizunasync)
  })

  test('remoteOptions reach the remote', async () => {
    const supabase = makeFakeSupabase()
    const kizunasync = compose({
      supabase: supabase.client,
      driver: makeDriver(),
      config: CONFIG,
      remoteOptions: { localOnlyColumns: ['local_image_uri'] },
    })

    try {
      await kizunasync.from('todos').insert({ id: 'todo-a', title: 'buy ink', local_image_uri: 'file:///tmp/a.jpg' })
      await kizunasync.pushOnce()
      expect(supabase.pushedBatches).toHaveLength(1)
      expect(Object.keys(supabase.pushedBatches[0]!.mutations[0]!.columns)).not.toContain('local_image_uri')
    } finally {
      await dispose(kizunasync)
    }
  })

  describe('session deadline', () => {
    test('a hung getSession fails pull retryably with AUTH_SESSION_TIMEOUT before the RPC is reached', async () => {
      const supabase = makeFakeSupabase()

      supabase.hangGetSession()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        sessionTimeoutMs: 25,
      })

      try {
        let caughtError: (Error & { code?: string; retryable?: boolean }) | undefined

        try {
          await kizunasync.pullOnce()
        } catch (cause) {
          caughtError = cause as Error & { code?: string; retryable?: boolean }
        }
        expect(caughtError?.message).toMatch(/AUTH_SESSION_TIMEOUT/)
        expect(caughtError?.code).toBe('AUTH_SESSION_TIMEOUT')
        expect(caughtError?.retryable).toBe(true)
        expect(supabase.rpcCalls).toEqual([])
      } finally {
        supabase.releaseHangs()
        await dispose(kizunasync)
      }
    })

    test('sessionTimeoutMs 0 disables the deadline and arms no session timer', async () => {
      const supabase = makeFakeSupabase()

      supabase.hangGetSession()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        sessionTimeoutMs: 0,
      })

      // The open arms the loop's start attempt on a real timer, so it runs before the spy, which then sees only what the session read arms.
      openEngine(kizunasync)
      const armed = spyOn(globalThis, 'setTimeout')
      // With the deadline disabled this pull stays in flight until releaseHangs() settles the fake getSession below, so the shared dispose() helper can safely follow it in the finally block.
      const pending = kizunasync.pullOnce()

      try {
        await Promise.resolve()
        await Promise.resolve()
        expect(armed).not.toHaveBeenCalled()
      } finally {
        armed.mockRestore()
        supabase.releaseHangs()
        await pending.catch(() => undefined)
        await dispose(kizunasync)
      }
    })

    test('a hung foreground refreshSession still forwards the wake, and the client keeps working', async () => {
      const supabase = makeFakeSupabase()

      supabase.hangRefreshSession()
      let onForeground: (() => void) | undefined
      let unsubCalls = 0
      const clock = createVirtualClock()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        sessionTimeoutMs: 25,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        foreground: {
          subscribe: (cb) => {
            onForeground = cb

            return () => {
              unsubCalls += 1
            }
          },
        },
      })

      const started = whenWakeSettles(kizunasync)

      // The loop's start attempt runs first, on the same virtual clock, so the pull asserted below is the forwarded wake's own.
      await clock.advance(500)
      await started
      supabase.rpcCalls.length = 0
      expect(onForeground).toBeDefined()
      const wakeSettled = whenWakeSettles(kizunasync)

      onForeground?.()
      // Two virtual timers run before the forwarded wake lands a pull: the 25ms session deadline, then the scheduler's WAKE_DEBOUNCE_MS (250ms, sync-scheduler.ts). advance() fires both in turn deterministically.
      await clock.advance(500)
      await wakeSettled
      expect(supabase.rpcCalls).toContain('pull')
      await kizunasync.pullOnce()
      supabase.releaseHangs()
      await dispose(kizunasync)
      expect(unsubCalls).toBe(1)
    })
  })

  describe('supabase-js method binding', () => {
    // supabase-js's GoTrueClient does NOT bind getSession/refreshSession (only its MFA/OAuth namespaces are bound): calling them detached from `auth` throws inside the real client. This fake reproduces the same shape (a prototype method reading `this`) without depending on the real package's internals, so an unbound call site fails here exactly as it would there.
    class ThisBoundAuth {
      private token = 'jwt-1'
      refreshCount = 0
      async getSession(): Promise<{ data: { session: { access_token: string } } }> {
        return { data: { session: { access_token: this.token } } }
      }
      async refreshSession(): Promise<{ data: { session: { access_token: string } } }> {
        this.refreshCount += 1
        this.token = `jwt-${this.refreshCount + 1}`

        return { data: { session: { access_token: this.token } } }
      }
      onAuthStateChange(): { data: { subscription: { unsubscribe: () => undefined } } } {
        return { data: { subscription: { unsubscribe: () => undefined } } }
      }
    }

    test('a pull resolves through a getSession that reads `this` (unbound would throw)', async () => {
      const supabase = makeFakeSupabase({ auth: new ThisBoundAuth() })
      const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG })

      try {
        await kizunasync.pullOnce()
        expect(supabase.rpcCalls).toContain('pull')
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a foreground signal refreshes through a refreshSession that reads `this`, and the wake still lands', async () => {
      const auth = new ThisBoundAuth()
      const supabase = makeFakeSupabase({ auth })
      let onForegroundCb: (() => void) | undefined
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        foreground: {
          subscribe: (cb) => {
            onForegroundCb = cb

            return () => undefined
          },
        },
      })

      try {
        await settleStart(kizunasync, supabase)
        expect(onForegroundCb).toBeDefined()
        const wakeSettled = whenWakeSettles(kizunasync)

        onForegroundCb?.()
        await Promise.resolve()
        await Promise.resolve()
        expect(auth.refreshCount).toBe(1)
        await wakeSettled
        expect(supabase.rpcCalls).toContain('pull')
      } finally {
        await dispose(kizunasync)
      }
    })
  })

  describe('createDocumentForeground', () => {
    class FakeEventTarget {
      private listeners: Record<string, Array<(event: unknown) => void>> = {}
      addEventListener(type: string, listener: (event: unknown) => void): void {
        ;(this.listeners[type] ??= []).push(listener)
      }
      removeEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener)
      }
      dispatch(type: string, event: unknown = {}): void {
        for (const listener of this.listeners[type] ?? []) {
          listener(event)
        }
      }
    }

    class FakeDocument extends FakeEventTarget {
      visibilityState = 'hidden'
      defaultView?: FakeEventTarget
    }

    test('visibilitychange wakes only when visibilityState is visible', () => {
      const target = new FakeDocument()
      const foreground = createDocumentForeground(target)
      let calls = 0
      const unsubscribe = foreground.subscribe(() => {
        calls += 1
      })

      target.visibilityState = 'hidden'
      target.dispatch('visibilitychange')
      expect(calls).toBe(0)
      target.visibilityState = 'visible'
      target.dispatch('visibilitychange')
      expect(calls).toBe(1)
      unsubscribe()
    })

    test('resume wakes unconditionally (Page Lifecycle API: fired when a frozen page unfreezes)', () => {
      const target = new FakeDocument()
      const foreground = createDocumentForeground(target)
      let calls = 0
      const unsubscribe = foreground.subscribe(() => {
        calls += 1
      })

      target.dispatch('resume')
      expect(calls).toBe(1)
      unsubscribe()
    })

    test('pageshow on defaultView wakes only when persisted is true, and the target itself is not also wired', () => {
      const target = new FakeDocument()
      const view = new FakeEventTarget()

      target.defaultView = view
      const foreground = createDocumentForeground(target)
      let calls = 0
      const unsubscribe = foreground.subscribe(() => {
        calls += 1
      })

      view.dispatch('pageshow', { persisted: false })
      expect(calls).toBe(0)
      view.dispatch('pageshow', { persisted: true })
      expect(calls).toBe(1)
      target.dispatch('pageshow', { persisted: true })
      expect(calls).toBe(1)
      unsubscribe()
    })

    test('pageshow falls back to the target itself when defaultView is absent', () => {
      const target = new FakeDocument()
      const foreground = createDocumentForeground(target)
      let calls = 0
      const unsubscribe = foreground.subscribe(() => {
        calls += 1
      })

      target.dispatch('pageshow', { persisted: true })
      expect(calls).toBe(1)
      unsubscribe()
    })

    test('unsubscribe removes all three listeners', () => {
      const target = new FakeDocument()
      const view = new FakeEventTarget()

      target.defaultView = view
      const foreground = createDocumentForeground(target)
      let calls = 0
      const unsubscribe = foreground.subscribe(() => {
        calls += 1
      })

      unsubscribe()
      target.visibilityState = 'visible'
      target.dispatch('visibilitychange')
      target.dispatch('resume')
      view.dispatch('pageshow', { persisted: true })
      expect(calls).toBe(0)
    })
  })

  describe('realtime reconnect on foreground', () => {
    const makeRealtime = (channels: unknown[], connected: boolean, connect: () => void): IFakeRealtime => ({
      getChannels: () => channels,
      isConnected: () => connected,
      connect,
    })

    const composeWithRealtime = (
      realtime: IFakeRealtime,
    ): { onForegroundCb?: () => void; kizunasync: ReturnType<typeof compose>; supabase: IFakeSupabase } => {
      let onForegroundCb: (() => void) | undefined
      const supabase = makeFakeSupabase({ realtime })
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        foreground: {
          subscribe: (cb) => {
            onForegroundCb = cb

            return () => undefined
          },
        },
      })

      openEngine(kizunasync)

      return { onForegroundCb, kizunasync, supabase }
    }

    // The refresh ahead of the reconnect check goes through withDeadline (Promise.resolve().then(run) plus its own internal .then hop), one more microtask turn than two bare `Promise.resolve()`s drain reliably. A macrotask boundary flushes it regardless of how many hops.
    const settleForegroundEffects = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    test('reconnects when channels exist and the socket is disconnected', async () => {
      let connectCalls = 0
      const { onForegroundCb, kizunasync } = composeWithRealtime(
        makeRealtime([{}], false, () => {
          connectCalls += 1
        }),
      )

      onForegroundCb?.()
      await settleForegroundEffects()
      expect(connectCalls).toBe(1)
      await dispose(kizunasync)
    })

    test('does not reconnect when already connected', async () => {
      let connectCalls = 0
      const { onForegroundCb, kizunasync } = composeWithRealtime(
        makeRealtime([{}], true, () => {
          connectCalls += 1
        }),
      )

      onForegroundCb?.()
      await settleForegroundEffects()
      expect(connectCalls).toBe(0)
      await dispose(kizunasync)
    })

    test('does not reconnect when there are no channels', async () => {
      let connectCalls = 0
      const { onForegroundCb, kizunasync } = composeWithRealtime(
        makeRealtime([], false, () => {
          connectCalls += 1
        }),
      )

      onForegroundCb?.()
      await settleForegroundEffects()
      expect(connectCalls).toBe(0)
      await dispose(kizunasync)
    })

    test('a connect that throws still lets the foreground wake reach the scheduler', async () => {
      const { onForegroundCb, kizunasync, supabase } = composeWithRealtime(
        makeRealtime([{}], false, () => {
          throw new Error('socket boom')
        }),
      )

      await settleStart(kizunasync, supabase)
      const wakeSettled = whenWakeSettles(kizunasync)

      onForegroundCb?.()
      // The throw must not suppress onForeground(): the wake still reaches the scheduler, and the loop settling its attempt is what proves it.
      await wakeSettled
      expect(supabase.rpcCalls).toContain('pull')
      await dispose(kizunasync)
    })
  })

  describe('foreground refresh outcome', () => {
    const composeWithRefresh = (refreshAnswer: TRefreshAnswer) => {
      const { state, auth } = scriptedAuth('jwt-1')
      const { logger, entries } = recordingLogger()
      const tokens: Array<string | null> = []
      let onForegroundCb: (() => void) | undefined

      state.refreshAnswer = refreshAnswer
      const kizunasync = compose({
        supabase: makeFakeSupabase({ auth }).client,
        driver: makeDriver(),
        config: CONFIG,
        logging: { logger },
        foreground: {
          subscribe: (cb) => {
            onForegroundCb = cb

            return () => undefined
          },
        },
      })
      const original = kizunasync.setRemoteAccessToken

      kizunasync.setRemoteAccessToken = async (token) => {
        tokens.push(token)
        await original?.(token)
      }
      openEngine(kizunasync)

      return { kizunasync, entries, tokens, foreground: () => onForegroundCb?.() }
    }

    test('a refresh that answers an error keeps the current token and logs the error name and status', async () => {
      const { kizunasync, entries, tokens, foreground } = composeWithRefresh({
        data: { session: null },
        error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
      })

      try {
        await settle()
        tokens.length = 0
        foreground()
        await settle()
        expect(tokens).toEqual([])
        expect(entries).toContainEqual({
          level: 'warn',
          message: 'session.refresh_failed',
          meta: { code: null, name: 'AuthRetryableFetchError', status: 0 },
        })
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a refresh that answers no session and no error keeps the current token', async () => {
      const { kizunasync, entries, tokens, foreground } = composeWithRefresh({ data: { session: null }, error: null })

      try {
        await settle()
        tokens.length = 0
        foreground()
        await settle()
        expect(tokens).toEqual([])
        expect(entries.map((entry) => entry.message)).toContain('session.refresh_failed')
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a refresh that answers a token hands it to the engine', async () => {
      const { kizunasync, tokens, foreground } = composeWithRefresh({
        data: { session: { access_token: 'jwt-2' } },
        error: null,
      })

      try {
        await settle()
        tokens.length = 0
        foreground()
        await settle()
        expect(tokens).toEqual(['jwt-2'])
      } finally {
        await dispose(kizunasync)
      }
    })
  })

  describe('session plumbing failures', () => {
    test('a getSession that rejects while seeding the token is logged', async () => {
      const { auth } = scriptedAuth('jwt-1')
      const { logger, entries } = recordingLogger()
      const storageError = Object.assign(new Error('storage unavailable'), { name: 'StorageError' })
      const kizunasync = compose({
        supabase: makeFakeSupabase({
          auth: {
            ...auth,
            getSession: () => Promise.reject(storageError),
          },
        }).client,
        driver: makeDriver(),
        config: CONFIG,
        logging: { logger },
      })

      try {
        await settle()
        expect(entries).toContainEqual({
          level: 'warn',
          message: 'session.read_failed',
          meta: { code: null, name: 'StorageError', status: null },
        })
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a setRemoteAccessToken that rejects is logged', async () => {
      const supabase = makeFakeSupabase()
      const { logger, entries } = recordingLogger()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        logging: { logger },
      })

      try {
        await settle()
        kizunasync.setRemoteAccessToken = () =>
          Promise.reject(Object.assign(new Error('engine stopped'), { code: 'ENGINE_UNAVAILABLE' }))
        supabase.setSession('session-jwt-2')
        await settle()
        expect(entries).toContainEqual({
          level: 'warn',
          message: 'session.apply_failed',
          meta: { code: 'ENGINE_UNAVAILABLE', name: 'Error', status: null },
        })
      } finally {
        await dispose(kizunasync)
      }
    })
  })

  describe('driver platform foreground', () => {
    // A foreground port the test counts subscriptions on and rings by hand.
    const recordingForeground = (): IForeground & { subscriptions: () => number; ring: () => void } => {
      const listeners = new Set<() => void>()
      let subscriptions = 0

      return {
        subscribe: (listener) => {
          subscriptions += 1
          listeners.add(listener)

          return () => {
            listeners.delete(listener)
          }
        },
        subscriptions: () => subscriptions,
        ring: () => {
          for (const listener of listeners) {
            listener()
          }
        },
      }
    }

    test('the driver foreground is used when no option names one, and the JWT refreshes before the wake', async () => {
      const supabase = makeFakeSupabase()
      const fromDriver = recordingForeground()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: { ...makeDriver(), platformPorts: { foreground: fromDriver } },
        config: CONFIG,
        foreground: undefined,
      })

      try {
        openEngine(kizunasync)
        expect(fromDriver.subscriptions()).toBe(1)

        fromDriver.ring()
        await settle()
        expect(supabase.refreshCalls).toBe(1)
      } finally {
        await dispose(kizunasync)
      }
    })

    test('an explicit foreground wins over the driver one', async () => {
      const supabase = makeFakeSupabase()
      const fromDriver = recordingForeground()
      const explicit = recordingForeground()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: { ...makeDriver(), platformPorts: { foreground: fromDriver } },
        config: CONFIG,
        foreground: explicit,
      })

      try {
        openEngine(kizunasync)
        expect(explicit.subscriptions()).toBe(1)
        expect(fromDriver.subscriptions()).toBe(0)
      } finally {
        await dispose(kizunasync)
      }
    })
  })

  describe('anonymous sign-in', () => {
    type TSignIn = { options?: { captchaToken?: string } } | undefined

    // An auth with no session until `signInAnonymously` mints one; while `failSignIn` holds, the mint answers the retryable fetch error auth-js returns when the network is down, and while `hangSignIn` holds it never settles until `releaseSignIn()`.
    const anonymousAuth = () => {
      const state = { token: null as string | null, signIns: [] as TSignIn[], failSignIn: false, hangSignIn: false }
      const hungSignIns: Array<() => void> = []
      const mint = () => {
        state.token = 'anon-jwt'

        return { data: { user: { id: 'anon-user' } }, error: null }
      }
      const auth = {
        getSession: async () => ({
          data: { session: state.token === null ? null : { access_token: state.token, user: { id: 'anon-user' } } },
        }),
        refreshSession: async () => ({ data: { session: null }, error: null }),
        signInAnonymously: async (credentials?: TSignIn) => {
          state.signIns.push(credentials)

          if (state.failSignIn) {
            return { data: { user: null }, error: { name: 'AuthRetryableFetchError', message: 'fetch failed', status: 0 } }
          }
          if (state.hangSignIn) {
            return new Promise<ReturnType<typeof mint>>((resolve) => {
              hungSignIns.push(() => resolve(mint()))
            })
          }
          return mint()
        },
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      }
      const releaseSignIn = (): void => {
        state.hangSignIn = false
        hungSignIns.splice(0).forEach((release) => release())
      }

      return { state, auth, releaseSignIn }
    }

    test('without the option a missing session is never recovered', async () => {
      const { state, auth } = anonymousAuth()
      const supabase = makeFakeSupabase({ auth })
      const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG })

      try {
        await expect(kizunasync.pullOnce()).rejects.toMatchObject({ code: 'AUTH_SESSION_MISSING' })
        expect(state.signIns).toEqual([])
        expect(supabase.rpcCalls).toEqual([])
      } finally {
        await dispose(kizunasync)
      }
    })

    test('the gate recovers a missing session and the pull runs under the new token', async () => {
      const { state, auth } = anonymousAuth()
      const supabase = makeFakeSupabase({ auth })
      const tokens: Array<string | null> = []
      const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG, anonymousSignIn: true })
      const original = kizunasync.setRemoteAccessToken

      kizunasync.setRemoteAccessToken = async (token) => {
        tokens.push(token)
        await original?.(token)
      }
      try {
        await kizunasync.pullOnce()
        expect(state.signIns).toEqual([undefined])
        expect(tokens).toContain('anon-jwt')
        expect(supabase.rpcCalls).toContain('pull')
      } finally {
        await dispose(kizunasync)
      }
    })

    test('on the UniFFI path the gate recovers too and hands the engine the new token before the network call', async () => {
      const { state, auth } = anonymousAuth()
      const uniffi = recordingUniffiHandle()
      const kizunasync = compose({
        supabase: makeFakeSupabase({ auth }).client,
        driver: makeDriver(),
        config: CONFIG,
        uniffiHandle: uniffi.handle,
        anonymousSignIn: true,
      })

      try {
        await kizunasync.pullOnce()
        const networkIndex = uniffi.calls.findIndex((entry) => entry.method === 'pull_once')

        expect(state.signIns).toHaveLength(1)
        expect(networkIndex).toBeGreaterThan(-1)
        expect(tokensHandedToEngine(uniffi.calls.slice(0, networkIndex)).at(-1)).toBe('anon-jwt')
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a captcha token reaches the anonymous sign-in', async () => {
      const { state, auth } = anonymousAuth()
      const supabase = makeFakeSupabase({ auth })
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        anonymousSignIn: { captchaToken: async () => 'captcha-1' },
      })

      try {
        await kizunasync.pullOnce()
        expect(state.signIns).toEqual([{ options: { captchaToken: 'captcha-1' } }])
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a recovery past sessionTimeoutMs fails the attempt with AUTH_SESSION_TIMEOUT, and the next attempt recovers', async () => {
      const { state, auth, releaseSignIn } = anonymousAuth()
      const supabase = makeFakeSupabase({ auth })
      const clock = createVirtualClock()
      const kizunasync = compose({
        supabase: supabase.client,
        driver: makeDriver(),
        config: CONFIG,
        anonymousSignIn: true,
        sessionTimeoutMs: 25,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      })

      try {
        state.hangSignIn = true
        const attempt = kizunasync.pullOnce().then(
          () => null,
          (failure: unknown) => failure as Error & { code?: string; retryable?: boolean },
        )

        // The session read settles first, so the recovery's own deadline is the timer the clock fires.
        await settle()
        await clock.advance(25)
        const error = await attempt

        expect(error?.code).toBe('AUTH_SESSION_TIMEOUT')
        expect(error?.retryable).toBe(true)
        expect(supabase.rpcCalls).toEqual([])

        releaseSignIn()
        await kizunasync.pullOnce()
        expect(state.signIns).toHaveLength(1)
        expect(supabase.rpcCalls).toContain('pull')
      } finally {
        await dispose(kizunasync)
      }
    })

    test('a failed recovery fails that attempt, and the next attempt recovers', async () => {
      const { state, auth } = anonymousAuth()
      const supabase = makeFakeSupabase({ auth })
      const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG, anonymousSignIn: true })

      try {
        state.failSignIn = true
        await expect(kizunasync.pullOnce()).rejects.toMatchObject({ name: 'AuthRetryableFetchError' })
        expect(supabase.rpcCalls).toEqual([])
        expect(kizunasync.getSyncHealth().consecutiveFailures).toBe(1)

        state.failSignIn = false
        await kizunasync.pullOnce()
        expect(state.signIns).toHaveLength(2)
        expect(supabase.rpcCalls).toContain('pull')
      } finally {
        await dispose(kizunasync)
      }
    })
  })

  describe('session token before the engine opens', () => {
    test('construction with a session seeds nothing into an engine and opens nothing; the first use hands the latest token first', async () => {
      const supabase = makeFakeSupabase()
      const uniffi = recordingUniffiHandle()
      const kizunasync = compose({ supabase: supabase.client, driver: makeDriver(), config: CONFIG, uniffiHandle: uniffi.handle })

      try {
        await settle()
        expect(uniffi.creates).toEqual([])
        expect(uniffi.calls).toEqual([])

        supabase.setSession('session-jwt-2')
        await settle()
        expect(uniffi.creates).toEqual([])

        await kizunasync.getOutboxDepth()
        expect(uniffi.creates).toHaveLength(1)
        expect(uniffi.calls[0]?.method).toBe('set_access_token')
        expect(tokensHandedToEngine(uniffi.calls)).toEqual(['session-jwt-2'])
      } finally {
        await dispose(kizunasync)
      }
    })
  })

  describe('session gate before the engine reaches the network', () => {
    const NETWORK_CALLS: Array<{ name: 'sync' | 'pullOnce' | 'pushOnce'; method: string }> = [
      { name: 'sync', method: 'sync' },
      { name: 'pullOnce', method: 'pull_once' },
      { name: 'pushOnce', method: 'push_once' },
    ]

    const composeOnUniffi = (initialToken: string | null) => {
      const { state, auth } = scriptedAuth(initialToken)
      const uniffi = recordingUniffiHandle()
      const kizunasync = compose({
        supabase: makeFakeSupabase({ auth }).client,
        driver: makeDriver(),
        config: CONFIG,
        uniffiHandle: uniffi.handle,
      })

      return { state, uniffi, kizunasync }
    }

    test.each(NETWORK_CALLS)('on the UniFFI path $name reads the session and hands the engine its token first', async ({ name, method }) => {
      const { state, uniffi, kizunasync } = composeOnUniffi('jwt-1')

      try {
        await settle()
        state.token = 'jwt-2'
        const readsBefore = state.getSessionCalls

        await kizunasync[name]()
        const networkIndex = uniffi.calls.findIndex((entry) => entry.method === method)

        expect(networkIndex).toBeGreaterThan(-1)
        expect(state.getSessionCalls).toBe(readsBefore + 1)
        expect(tokensHandedToEngine(uniffi.calls.slice(0, networkIndex)).at(-1)).toBe('jwt-2')
      } finally {
        await dispose(kizunasync)
      }
    })

    test.each(NETWORK_CALLS)('on the UniFFI path $name without a session fails before the engine call and counts a failed attempt', async ({ name, method }) => {
      const { uniffi, kizunasync } = composeOnUniffi(null)

      try {
        await settle()
        let caught: (Error & { code?: string }) | undefined

        try {
          await kizunasync[name]()
        } catch (cause) {
          caught = cause as Error & { code?: string }
        }
        expect(caught?.code).toBe('AUTH_SESSION_MISSING')
        expect(uniffi.calls.map((entry) => entry.method)).not.toContain(method)
        expect(kizunasync.getSyncHealth().consecutiveFailures).toBe(1)
        expect(kizunasync.getSyncHealth().lastError?.code).toBe('AUTH_SESSION_MISSING')
      } finally {
        await dispose(kizunasync)
      }
    })

    test('an explicit beforeNetwork takes the gate over', async () => {
      const { state, auth } = scriptedAuth('jwt-1')
      const uniffi = recordingUniffiHandle()
      let gateRuns = 0
      const kizunasync = compose({
        supabase: makeFakeSupabase({ auth }).client,
        driver: makeDriver(),
        config: CONFIG,
        uniffiHandle: uniffi.handle,
        beforeNetwork: async () => {
          gateRuns += 1
        },
      })

      try {
        await settle()
        const readsBefore = state.getSessionCalls

        await kizunasync.pullOnce()
        expect(gateRuns).toBe(1)
        expect(state.getSessionCalls).toBe(readsBefore)
      } finally {
        await dispose(kizunasync)
      }
    })
  })
})
