// MARK: - Recover a persisted GoTrue session before minting anonymous

/**
 * The `error` supabase-js answers with: an AuthError, whose `name` is the
 * only mark of a retryable fetch failure (it carries no `code`).
 */
export interface IAuthFailure {
  message: string
  name?: string
  code?: string
  status?: number
}

/**
 * A reload (or a tab whose access token expired) must KEEP the same uid: minting
 * a fresh anonymous user would orphan the outbox, and the next push would be a
 * real 200 `RLS_DENIED` under the new identity. Try getSession, then
 * refreshSession (the persisted refresh token still restores an expired JWT),
 * and only then signInAnonymously.
 */
export interface IRecoverableAuth {
  getSession: () => Promise<{ data: { session: { user: { id: string } } | null } }>
  refreshSession: () => Promise<{
    data: { session: { user: { id: string } } | null }
    error: IAuthFailure | null
  }>
  signInAnonymously: (credentials?: { options?: { captchaToken?: string } }) => Promise<{
    data: { user: { id: string } | null }
    error: IAuthFailure | null
  }>
}

export interface IRecoverAnonymousSessionOptions {
  /** Called only when a new anonymous identity must be minted; a persisted or refreshable session never asks for a captcha. */
  captchaToken?: () => Promise<string>
}

/**
 * One recovery flight per auth client at a time: a second concurrent call for
 * the same `auth` (React StrictMode's double effect invocation, or two
 * components booting together) joins the flight already running instead of
 * racing it and minting a second anonymous identity.
 */
const inFlightRecoveries = new WeakMap<IRecoverableAuth, Promise<{ id: string } | null>>()

/**
 * Concurrent callers share one flight, so React StrictMode's double effect or
 * two components booting together cannot mint two identities. The captcha
 * option of whichever call starts the flight is the one used; a caller that
 * joins an in-flight recovery does not get its own `captchaToken` invoked.
 */
export async function recoverAnonymousSession(
  auth: IRecoverableAuth,
  options: IRecoverAnonymousSessionOptions = {},
): Promise<{ id: string } | null> {
  const existing = inFlightRecoveries.get(auth)

  if (existing !== undefined) {
    return existing
  }
  const flight = performRecovery(auth, options).finally(() => {
    inFlightRecoveries.delete(auth)
  })

  inFlightRecoveries.set(auth, flight)

  return flight
}

async function performRecovery(
  auth: IRecoverableAuth,
  options: IRecoverAnonymousSessionOptions,
): Promise<{ id: string } | null> {
  const { data: existing } = await auth.getSession()

  if (existing.session?.user != null) {
    return existing.session.user
  }
  const refreshed = await auth.refreshSession()

  if (refreshed.error === null && refreshed.data.session?.user != null) {
    return refreshed.data.session.user
  }
  // A network failure, a 5xx, or any refusal that does not say the session is gone keeps the identity: the next recovery can still restore it.
  if (refreshed.error !== null && !isSessionGone(refreshed.error)) {
    throw toThrowable(refreshed.error)
  }
  const minted =
    options.captchaToken !== undefined
      ? await auth.signInAnonymously({ options: { captchaToken: await options.captchaToken() } })
      : await auth.signInAnonymously()

  if (minted.error !== null) {
    throw toThrowable(minted.error)
  }
  return minted.data.user
}

/** The auth-js error codes that say the persisted refresh token or its session no longer exists. */
const SESSION_GONE_CODES: ReadonlySet<string> = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
])

function isSessionGone(error: IAuthFailure): boolean {
  return error.name === 'AuthSessionMissingError' || (error.code !== undefined && SESSION_GONE_CODES.has(error.code))
}

/** The AuthError itself when it is one, so its name, code and status survive; a plain answer becomes an Error with the same name and code. */
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
