/**
 * Thin adapters over @kizunasync/utilities' shared account-switch flow: this app
 * supplies its own supabase client, shim, and account catalog as the shared
 * ports object, and gets the sign-out/sign-in/wipe/re-sync sequence (and the
 * boot-time recovery) back for free. All reactive UI state (status message,
 * my id, first-load flag, selected account) stays in the caller, threaded
 * through via the callback parameters below. Generic over TKey, unlike the
 * React example's concrete account key: this file has no catalog of its own
 * to bind to.
 */

import { recoverAnonymousSession } from '@kizunasync/supabase'
import type { IKizunaSyncShim } from '../kizunasync'
import { supabase } from '../supabase-client'
import { performAccountSwitch as performAccountSwitchShared, recoverSession as recoverSessionShared, type IAccountSwitchOptions, type IAccountSwitchPorts, type ISwitchTarget, type TAccountSwitchDecision } from '@kizunasync/utilities'

// MARK: - Account lifecycle

interface IPortsForParams<TKey extends string> {
  client: IKizunaSyncShim
  accounts: readonly ISwitchTarget<TKey>[]
  syncNow: () => Promise<void>
  password: string | undefined
  resolveAccountKey: (id: string | null) => TKey
  onMessage: (message: string) => void
  onUserId: (id: string | null) => void
  onFirstLoadPending: (pending: boolean) => void
  onAccount: (key: TKey) => void
}

function portsFor<TKey extends string>(params: IPortsForParams<TKey>): IAccountSwitchPorts<TKey> {
  const { client, accounts, syncNow, password, resolveAccountKey, onMessage, onUserId, onFirstLoadPending, onAccount } =
    params

  return {
    auth: supabase.auth,
    recoverSession: () => recoverAnonymousSession(supabase.auth),
    client,
    syncNow,
    accounts,
    password,
    resolveAccountKey: (identity) => resolveAccountKey(identity?.id ?? null),
    onMessage,
    onUserId,
    onFirstLoadPending,
    onAccount: (key) => onAccount(key ?? resolveAccountKey(null)),
  }
}

export interface IPerformAccountSwitchParams<TKey extends string> extends IAccountSwitchOptions {
  client: IKizunaSyncShim
  key: TKey
  accounts: readonly ISwitchTarget<TKey>[]
  password?: string
  syncNow: () => Promise<void>
  resolveAccountKey: (id: string | null) => TKey
  onMessage: (message: string) => void
  onUserId: (id: string | null) => void
  onAccount: (key: TKey) => void
  onFirstLoadPending: (pending: boolean) => void
}

/**
 * Sign out, sign back in as `key` (anonymous when its catalog entry carries no
 * email, password otherwise), wipe local data via `client.reset()`, then
 * re-sync. A `key` absent from `accounts` is refused loudly
 * (@../../../../CONVENTIONS.md) rather than silently doing nothing. Resolves
 * `outbox` when writes still queued at the switch stopped it before anything
 * changed.
 */
export async function performAccountSwitch<TKey extends string>(
  params: IPerformAccountSwitchParams<TKey>,
): Promise<TAccountSwitchDecision> {
  const { client, key, accounts, password, syncNow, resolveAccountKey, onMessage, onUserId, onAccount, onFirstLoadPending } =
    params

  return performAccountSwitchShared(
    portsFor({ client, accounts, syncNow, password, resolveAccountKey, onMessage, onUserId, onFirstLoadPending, onAccount }),
    key,
    { discardQueuedWrites: params.discardQueuedWrites },
  )
}

/** Everything performAccountSwitch takes, minus the target key, password and discard choice: recovery reuses the existing identity, never signs in as a chosen one. */
export type IRecoverSessionParams<TKey extends string> = Omit<IPerformAccountSwitchParams<TKey>, 'key' | 'password' | 'discardQueuedWrites'>

/**
 * Boot-time recovery: reuse a persisted session instead of always minting a
 * fresh anonymous one, so a reload while signed in as a registered user stays
 * that user rather than orphaning their queued outbox under a new anon uid.
 * Never resets local data: recovery resumes the existing identity and local
 * database. The shared implementation carries no first-load flag of its own,
 * so this adapter clears it once the flow settles either way.
 */
export async function recoverSession<TKey extends string>(params: IRecoverSessionParams<TKey>): Promise<void> {
  const { client, accounts, syncNow, resolveAccountKey, onMessage, onUserId, onAccount, onFirstLoadPending } = params

  try {
    await recoverSessionShared(
      portsFor({
        client,
        accounts,
        syncNow,
        password: undefined,
        resolveAccountKey,
        onMessage,
        onUserId,
        onFirstLoadPending,
        onAccount,
      }),
    )
  } finally {
    onFirstLoadPending(false)
  }
}
