/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { decideAccountSwitch, performAccountSwitch, recoverSession, signInAs, type IAccountSwitchAuth, type IAccountSwitchPorts, type ISwitchTarget, type TRecoveredSession } from './account-switch'

type TKey = 'anon' | 'mary'

const ACCOUNTS: readonly ISwitchTarget<TKey>[] = [
  { key: 'anon', label: 'Guest' },
  { key: 'mary', label: 'Mary', email: 'mary@kizunasync.local' },
]

interface IAuthCalls {
  signOut: number
  signInAnonymously: number
  signInWithPassword: { email: string; password: string }[]
}

/**
 * The freshly-minted anonymous uid every signInAnonymously() call in these
 * fakes returns, distinct from the persisted-session uid so a test can tell
 * "recovered an existing identity" apart from "minted a new one".
 */
const ANON_UID = 'user-anon'
const PERSISTED_UID = 'user-1'

function fakeAuth(options: { signInError?: string }): { auth: IAccountSwitchAuth; calls: IAuthCalls } {
  const calls: IAuthCalls = { signOut: 0, signInAnonymously: 0, signInWithPassword: [] }
  const signInResult = (): { data: { user: { id: string } | null }; error: { message: string } | null } =>
    options.signInError === undefined
      ? { data: { user: { id: ANON_UID } }, error: null }
      : { data: { user: null }, error: { message: options.signInError } }
  const auth: IAccountSwitchAuth = {
    signOut: async () => {
      calls.signOut += 1

      return { error: null }
    },
    signInAnonymously: async () => {
      calls.signInAnonymously += 1

      return signInResult()
    },
    signInWithPassword: async (params) => {
      calls.signInWithPassword.push(params)

      return signInResult()
    },
  }

  return { auth, calls }
}

type TFakePorts = IAccountSwitchPorts<TKey> & {
  messages: string[]
  pending: boolean[]
  resets: number
  syncs: number
  depthReads: number

  /** What the next `getOutboxDepth()` answers; an Error makes it reject. */
  outboxDepth: number | Error
}

function fakePorts(
  auth: IAccountSwitchAuth,
  recoverSessionResult: () => Promise<TRecoveredSession> = async () => null,
): TFakePorts {
  const messages: string[] = []
  const pending: boolean[] = []
  const state = { resets: 0, syncs: 0, depthReads: 0, outboxDepth: 0 as number | Error }

  return {
    auth,
    recoverSession: recoverSessionResult,
    client: {
      reset: async () => {
        state.resets += 1
      },
      getOutboxDepth: async () => {
        state.depthReads += 1

        if (state.outboxDepth instanceof Error) {
          throw state.outboxDepth
        }
        return state.outboxDepth
      },
    },
    syncNow: async () => {
      state.syncs += 1
    },
    accounts: ACCOUNTS,
    resolveAccountKey: (identity) => (identity?.id === PERSISTED_UID ? 'mary' : null),
    onMessage: (text) => messages.push(text),
    onUserId: () => undefined,
    onFirstLoadPending: (value) => pending.push(value),
    onAccount: () => undefined,
    messages,
    pending,
    get resets() {
      return state.resets
    },
    get syncs() {
      return state.syncs
    },
    get depthReads() {
      return state.depthReads
    },
    get outboxDepth() {
      return state.outboxDepth
    },
    set outboxDepth(value) {
      state.outboxDepth = value
    },
  }
}

