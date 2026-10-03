/**
 * The account-pill flow every example shares: performAccountSwitch (sign out,
 * sign in as the target, wipe local data, re-sync) and recoverSession (reuse
 * a persisted session at boot, no reset). Both report through one ports
 * object, so every caller wires the same shape instead of three divergent
 * ones. Auth is two ports rather than a `SupabaseClient`: `auth` for the
 * sign-out/sign-in calls this file drives directly, `recoverSession` for the
 * getSession/refreshSession/signInAnonymously cascade, which the caller binds
 * from `kizunasync/supabase`'s `recoverAnonymousSession`. That keeps this package
 * free of a Supabase dependency, per CONVENTIONS.md's "utilities may import
 * core only".
 */

import { EEngineErrorCode, TEngineError, type IKizunaSync } from 'kizunasync'
import { messageOf } from './errors'
import { DEMO_PASSWORD } from './demo-accounts'

// MARK: - Types

/**
 * One account the switcher can sign in as: anonymous when it carries no
 * email, password otherwise.
 */
export interface ISwitchTarget<TKey extends string> {
  key: TKey
  label: string
  email?: string
}

/** The recovered or newly signed-in identity, or null when there is none. */
export type TRecoveredSession = { id: string } | null

/** The `error` a supabase-js sign-in answers with: an AuthError's message, name and code. */
export interface IAuthFailure {
  message: string
  name?: string
  code?: string
}

/**
 * The narrow slice of a supabase-js auth client `performAccountSwitch`
 * drives: sign out locally, then sign in as the target (anonymously or with
 * a password). Typed structurally, not `SupabaseClient['auth']`, so this
 * package never imports `@supabase/supabase-js`.
 */
export interface IAccountSwitchAuth {
  signOut: (options: { scope: 'local' }) => Promise<unknown>
  signInAnonymously: () => Promise<{
    data: { user: { id: string } | null }
    error: IAuthFailure | null
  }>
  signInWithPassword: (credentials: { email: string; password: string }) => Promise<{
    data: { user: { id: string } | null }
    error: IAuthFailure | null
  }>
}

export interface IAccountSwitchPorts<TKey extends string> {
  auth: IAccountSwitchAuth

  /** Bound by the caller, normally `() => recoverAnonymousSession(supabase.auth)`. */
  recoverSession: () => Promise<TRecoveredSession>

  /**
   * `reset()` wipes local data and mints the new client identity the switch
   * registers under, before re-pulling the new user's visible set.
   * `getOutboxDepth()` is read when the switch runs, so queued writes are
   * never wiped without the caller's confirmation.
   */
  client: Pick<IKizunaSync, 'reset' | 'getOutboxDepth'>

  syncNow: () => Promise<void>

  /** The accounts the switcher offers, normally `createDemoAccounts(anonymousLabel)`. */
  accounts: readonly ISwitchTarget<TKey>[]

  /** Defaults to the seeded demo password (DEMO_PASSWORD) when absent. */
  password?: string

  /**
   * Maps a recovered or newly signed-in identity back to its account key, or
   * null for an unrecognized or anonymous one.
   */
  resolveAccountKey: (identity: TRecoveredSession) => TKey | null

  onMessage: (text: string) => void
  onUserId: (id: string | null) => void
  onFirstLoadPending: (pending: boolean) => void
  onAccount: (key: TKey | null) => void
}

export interface IAccountSwitchOptions {
  /** The user confirmed losing the queued writes (the switch guard's "switch anyway"), so the outbox is not read. */
  discardQueuedWrites?: boolean
}

// MARK: - internal

/** Shared by the Vite demo and todo examples; each product has its own prefixed keys. */
const ENV_HINT = 'Check the app Supabase URL and publishable key in the repo-root .env.'

// MARK: - performAccountSwitch

/**
 * Sign out, sign in as `key` (anonymously or with the demo password), wipe
 * the local database, then re-pull the rows the new identity may see. `key`
 * must name one of `ports.accounts`; an unknown key is refused with
 * LOCAL_UNSUPPORTED; it does not silently do nothing (@../../../CONVENTIONS.md).
 *
 * The outbox is read first, when the switch runs rather than when it was
 * requested: writes queued since the request, or still queued after a sync the
 * caller ran first, stop the switch with `outbox` before anything changes, and
 * only `discardQueuedWrites` lets the wipe drop them. Every other failure is
 * reported through `onMessage` and resolves `ok`.
 *
 * `reset()` also mints the new client identity the switch needs: the server
 * refuses a `client_id` registered to another user, so the pulls that follow
 * register a fresh one under the newly signed-in account.
 */
