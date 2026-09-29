import type { SupabaseClient } from '@supabase/supabase-js'
import { createKizunaSync, createLogger, withDeadline, type IForeground, type IKizunaSync, type IKizunaSyncOptions, type ILogger, type IProtocolRemote, type IStoreLocator, type ITransfer, type IWakeup, type TKizunaSyncConfig, type TPullRequest, type TPushRequest } from '@kizunasync/core'
import { createRpcRemote, type IRpcRemoteOptions } from './rpc-remote'
import { createRealtimeWakeup, type IRealtimeWakeupOptions } from './realtime-wakeup'
import { createSupabaseTransfer } from './transfer-supabase'
import { AUTH_SESSION_MISSING, AUTH_SESSION_TIMEOUT, DEFAULT_SESSION_TIMEOUT_MS, sessionMissingError, sessionTimeoutError } from './session-errors'
import { recoverAnonymousSession, type IRecoverAnonymousSessionOptions } from './recover-anonymous-session'

// MARK: - createSupabaseKizunaSync

/**
 * Everything a Supabase app would otherwise assemble by hand (the fenced
 * `kizunasync.pull` / `kizunasync.push` RPC remote, the Storage transfer adapter,
 * the Realtime doorbell) collapsed into one call. The remote is not negotiable
 * (it is the protocol). The two optional ports are derived from what the caller
 * already declared: a `fileStore` implies the Supabase transfer, `realtimeWakeups`
 * implies the doorbell on the config's tables. Pass either port explicitly to
 * take it over: a hand-rolled gated doorbell or a platform-specific transfer
 * always wins. The session gate (`beforeNetwork`) is derived from the client's
 * auth the same way, and an explicit one takes it over too. Every other option
 * reaches `createKizunaSync` untouched.
 */

/**
 * Normalizes a caught `unknown` down to its machine-readable `code`, never a
 * free-text message: the diagnostic below must not log the token/session.
 */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const code = (error as { code?: unknown }).code

  return typeof code === 'string' ? code : null
}

/**
 * The fields a session diagnostic logs: the code, plus the name and HTTP
 * status, because auth-js retryable errors (`AuthRetryableFetchError`) carry
 * no code. Never the message, which can quote the session.
 */
function describeAuthFailure(error: unknown): { code: string | null; name: string | null; status: number | null } {
  if (typeof error !== 'object' || error === null) {
    return { code: null, name: null, status: null }
  }
  const { name, status } = error as { name?: unknown; status?: unknown }

  return {
    code: errorCode(error),
    name: typeof name === 'string' ? name : null,
    status: typeof status === 'number' ? status : null,
  }
}

type TAuthSlice = {
  getSession?: () => Promise<{ data?: { session?: { access_token?: string } | null } }>
  refreshSession?: () => Promise<{ data?: { session?: { access_token?: string } | null }; error?: unknown }>
  onAuthStateChange?: (
    cb: (event: string, session: { access_token?: string } | null) => void,
  ) => { data?: { subscription?: { unsubscribe?: () => void } } }
}

/**
 * Realtime's own reconnect surface, probed AFTER the foreground JWT refresh.
 * Supabase's React Native guidance calls `realtime.connect()` when the app
 * becomes active, and in a browser a socket dropped while background timers
 * were throttled may not have reported `CLOSED` yet. `connect()` returns
 * early when already connected or connecting; safe to call on every
 * foreground signal. The doorbell adapter's own channel status callback
 * still handles a channel that then fails to rejoin; this only nudges the
 * socket, not a channel directly. Every access is typeof-guarded so a
 * client (or test fake) with no `realtime` stays a no-op.
 */
type TRealtimeSlice = {
  getChannels?: () => unknown[]
  isConnected?: () => boolean
  connect?: () => void
}

export interface ISupabaseKizunaSyncOptions extends Omit<IKizunaSyncOptions, 'transfer' | 'wakeup'> {
  supabase: SupabaseClient
  driver: IStoreLocator
  config: TKizunaSyncConfig
  transfer?: ITransfer
  wakeup?: IWakeup

  /**
   * Forwarded to createRpcRemote: the composition must not make any of the
   * composed adapters' options unreachable.
   */
  remoteOptions?: IRpcRemoteOptions