describe('performAccountSwitch', () => {
  test('an unknown key is refused loudly, not silently ignored', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth)

    await performAccountSwitch(ports, 'ghost' as TKey)

    expect(ports.messages).toEqual(['performAccountSwitch: unknown account key "ghost"'])
    expect(ports.resets).toBe(0)
  })

  test('an anonymous target signs in without a password', async () => {
    const { auth, calls } = fakeAuth({})
    const ports = fakePorts(auth)

    await performAccountSwitch(ports, 'anon')

    expect(calls.signOut).toBe(1)
    expect(calls.signInAnonymously).toBe(1)
    expect(calls.signInWithPassword).toEqual([])
    expect(ports.resets).toBe(1)
    expect(ports.syncs).toBe(1)
    expect(ports.messages).toEqual(['switching to Guest…', 'Guest · synced ✓'])
  })

  test('a password target signs in with the default demo password', async () => {
    const { auth, calls } = fakeAuth({})
    const ports = fakePorts(auth)

    await performAccountSwitch(ports, 'mary')

    expect(calls.signInWithPassword).toEqual([{ email: 'mary@kizunasync.local', password: 'kizunasync-demo' }])
  })

  test('an explicit password overrides the default', async () => {
    const { auth, calls } = fakeAuth({})
    const ports = { ...fakePorts(auth), password: 'custom-pw' }

    await performAccountSwitch(ports, 'mary')

    expect(calls.signInWithPassword).toEqual([{ email: 'mary@kizunasync.local', password: 'custom-pw' }])
  })

  test('a sign-in failure surfaces through onMessage, not a rejection', async () => {
    const { auth } = fakeAuth({ signInError: 'invalid credentials' })
    const ports = fakePorts(auth)

    await performAccountSwitch(ports, 'mary')

    expect(ports.messages).toEqual(['switching to Mary…', 'invalid credentials'])
    expect(ports.resets).toBe(0)
  })

  test('onFirstLoadPending brackets the whole switch, true then false', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth)

    await performAccountSwitch(ports, 'anon')

    expect(ports.pending).toEqual([true, false])
  })

  test('an empty outbox switches and reports ok', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth)

    await expect(performAccountSwitch(ports, 'mary')).resolves.toEqual({ kind: 'ok' })
    expect(ports.depthReads).toBe(1)
    expect(ports.resets).toBe(1)
  })

  test('queued writes stop the switch before it signs out, and the depth comes back', async () => {
    const { auth, calls } = fakeAuth({})
    const ports = fakePorts(auth)

    ports.outboxDepth = 2

    await expect(performAccountSwitch(ports, 'mary')).resolves.toEqual({ kind: 'outbox', depth: 2 })
    expect(calls.signOut).toBe(0)
    expect(calls.signInWithPassword).toEqual([])
    expect(ports.resets).toBe(0)
    expect(ports.syncs).toBe(0)
  })

  test('the outbox is read when the switch runs, so writes still queued after a sync stop it', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth)

    ports.syncNow = async () => {
      // A sync that could not push: the writes are still queued when it returns.
      ports.outboxDepth = 1
    }
    await ports.syncNow()

    await expect(performAccountSwitch(ports, 'mary')).resolves.toEqual({ kind: 'outbox', depth: 1 })
    expect(ports.resets).toBe(0)
  })

  test('a confirmed discard switches with queued writes and does not read the outbox', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth)

    ports.outboxDepth = 3

    await expect(performAccountSwitch(ports, 'mary', { discardQueuedWrites: true })).resolves.toEqual({ kind: 'ok' })
    expect(ports.depthReads).toBe(0)
    expect(ports.resets).toBe(1)
  })

  test('an outbox that cannot be read is reported and nothing switches', async () => {
    const { auth, calls } = fakeAuth({})
    const ports = fakePorts(auth)

    ports.outboxDepth = new Error('engine stopped')

    await performAccountSwitch(ports, 'mary')

    expect(ports.messages).toEqual(['engine stopped'])
    expect(calls.signOut).toBe(0)
    expect(ports.resets).toBe(0)
  })
})

describe('signInAs', () => {
  const MARY = ACCOUNTS[1]!

  test('a refused sign-in keeps the AuthError code', async () => {
    const auth: IAccountSwitchAuth = {
      ...fakeAuth({}).auth,
      signInWithPassword: async () => ({
        data: { user: null },
        error: { name: 'AuthApiError', message: 'Invalid login credentials', code: 'invalid_credentials' },
      }),
    }
    let caught: (Error & { code?: string }) | undefined

    try {
      await signInAs({ auth, target: MARY, password: 'wrong' })
    } catch (error) {
      caught = error as Error & { code?: string }
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toBe('Invalid login credentials')
    expect(caught?.code).toBe('invalid_credentials')
  })

  test('an AuthError instance is rethrown as it is', async () => {
    const authError = Object.assign(new Error('Request rate limit reached'), { code: 'over_request_rate_limit' })
    const auth: IAccountSwitchAuth = {
      ...fakeAuth({}).auth,
      signInAnonymously: async () => ({ data: { user: null }, error: authError }),
    }

    await expect(signInAs({ auth, target: ACCOUNTS[0]!, password: 'unused' })).rejects.toBe(authError)
  })

  test('a signed-in target answers its user id', async () => {
    await expect(signInAs({ auth: fakeAuth({}).auth, target: MARY, password: 'kizunasync-demo' })).resolves.toBe(ANON_UID)
  })
})

describe('recoverSession', () => {
  test('a persisted session resolves the account key and syncs', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth, async () => ({ id: PERSISTED_UID }))
    const resolvedKeys: (TKey | null)[] = []

    ports.onAccount = (key) => resolvedKeys.push(key)

    await recoverSession(ports)

    expect(resolvedKeys).toEqual(['mary'])
    expect(ports.syncs).toBe(1)
    expect(ports.messages).toEqual([])
  })

  test('no persisted session resolves to null', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth, async () => null)
    const resolvedKeys: (TKey | null)[] = []

    ports.onAccount = (key) => resolvedKeys.push(key)

    await recoverSession(ports)

    expect(resolvedKeys).toEqual([null])
  })

  test('a failure reports through onMessage with the env hint', async () => {
    const { auth } = fakeAuth({})
    const ports = fakePorts(auth, async () => {
      throw new Error('network down')
    })

    await recoverSession(ports)

    expect(ports.messages).toEqual([
      'sign-in failed: network down. Check the app Supabase URL and publishable key in the repo-root .env.',
    ])
  })
})

describe('decideAccountSwitch', () => {
  test('offline is refused before the outbox is checked', () => {
    expect(decideAccountSwitch({ isOnline: false, outboxDepth: 3 })).toEqual({
      kind: 'offline',
      message:
        "Can't switch accounts while offline: switching wipes local data and needs a sync first. Go back online to switch.",
    })
  })

  test('a non-empty outbox raises a confirmation', () => {
    expect(decideAccountSwitch({ isOnline: true, outboxDepth: 2 })).toEqual({ kind: 'outbox', depth: 2 })
  })

  test('online with an empty outbox switches directly', () => {
    expect(decideAccountSwitch({ isOnline: true, outboxDepth: 0 })).toEqual({ kind: 'ok' })
  })
})