export async function performAccountSwitch<TKey extends string>(
  ports: IAccountSwitchPorts<TKey>,
  key: TKey,
  options: IAccountSwitchOptions = {},
): Promise<TAccountSwitchDecision> {
  const { auth, client, syncNow, accounts, password, onMessage, onUserId, onFirstLoadPending, onAccount } = ports

  try {
    const target = accounts.find((candidate) => candidate.key === key)

    if (target === undefined) {
      throw new TEngineError(EEngineErrorCode.LOCAL_UNSUPPORTED, `performAccountSwitch: unknown account key "${key}"`)
    }
    const depth = options.discardQueuedWrites === true ? 0 : await client.getOutboxDepth()

    if (depth > 0) {
      return { kind: EAccountSwitchDecisionKind.outbox, depth }
    }
    onMessage(`switching to ${target.label}…`)
    await auth.signOut({ scope: 'local' }).catch((cause: unknown) => {
      onMessage(`local sign-out failed, continuing: ${messageOf(cause)}`)
    })
    onUserId(await signInAs({ auth, target, password: password ?? DEMO_PASSWORD }))
    onFirstLoadPending(true)
    await client.reset()
    onAccount(key)
    await syncNow()
    onMessage(`${target.label} · synced ✓`)
  } catch (cause) {
    onMessage(messageOf(cause))
  } finally {
    onFirstLoadPending(false)
  }
  return { kind: EAccountSwitchDecisionKind.ok }
}

/**
 * Sign in as `target`: anonymously when it carries no email, with `password`
 * otherwise. Resolves the new user id; a refusal is thrown with its AuthError
 * code, so it still tells a rate limit from wrong credentials.
 */
export async function signInAs(request: {
  auth: IAccountSwitchAuth
  target: ISwitchTarget<string>
  password: string
}): Promise<string | null> {
  const { auth, target, password } = request
  const { data, error } =
    target.email === undefined
      ? await auth.signInAnonymously()
      : await auth.signInWithPassword({ email: target.email, password })

  if (error !== null) {
    throw toThrowable(error)
  }
  return data.user?.id ?? null
}

/** The AuthError itself when it is one, so its name and code survive; a plain answer becomes an Error with the same name and code. */
function toThrowable(error: IAuthFailure): Error {
  if (error instanceof Error) {
    return error
  }
  const failure = new Error(error.message)

  if (error.name !== undefined) {
    failure.name = error.name
  }
  return error.code === undefined ? failure : Object.assign(failure, { code: error.code })
}

// MARK: - recoverSession

/**
 * Boot-time recovery: reuse a persisted session instead of always minting a
 * fresh anonymous one, so a reload while signed in as a registered user stays
 * that user rather than orphaning their queued outbox under a new anon uid.
 * Tries getSession, then refreshSession, and only then signInAnonymously via
 * `ports.recoverSession` (the same resilience `recoverAnonymousSession` gives
 * every caller, bound to the caller's own supabase auth client). Never resets
 * local data: recovery resumes the existing identity and database.
 *
 * No liveness guard of its own; a caller whose component can unmount mid-flight
 * guards its own `onMessage`/`onUserId`/`onAccount` closures instead of passing
 * an extra port here.
 */
export async function recoverSession<TKey extends string>(ports: IAccountSwitchPorts<TKey>): Promise<void> {
  const { syncNow, resolveAccountKey, onMessage, onUserId, onAccount } = ports

  try {
    const recovered = await ports.recoverSession()

    onUserId(recovered?.id ?? null)
    onAccount(resolveAccountKey(recovered))
    await syncNow()
  } catch (cause) {
    onMessage(`sign-in failed: ${messageOf(cause)}. ${ENV_HINT}`)
  }
}

// MARK: - decideAccountSwitch

export const EAccountSwitchDecisionKind = {
  ok: 'ok',
  offline: 'offline',
  outbox: 'outbox',
} as const
export type TAccountSwitchDecisionKind = (typeof EAccountSwitchDecisionKind)[keyof typeof EAccountSwitchDecisionKind]

/**
 * `outbox` carries no `message`: the three views each render their own copy
 * for this case (React shows a static i18n string, Vue interpolates the
 * target's label and a pluralized count), so there is no single string to
 * share; `depth` is what they have in common.
 */
export type TAccountSwitchDecision =
  | { kind: typeof EAccountSwitchDecisionKind.offline; message: string }
  | { kind: typeof EAccountSwitchDecisionKind.outbox; depth: number }
  | { kind: typeof EAccountSwitchDecisionKind.ok }

const OFFLINE_SWITCH_MESSAGE =
  "Can't switch accounts while offline: switching wipes local data and needs a sync first. Go back online to switch."

/**
 * `reset()` wipes local data, so an unsynced outbox is lost on switch.
 * Offline is refused outright, before the outbox guard: switching needs a
 * sync first, which offline cannot do. A non-empty outbox raises a
 * confirmation instead of silently dropping queued writes; an online, empty
 * outbox switches directly.
 */
export function decideAccountSwitch(input: { isOnline: boolean; outboxDepth: number }): TAccountSwitchDecision {
  if (!input.isOnline) {
    return { kind: EAccountSwitchDecisionKind.offline, message: OFFLINE_SWITCH_MESSAGE }
  }
  if (input.outboxDepth > 0) {
    return { kind: EAccountSwitchDecisionKind.outbox, depth: input.outboxDepth }
  }
  return { kind: EAccountSwitchDecisionKind.ok }
}