  /**
   * Forwarded to the DERIVED Realtime doorbell (topicPrefix, private); `tables`
   * always comes from the config. An explicit `wakeup` replaces the doorbell
   * outright, which leaves these options with nothing to configure.
   */
  wakeupOptions?: Omit<IRealtimeWakeupOptions, 'tables'>

  /**
   * App-became-visible source. When omitted, the driver's
   * `platformPorts.foreground` is used (the Expo driver's AppState port, so this
   * package never imports react-native), else `document.visibilitychange` on
   * the web. The JWT is refreshed before the engine's foreground wake, whichever
   * source rings.
   */
  foreground?: IForeground

  /**
   * When true (default), a foreground signal calls `refreshSession` before
   * waking the scheduler. A demo follower pane that must not rotate a shared
   * refresh token sets this false and still wakes so it picks up an adopted JWT.
   */
  refreshOnForeground?: boolean

  /**
   * Milliseconds `auth.getSession()` (before every pull/push) or the
   * foreground `refreshSession()` may take before the attempt fails retryably
   * with `AUTH_SESSION_TIMEOUT`. `0` disables the deadline. Defaults to
   * {@link DEFAULT_SESSION_TIMEOUT_MS}.
   */
  sessionTimeoutMs?: number

  /**
   * Signs in anonymously when the session gate finds no session: the gate calls
   * `recoverAnonymousSession`, which restores a persisted or refreshable
   * session before it mints a new anonymous user, and reads the session again.
   * `{ captchaToken }` supplies the token a captcha-protected project needs for
   * that sign-in. The recovery runs under `sessionTimeoutMs`, and a failed or
   * timed-out recovery fails that attempt like a failed session read, so the
   * next attempt tries again. Absent ⇒ the app signs in by itself and the gate
   * only reads.
   */
  anonymousSignIn?: boolean | { captchaToken: () => Promise<string> }
}

/**
 * The minimal `document`-shaped surface {@link createDocumentForeground} needs,
 * narrow enough that a plain test fake can implement it without pulling in
 * DOM lib types. `defaultView` is optional and window-like, needed only for
 * `pageshow` (real `document.defaultView` is the page's `window`).
 */
export interface IForegroundDocument {
  visibilityState: string
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void

  /**
   * `null` too: real `document.defaultView` is `null` whenever the document
   * is not attached to a window (e.g. a detached document).
   */
  defaultView?: {
    addEventListener(type: string, listener: (event: unknown) => void): void
    removeEventListener(type: string, listener: (event: unknown) => void): void
  } | null
}

/**
 * Web foreground source. `visibilitychange` alone misses two returns-to-life
 * the Page Lifecycle API defines (developer.chrome.com/docs/web-platform/
 * page-lifecycle-api): a `frozen` tab whose timers and fetch callbacks do not
 * run gets a `resume` event when the browser unfreezes it, and a page restored
 * from the back/forward cache (bfcache) gets `pageshow` with `event.persisted
 * === true` and never re-fires `visibilitychange`. `resume` is observed
 * on the document; `pageshow` is observed on `defaultView` (the real `window`)
 * when present, falling back to the target itself for a minimal test fake.
 */
export const createDocumentForeground = (target: IForegroundDocument): IForeground => ({
  subscribe: (onForeground) => {
    const onVisibility = (): void => {
      if (target.visibilityState === 'visible') {
        onForeground()
      }
    }
    const onResume = (): void => {
      onForeground()
    }
    const onPageShow = (event: unknown): void => {
      if ((event as { persisted?: unknown } | null)?.persisted === true) {
        onForeground()
      }
    }
    const view = target.defaultView ?? target

    target.addEventListener('visibilitychange', onVisibility)
    target.addEventListener('resume', onResume)
    view.addEventListener('pageshow', onPageShow)

    return () => {
      target.removeEventListener('visibilitychange', onVisibility)
      target.removeEventListener('resume', onResume)
      view.removeEventListener('pageshow', onPageShow)
    }
  },
})

const documentForeground = (): IForeground | undefined => {
  if (typeof document === 'undefined') {
    return undefined
  }
  return createDocumentForeground(document)
}

interface IGatedRemoteOptions {
  /**
   * Must be a closure over the live `auth` object (e.g. `() => auth.getSession()`),
   * never the bare unbound method (`auth.getSession`): supabase-js's
   * GoTrueClient does not bind `getSession`/`refreshSession` (only its
   * MFA/OAuth namespaces are bound), so calling the detached method throws a
   * `this`-is-undefined TypeError before any request is made.
   */
  getSession: () => ReturnType<NonNullable<TAuthSlice['getSession']>>

