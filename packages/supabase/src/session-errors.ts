// MARK: - Session errors

/** Both `createSupabaseKizunaSync` and `createSupabaseTransfer` throw these, so they share one owner here; otherwise the two modules import each other and form a cycle. */

/**
 * Stable code on the retryable error thrown when pull/push would otherwise
 * hit PostgREST as role `anon` (GRANT EXECUTE is `TO authenticated`).
 */
export const AUTH_SESSION_MISSING = 'AUTH_SESSION_MISSING'

export const sessionMissingError = (): Error => {
  const err = new Error(
    `${AUTH_SESSION_MISSING}: no authenticated session, refresh the JWT before pull/push`,
  )

  ;(err as { retryable?: boolean; code?: string }).retryable = true
  ;(err as { code?: string }).code = AUTH_SESSION_MISSING

  return err
}

/**
 * Stable code on the retryable error thrown when `auth.getSession()` (the
 * session gate before every pull/push) does not settle within the deadline:
 * auth-js issues that call with no fetch timeout of its own.
 */
export const AUTH_SESSION_TIMEOUT = 'AUTH_SESSION_TIMEOUT'

export const sessionTimeoutError = (timeoutMs: number): Error => {
  const err = new Error(`${AUTH_SESSION_TIMEOUT}: auth session did not settle within ${timeoutMs}ms`)

  ;(err as { retryable?: boolean; code?: string }).retryable = true
  ;(err as { code?: string }).code = AUTH_SESSION_TIMEOUT

  return err
}

/**
 * auth-js has no fetch timeout, so a half-open socket can hang the session
 * gate indefinitely; this value is deliberately below the RPC remote's own
 * 30s deadline (DEFAULT_REQUEST_TIMEOUT_MS, rpc-remote.ts) so one attempt
 * (session + RPC) stays inside the scheduler's 30s stall window in the common
 * case. auth-js deduplicates concurrent refreshes in-tab, so a slow-but-alive
 * refresh is picked up by the next attempt rather than restarted.
 */
export const DEFAULT_SESSION_TIMEOUT_MS = 10_000
