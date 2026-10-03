/**
 * Three registered password users (fixed uids) plus the anonymous default,
 * all from @kizunasync/utilities so the three examples share one catalog. Only the
 * anonymous label is local; each example owns its dictionary. The shared-board
 * policy in `0002_example.sql` shows every caller every row and lets any
 * visitor write a row an anonymous visitor owns; a registered user's rows stay
 * writable by that user alone. The non-owner-edit toggle lets the UI attempt a
 * registered user's row so RLS reconciliation is visible: the server denies it
 * and the client reverts. Switching accounts wipes the local database and
 * rehydrates the new identity's RLS-visible set. The public demo profile
 * (@./public-demo.ts) keeps only the anonymous account, because the hosted
 * project has no password account to sign in to.
 */

import { recoverAnonymousSession } from '@kizunasync/supabase'
import { getClient, setOwnerId, supabase, sync } from '../kizunasync-shim'
import { t } from '../i18n'
import { captchaTokenOption, IS_PUBLIC_DEMO } from './public-demo'
import { accountKeyForUserId as demoAccountKeyForUserId, createDemoAccounts, isTodoEditable, performAccountSwitch as performAccountSwitchShared, recoverSession as recoverSessionShared, REGISTERED_UID_NAMES, type IAccountSwitchOptions, type IAccountSwitchPorts, type IDemoAccount, type TAccountSwitchDecision, type TDemoAccountKey } from '@kizunasync/utilities'
import type { ITodo } from '../kizunasync-shim'

/**
 * The demo's identity surface: the seeded accounts, the row-ownership policy
 * derived from them, and the two flows that change who the device is. The
 * flows stay separate on purpose, a switch WIPES the local database and
 * re-pulls under the new identity, while recovery REUSES the persisted
 * session. Both are thin adapters over @kizunasync/utilities's shared
 * account-switch flow: this app supplies its own supabase client, owner-id
 * tracking, and account catalog as the shared ports object.
 */
// MARK: - Demo accounts

export type TAccountKey = TDemoAccountKey
export type IAccount = IDemoAccount

const DEMO_ACCOUNTS = createDemoAccounts(t('account.anonymous'))

export const ACCOUNTS: IAccount[] = IS_PUBLIC_DEMO ? DEMO_ACCOUNTS.filter((account) => account.email === undefined) : DEMO_ACCOUNTS

// MARK: - performAccountSwitch / recoverSession

/**
 * Where a flow reports progress. The screen owns the state these write to
 * (message line, current uid, selected pill, first-load gate); the shared
 * flow owns the ordering, because each step is only true once the previous
 * one resolved.
 */
interface IAccountFlowPorts {
  onMessage: (message: string) => void
  onIdentity: (userId: string | null) => void
  onAccount: (key: TAccountKey) => void
  onFirstLoadPending: (pending: boolean) => void
}

/**
 * Recovery also needs the screen's sync runner (its failures belong in
 * the SyncBar) and an unmount guard, since the flow outlives a fast unmount.
 * The shared recoverSession has no liveness guard and never touches
 * first-load state of its own, so the caller clears it once the flow settles
 * (mirroring how the other examples wire this).
 */
interface IRecoverSessionPorts {
  isActive: () => boolean
  runSync: () => Promise<void>
  onMessage: (message: string) => void
  onIdentity: (userId: string | null) => void
  onAccount: (key: TAccountKey) => void
}

/**
 * Builds the shared ports object every flow needs. `onUserId` always pins the
 * shim's module-scope owner id first, since sync() and forceServerConflict
 * read it, then forwards to the screen's own callback.
 */
function portsFor(
  syncNow: () => Promise<void>,
  callbacks: {
    onMessage: (message: string) => void
    onIdentity: (userId: string | null) => void
    onAccount: (key: TAccountKey) => void
    onFirstLoadPending?: (pending: boolean) => void
  },
): IAccountSwitchPorts<TAccountKey> {
  return {
    auth: supabase.auth,
    recoverSession: () => recoverAnonymousSession(supabase.auth, captchaTokenOption()),
    client: getClient(),
    syncNow,
    accounts: ACCOUNTS,
    resolveAccountKey: (identity) => accountKeyForUserId(identity?.id ?? null),
    onMessage: callbacks.onMessage,
    onUserId: (id) => {
      setOwnerId(id)
      callbacks.onIdentity(id)
    },
    onFirstLoadPending: callbacks.onFirstLoadPending ?? (() => undefined),
    onAccount: (key) => callbacks.onAccount(key ?? 'anon'),
  }
}

/** The account a switch targets, and whether the user already agreed to drop the queued writes. */
export interface ISwitchRequest extends IAccountSwitchOptions {
  key: TAccountKey
}

/**
 * Sign in as another demo account: sign out locally, sign in (anonymously or
 * with the demo password), pin the new owner, wipe the local database, then
 * re-pull the rows permitted to the new account. The caller gates this on
 * being online. The shared flow reads the outbox when the switch runs and
 * resolves `outbox` instead of wiping queued writes, unless the request
 * carries `discardQueuedWrites`.
 */
export async function performAccountSwitch(request: ISwitchRequest, ports: IAccountFlowPorts): Promise<TAccountSwitchDecision> {
  return performAccountSwitchShared(
    portsFor(() => sync(supabase), {
      onMessage: ports.onMessage,
      onIdentity: ports.onIdentity,
      onAccount: ports.onAccount,
      onFirstLoadPending: ports.onFirstLoadPending,
    }),
    request.key,
    { discardQueuedWrites: request.discardQueuedWrites },
  )
}

/**
 * Recover the persisted session (supabase restores it on startup), then first
 * sync. Reuses an existing session; it does not mint a fresh anonymous one.
 * A restart while signed in as Mary must stay Mary, or her queued outbox
 * would push under a new anon uid and be RLS-rejected. Failures land in the
 * SyncBar; a swallowed rejection here looks identical to "sync never runs".
 */
export async function recoverSession(ports: IRecoverSessionPorts): Promise<void> {
  await recoverSessionShared(
    portsFor(ports.runSync, {
      onMessage: (message) => {
        if (ports.isActive()) {
          ports.onMessage(message)
        }
      },
      onIdentity: (id) => {
        if (ports.isActive()) {
          ports.onIdentity(id)
        }
      },
      onAccount: (key) => {
        if (ports.isActive()) {
          ports.onAccount(key)
        }
      },
    }),
  )
}

// MARK: - Row ownership policy

/**
 * Map a recovered or signed-in user id back to its account pill key, so a
 * restart that reuses Mary's persisted session shows Mary selected, not anon. An
 * anonymous/unknown id has no registered uid match and falls back to 'anon'.
 */
function accountKeyForUserId(id: string | null): TAccountKey {
  return demoAccountKeyForUserId(id)
}

/**
 * The board is shared: any visitor's row is editable by any visitor. The
 * editAnyone test flag lifts the local guard on registered rows but does not
 * grant server access. Per-row and bulk actions share this predicate.
 */
export function isEditable(todo: ITodo, myId: string | null, editAnyone: boolean): boolean {
  return isTodoEditable(todo, { myId, editAnyone })
}

/**
 * The row's owner badge text (display-only, never gates editability). My rows
 * read "you"; a registered demo user's row reads that user's display name
 * (Mary / Samuel / David, derived from ACCOUNTS); an anonymous/unknown owner
 * reads "visitor".
 */
export function ownerBadgeLabel(todo: ITodo, mine: boolean): string {
  if (mine) {
    return t('item.you')
  }
  return REGISTERED_UID_NAMES[todo.user_id] ?? t('item.shared')
}