  applySession: (token: string | undefined) => void
  sessionTimeoutMs: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void

  /** Runs when the read finds no session, before one more read; absent ⇒ a missing session fails at once. */
  recoverSession?: () => Promise<void>
}

/** How the session gate reads the current session: everything the gated remote takes except the hand-over. */
type TSessionRead = Omit<IGatedRemoteOptions, 'applySession'>

/**
 * The session gate: the current access token, read under the session
 * deadline. A missing token fails retryably with `AUTH_SESSION_MISSING`, a
 * read past the deadline with `AUTH_SESSION_TIMEOUT`. With `recoverSession`, a
 * missing token first runs the recovery, under the same deadline, and one more
 * read; a recovery that throws fails the gate with that failure, as a read
 * that throws does.
 */
async function readSessionToken(read: TSessionRead): Promise<string> {
  const token = await readCurrentToken(read)

  if (token !== null) {
    return token
  }
  if (read.recoverSession === undefined) {
    throw sessionMissingError()
  }
  await withSessionDeadline(read, read.recoverSession)
  const recovered = await readCurrentToken(read)

  if (recovered === null) {
    throw sessionMissingError()
  }
  return recovered
}

/** The current access token under the session deadline, or null when the session holds none. */
async function readCurrentToken(read: TSessionRead): Promise<string | null> {
  const result = await withSessionDeadline(read, read.getSession)
  const token = result.data?.session?.access_token

  return typeof token === 'string' && token.length > 0 ? token : null
}

/** `run` raced against the session deadline, which fails it retryably with `AUTH_SESSION_TIMEOUT`. */
async function withSessionDeadline<T>(read: TSessionRead, run: () => Promise<T>): Promise<T> {
  const { sessionTimeoutMs, setTimer, clearTimer } = read

  return withDeadline(run, {
    timeoutMs: sessionTimeoutMs,
    onTimeout: () => sessionTimeoutError(sessionTimeoutMs),
    setTimer,
    clearTimer,
  })
}

const gatedRemote = (inner: IProtocolRemote, options: IGatedRemoteOptions): IProtocolRemote => {
  const ensureSession = async (): Promise<void> => {
    options.applySession(await readSessionToken(options))
  }
  return {
    pull: async (request: TPullRequest) => {
      await ensureSession()

      return inner.pull(request)
    },
    push: async (request: TPushRequest) => {
      await ensureSession()

      return inner.push(request)
    },
  }
}

export const createSupabaseKizunaSync = (options: ISupabaseKizunaSyncOptions): IKizunaSync => {
  const {
    supabase,
    driver,
    config,
    transfer,
    wakeup,
    remoteOptions,
    wakeupOptions,
    foreground,
    refreshOnForeground = true,
    sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    anonymousSignIn,
    ...rest
  } = options
  const ports = derivePorts({
    supabase,
    config,
    transfer,
    wakeup,
    wakeupOptions,
    fileStore: rest.fileStore,
    logging: rest.logging,
  })
  const nativeHttpRemote = readNativeHttpRemote(supabase)
  const auth = (supabase as SupabaseClient & { auth?: TAuthSlice }).auth
  const realtime = (supabase as SupabaseClient & { realtime?: TRealtimeSlice }).realtime
  let client: IKizunaSync | undefined
  const session: ISessionContext = {
    auth,
    logger: createLogger(rest.logging).child('session'),
    // Reads `client` at call time: it is assigned as soon as createKizunaSync returns, and every caller runs later, from an auth callback or an engine call.
    setAccessToken: async (token) => {
      await client?.setRemoteAccessToken(token)
    },
    sessionTimeoutMs,
    setTimer: rest.setTimer,
    clearTimer: rest.clearTimer,
    recoverSession: createSessionRecovery(supabase, anonymousSignIn),
  }
  const remote = createSessionRemote(session, createRpcRemote(supabase, remoteOptions))
  const resolvedForeground = createForegroundPort(session, {
    foreground: foreground ?? driver.platformPorts?.foreground,
    refreshOnForeground,
    realtime,
  })
  const kizunasync = createKizunaSync(driver, remote, config, {
    ...rest,
    transfer: ports.transfer,
    wakeup: ports.wakeup,
    foreground: resolvedForeground,
    nativeHttpRemote: rest.nativeHttpRemote ?? nativeHttpRemote,
    beforeNetwork: rest.beforeNetwork ?? createSessionGate(session),
  })

  client = kizunasync
  followAuthSession(kizunasync, session)

  return kizunasync
}

