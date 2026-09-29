import { describe, expect, test } from 'bun:test'
import { recoverAnonymousSession, type IRecoverableAuth } from './recover-anonymous-session'

const user = (id: string) => ({ id })

/** The shape supabase-js hands back in `error`: an AuthError's name, message, HTTP status and code. */
type TAuthFailure = { name: string; message: string; status?: number; code?: string }

/** What `refreshSession` answers once the persisted session is gone (auth-js `AuthSessionMissingError`). */
const SESSION_MISSING: TAuthFailure = { name: 'AuthSessionMissingError', message: 'Auth session missing!', status: 400 }

const authWith = (opts: {
  session: { id: string } | null
  refresh?: { id: string } | null
  refreshError?: TAuthFailure
  anon?: { id: string } | null
  anonError?: TAuthFailure
}): IRecoverableAuth & {
  refreshCalls: number
  anonCalls: number
  anonCredentials: { options?: { captchaToken?: string } } | undefined
} => {
  let refreshCalls = 0
  let anonCalls = 0
  let anonCredentials: { options?: { captchaToken?: string } } | undefined

  return {
    get refreshCalls() {
      return refreshCalls
    },
    get anonCalls() {
      return anonCalls
    },
    get anonCredentials() {
      return anonCredentials
    },
    getSession: async () => ({
      data: { session: opts.session === null ? null : { user: user(opts.session.id) } },
    }),
    refreshSession: async () => {
      refreshCalls += 1

      if (opts.refreshError !== undefined) {
        return { data: { session: null }, error: opts.refreshError }
      }
      const restored = opts.refresh ?? null

      return {
        data: { session: restored === null ? null : { user: user(restored.id) } },
        error: null,
      }
    },
    signInAnonymously: async (credentials) => {
      anonCalls += 1
      anonCredentials = credentials

      if (opts.anonError !== undefined) {
        return { data: { user: null }, error: opts.anonError }
      }
      return { data: { user: opts.anon === undefined ? user('anon-1') : opts.anon }, error: null }
    },
  }
}

/** The rejection a recovery ends with, for assertions on its name and code. */
const rejectionOf = async (flight: Promise<unknown>): Promise<Error & { code?: string }> => {
  try {
    await flight
  } catch (error) {
    expect(error).toBeInstanceOf(Error)

    return error as Error & { code?: string }
  }
  throw new Error('expected the recovery to reject')
}

