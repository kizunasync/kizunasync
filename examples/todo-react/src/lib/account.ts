/**
 * Catalog, registered uids, and uid → display name map come from
 * @kizunasync/utilities (shared by every example). Only the anonymous label is
 * local: each example owns its dictionary. `0002_example.sql` shows every
 * identity every row and lets any visitor write a row an anonymous visitor
 * owns; a registered user's rows stay writable by that user alone. The
 * non-owner-edit toggle writes a registered user's row so RLS rejection and
 * client revert show up. Switching accounts wipes the local database and
 * rehydrates that identity's visible set.
 *
 * Thin adapters over @kizunasync/utilities' shared account-switch flow: this app
 * supplies its own supabase client, shim, and account catalog as the shared
 * ports object, and gets the sign-out/sign-in/wipe/re-sync sequence (and the
 * boot-time recovery) back for free.
 */

import { recoverAnonymousSession } from '@kizunasync/supabase'
import type { IKizunaSyncShim } from '../kizunasync'
import { supabase } from '../supabase-client'
import { t } from '../i18n'
import { accountKeyForUserId, createDemoAccounts, performAccountSwitch as performAccountSwitchShared, recoverSession as recoverSessionShared, type IAccountSwitchOptions, type IAccountSwitchPorts, type IDemoAccount, type TAccountSwitchDecision, type TDemoAccountKey } from '@kizunasync/utilities'

// MARK: - Demo accounts

export type TAccountKey = TDemoAccountKey
export type IAccount = IDemoAccount

export const ACCOUNTS: IAccount[] = createDemoAccounts(t('account.anonymous'))

// MARK: - performAccountSwitch / recoverSession

function portsFor(
  client: IKizunaSyncShim,
  syncNow: () => Promise<void>,
  callbacks: {
    onMessage: (message: string) => void
    onUserId: (id: string | null) => void
    onFirstLoadPending: (pending: boolean) => void
    onAccount: (key: TAccountKey) => void
  },
): IAccountSwitchPorts<TAccountKey> {
  return {
    auth: supabase.auth,
    recoverSession: () => recoverAnonymousSession(supabase.auth),
    client,
    syncNow,
    accounts: ACCOUNTS,
    resolveAccountKey: (identity) => accountKeyForUserId(identity?.id ?? null),
    onMessage: callbacks.onMessage,
    onUserId: callbacks.onUserId,
    onFirstLoadPending: callbacks.onFirstLoadPending,
    onAccount: (key) => callbacks.onAccount(key ?? 'anon'),
  }
}

export interface IPerformAccountSwitchParams extends IAccountSwitchOptions {
  key: TAccountKey
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  onMessage: (message: string) => void
  onUserId: (id: string | null) => void
  onFirstLoadPending: (pending: boolean) => void
  onAccount: (key: TAccountKey) => void
}

/** Resolves `outbox` when writes still queued at the switch stopped it before anything changed. */
export async function performAccountSwitch(params: IPerformAccountSwitchParams): Promise<TAccountSwitchDecision> {
  const { key, client, syncNow, discardQueuedWrites, onMessage, onUserId, onFirstLoadPending, onAccount } = params

  return performAccountSwitchShared(portsFor(client, syncNow, { onMessage, onUserId, onFirstLoadPending, onAccount }), key, {
    discardQueuedWrites,
  })
}

export interface IRecoverSessionParams {
  client: IKizunaSyncShim
  syncNow: () => Promise<void>
  isLive: () => boolean
  onMessage: (message: string) => void
  onUserId: (id: string | null) => void
  onAccount: (key: TAccountKey) => void
}

export async function recoverSession(params: IRecoverSessionParams): Promise<void> {
  const { client, syncNow, isLive, onMessage, onUserId, onAccount } = params

  await recoverSessionShared(
    portsFor(client, syncNow, {
      onMessage: (text) => {
        if (isLive()) {
          onMessage(text)
        }
      },
      onUserId: (id) => {
        if (isLive()) {
          onUserId(id)
        }
      },
      onFirstLoadPending: () => undefined,
      onAccount: (key) => {
        if (isLive()) {
          onAccount(key)
        }
      },
    }),
  )
}