// MARK: - Derived ports

type TPortSources = Pick<ISupabaseKizunaSyncOptions, 'supabase' | 'config' | 'transfer' | 'wakeup' | 'wakeupOptions' | 'fileStore' | 'logging'>

/** The two optional ports: what the caller passed, else what its `fileStore` and `realtimeWakeups` imply. */
function derivePorts(sources: TPortSources): Pick<IKizunaSyncOptions, 'transfer' | 'wakeup'> {
  const { supabase, config, wakeupOptions } = sources
  // Namespaced off the caller's own sink so the transfer's bytes land in the same log as the engine's (createLogger returns a bring-your-own logger verbatim, and a silent default's child is silent too).
  const transfer =
    sources.transfer ??
    (sources.fileStore === undefined
      ? undefined
      : createSupabaseTransfer({
          client: supabase,
          fileStore: sources.fileStore,
          logger: createLogger(sources.logging).child('transfer'),
        }))
  const wakeup =
    sources.wakeup ??
    (config.realtimeWakeups
      ? createRealtimeWakeup(supabase, {
          tables: Object.keys(config.tables),
          logger: createLogger(sources.logging),
          ...wakeupOptions,
        })
      : undefined)

  return { transfer, wakeup }
}

function readNativeHttpRemote(supabase: SupabaseClient): IKizunaSyncOptions['nativeHttpRemote'] {
  const client = supabase as SupabaseClient & { supabaseUrl?: string; supabaseKey?: string }

  return typeof client.supabaseUrl === 'string' && typeof client.supabaseKey === 'string'
    ? {
        url: client.supabaseUrl,
        publishableKey: client.supabaseKey,
      }
    : undefined
}

// MARK: - Session

/** What the gated remote, the session gate, the foreground refresh, and the auth listener share. */
interface ISessionContext {
  auth: TAuthSlice | undefined
  logger: ILogger

  /** Hands the app client a token: awaited by the session gate, fire-and-forget through {@link applySession} everywhere else. */
  setAccessToken: (token: string | null) => Promise<void>

  sessionTimeoutMs: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void

  /** The anonymous sign-in the session gate runs on a missing session; absent without `anonymousSignIn`. */
  recoverSession?: () => Promise<void>
}

/** Hands over a token the auth client reported without waiting for it; a refused hand-over is logged, never left unhandled. */
function applySession(session: ISessionContext, token: string | undefined): void {
  void session.setAccessToken(token ?? null).catch((cause: unknown) => {
    session.logger.warn('session.apply_failed', describeAuthFailure(cause))
  })
}

/** The session read the gate runs, or null for an auth client without `getSession` (no gate at all). */
function sessionReadOf(session: ISessionContext): TSessionRead | null {
  const { auth } = session

  if (auth?.getSession === undefined) {
    return null
  }
  return {
    // A closure, never the bare `auth.getSession`; see IGatedRemoteOptions.getSession.
    getSession: () => auth.getSession!(),
    sessionTimeoutMs: session.sessionTimeoutMs,
    setTimer: session.setTimer,
    clearTimer: session.clearTimer,
    recoverSession: session.recoverSession,
  }
}

/** The recovery `anonymousSignIn` asks for, or undefined when the app signs in by itself. */
function createSessionRecovery(
  supabase: SupabaseClient,
  anonymousSignIn: ISupabaseKizunaSyncOptions['anonymousSignIn'],
): (() => Promise<void>) | undefined {
  if (anonymousSignIn === undefined || anonymousSignIn === false) {
    return undefined
  }
  const recoveryOptions: IRecoverAnonymousSessionOptions =
    anonymousSignIn === true ? {} : { captchaToken: anonymousSignIn.captchaToken }

  return async () => {
    await recoverAnonymousSession(supabase.auth, recoveryOptions)
  }
}

function createSessionRemote(session: ISessionContext, inner: IProtocolRemote): IProtocolRemote {
  const read = sessionReadOf(session)

  return read === null ? inner : gatedRemote(inner, { ...read, applySession: (token) => applySession(session, token) })
}