describe('recoverAnonymousSession', () => {
  test('reuses a live getSession without refreshing or minting', async () => {
    const auth = authWith({ session: { id: 'mary' } })
    let providerCalls = 0
    const captchaToken = async () => {
      providerCalls += 1

      return 'unused-token'
    }
    await expect(recoverAnonymousSession(auth, { captchaToken })).resolves.toEqual({ id: 'mary' })
    expect(auth.refreshCalls).toBe(0)
    expect(auth.anonCalls).toBe(0)
    expect(providerCalls).toBe(0)
  })

  test('refreshSession restores an expired session before minting anon', async () => {
    const auth = authWith({ session: null, refresh: { id: 'mary' } })
    let providerCalls = 0
    const captchaToken = async () => {
      providerCalls += 1

      return 'unused-token'
    }
    await expect(recoverAnonymousSession(auth, { captchaToken })).resolves.toEqual({ id: 'mary' })
    expect(auth.refreshCalls).toBe(1)
    expect(auth.anonCalls).toBe(0)
    expect(providerCalls).toBe(0)
  })

  test('mints anonymous with no argument when no captcha provider is given', async () => {
    const auth = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anon: { id: 'anon-new' },
    })

    await expect(recoverAnonymousSession(auth)).resolves.toEqual({ id: 'anon-new' })
    expect(auth.refreshCalls).toBe(1)
    expect(auth.anonCalls).toBe(1)
    expect(auth.anonCredentials).toBeUndefined()
  })

  test('mints anonymous with the captcha token when a provider is given', async () => {
    const auth = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anon: { id: 'anon-new' },
    })
    let providerCalls = 0
    const captchaToken = async () => {
      providerCalls += 1

      return 'captcha-token-1'
    }
    await expect(recoverAnonymousSession(auth, { captchaToken })).resolves.toEqual({
      id: 'anon-new',
    })
    expect(providerCalls).toBe(1)
    expect(auth.anonCredentials).toEqual({ options: { captchaToken: 'captcha-token-1' } })
  })

  test('propagates a sign-in error when minting fails', async () => {
    const auth = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anonError: { name: 'AuthApiError', message: 'captcha verification process failed', status: 400, code: 'captcha_failed' },
    })

    await expect(recoverAnonymousSession(auth)).rejects.toThrow(
      'captcha verification process failed',
    )
  })

  test('two concurrent calls on the same auth share one flight and mint once', async () => {
    const auth = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anon: { id: 'anon-shared' },
    })
    const [first, second] = await Promise.all([
      recoverAnonymousSession(auth),
      recoverAnonymousSession(auth),
    ])

    expect(first).toEqual({ id: 'anon-shared' })
    expect(second).toEqual({ id: 'anon-shared' })
    expect(auth.anonCalls).toBe(1)
  })

  test('a later call after the flight settles runs a fresh recovery', async () => {
    const auth = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anon: { id: 'anon-first' },
    })

    await expect(recoverAnonymousSession(auth)).resolves.toEqual({ id: 'anon-first' })
    await expect(recoverAnonymousSession(auth)).resolves.toEqual({ id: 'anon-first' })
    expect(auth.anonCalls).toBe(2)
  })

  test('two different auth objects never share a flight', async () => {
    const authA = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anon: { id: 'anon-a' },
    })
    const authB = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anon: { id: 'anon-b' },
    })
    const [resultA, resultB] = await Promise.all([
      recoverAnonymousSession(authA),
      recoverAnonymousSession(authB),
    ])

    expect(resultA).toEqual({ id: 'anon-a' })
    expect(resultB).toEqual({ id: 'anon-b' })
    expect(authA.anonCalls).toBe(1)
    expect(authB.anonCalls).toBe(1)
  })

  test.each([
    { code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' },
    { code: 'refresh_token_already_used', message: 'Invalid Refresh Token: Already Used' },
    { code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' },
  ])('a refresh answering $code mints anonymous', async ({ code, message }) => {
    const auth = authWith({
      session: null,
      refreshError: { name: 'AuthApiError', message, status: 400, code },
      anon: { id: 'anon-new' },
    })

    await expect(recoverAnonymousSession(auth)).resolves.toEqual({ id: 'anon-new' })
    expect(auth.anonCalls).toBe(1)
  })

  test('a retryable fetch failure keeps the identity: no mint, the refresh error propagates', async () => {
    const auth = authWith({
      session: null,
      refreshError: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
    })
    const error = await rejectionOf(recoverAnonymousSession(auth))

    expect(error.name).toBe('AuthRetryableFetchError')
    expect(error.message).toBe('Failed to fetch')
    expect(auth.anonCalls).toBe(0)
  })

  test('a 5xx refresh keeps the identity and the AuthError code', async () => {
    const auth = authWith({
      session: null,
      refreshError: { name: 'AuthApiError', message: 'Unexpected failure', status: 503, code: 'unexpected_failure' },
    })
    const error = await rejectionOf(recoverAnonymousSession(auth))

    expect(error.code).toBe('unexpected_failure')
    expect(auth.anonCalls).toBe(0)
  })

  test('a refresh error that does not report the session gone never mints', async () => {
    const auth = authWith({
      session: null,
      refreshError: { name: 'AuthApiError', message: 'Refresh token revoked', status: 400, code: 'refresh_token_revoked' },
    })
    const error = await rejectionOf(recoverAnonymousSession(auth))

    expect(error.code).toBe('refresh_token_revoked')
    expect(auth.anonCalls).toBe(0)
  })

  test('a failed mint keeps the AuthError code', async () => {
    const auth = authWith({
      session: null,
      refreshError: SESSION_MISSING,
      anonError: { name: 'AuthApiError', message: 'Request rate limit reached', status: 429, code: 'over_request_rate_limit' },
    })
    const error = await rejectionOf(recoverAnonymousSession(auth))

    expect(error.code).toBe('over_request_rate_limit')
    expect(error.message).toBe('Request rate limit reached')
  })

  test('an AuthError instance is rethrown as it is', async () => {
    const authError = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 })
    const auth = authWith({ session: null })

    auth.refreshSession = async () => ({ data: { session: null }, error: authError })

    await expect(recoverAnonymousSession(auth)).rejects.toBe(authError)
    expect(auth.anonCalls).toBe(0)
  })
})