/**
 * `beforeNetwork` for the engine: the gated remote's session read, then the
 * token handed to the engine and awaited. A transport that lives inside the
 * engine (UniFFI) never calls the gated remote, so this is its only gate.
 */
function createSessionGate(session: ISessionContext): (() => Promise<void>) | undefined {
  const read = sessionReadOf(session)

  if (read === null) {
    return undefined
  }
  return async () => {
    await session.setAccessToken(await readSessionToken(read))
  }
}

/**
 * Seeds the app client with the current session, follows every later auth
 * change, and chains the listener's unsubscribe in front of `dispose`.
 */
function followAuthSession(kizunasync: IKizunaSync, session: ISessionContext): void {
  const { auth } = session

  if (auth?.getSession !== undefined) {
    void auth
      .getSession()
      .then((result) => {
        applySession(session, result.data?.session?.access_token)
      })
      .catch((cause: unknown) => {
        session.logger.warn('session.read_failed', describeAuthFailure(cause))
      })
  }
  const previous = kizunasync.dispose
  const disposers: Array<() => void> = []

  if (auth?.onAuthStateChange !== undefined) {
    const { data } = auth.onAuthStateChange((_event, authSession) => {
      applySession(session, authSession?.access_token)
    })

    if (data?.subscription?.unsubscribe !== undefined) {
      disposers.push(() => data.subscription?.unsubscribe?.())
    }
  }
  kizunasync.dispose = () => {
    while (disposers.length > 0) {
      disposers.pop()?.()
    }
    previous?.()
  }
}

// MARK: - Foreground

type TForegroundSources = {
  foreground: IForeground | undefined
  refreshOnForeground: boolean
  realtime: TRealtimeSlice | undefined
}

function createForegroundPort(session: ISessionContext, sources: TForegroundSources): IForeground | undefined {
  const hostForeground = sources.foreground ?? documentForeground()

  if (hostForeground === undefined) {
    return undefined
  }
  return {
    subscribe: (onForeground) =>
      hostForeground.subscribe(() => {
        void handleForeground(session, { ...sources, onForeground })
      }),
  }
}

type TForegroundSignal = TForegroundSources & {
  onForeground: () => void
}

/** Refreshes the JWT before the Realtime nudge and the engine wake, the order `foreground` and {@link TRealtimeSlice} document. */
async function handleForeground(session: ISessionContext, signal: TForegroundSignal): Promise<void> {
  const { auth } = session

  if (signal.refreshOnForeground && auth?.refreshSession !== undefined) {
    await refreshSessionToken(session, auth)
  }
  reconnectRealtimeIfNeeded(signal.realtime, session.logger)
  signal.onForeground()
}

/**
 * Hands the engine the refreshed token only when the refresh answered one and
 * no error. Any other answer keeps the token the engine holds, which the next
 * session gate replaces, and is logged; the wake still follows, because
 * `AUTH_SESSION_MISSING`, a 401 and `AUTH_SESSION_TIMEOUT` all stay retryable.
 */
async function refreshSessionToken(session: ISessionContext, auth: TAuthSlice): Promise<void> {
  try {
    // A closure, never the bare `auth.refreshSession` (same reason as getSession above).
    const result = await withDeadline(() => auth.refreshSession!(), {
      timeoutMs: session.sessionTimeoutMs,
      onTimeout: () => sessionTimeoutError(session.sessionTimeoutMs),
      setTimer: session.setTimer,
      clearTimer: session.clearTimer,
    })
    const token = result.data?.session?.access_token

    if ((result.error ?? null) === null && typeof token === 'string' && token.length > 0) {
      applySession(session, token)

      return
    }
    session.logger.warn('session.refresh_failed', describeAuthFailure(result.error))
  } catch (cause) {
    session.logger.warn('session.refresh_failed', describeAuthFailure(cause))
  }
}

/** Best-effort socket nudge; never allowed to break the foreground wake. */
function reconnectRealtimeIfNeeded(realtime: TRealtimeSlice | undefined, logger: ILogger): void {
  if (
    typeof realtime?.getChannels !== 'function' ||
    typeof realtime.isConnected !== 'function' ||
    typeof realtime.connect !== 'function'
  ) {
    return
  }
  try {
    if (realtime.getChannels().length > 0 && !realtime.isConnected()) {
      realtime.connect()
    }
  } catch (cause) {
    logger.warn('realtime.reconnect_failed', { code: errorCode(cause) })
  }
}
