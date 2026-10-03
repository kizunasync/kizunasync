/**
 * The demo identity catalog the example apps share: three registered password
 * users seeded by migration 0002 with fixed uids, plus the anonymous default.
 *
 * The shared-board policy in `0002_example.sql` shows every visitor every row
 * and lets any visitor write a row an anonymous visitor owns. A registered
 * user's rows stay writable by that user alone, so the "test non-owner edit"
 * control can drive a real RLS rejection and show the client reverting.
 */

// MARK: - Accounts

export type TDemoAccountKey = 'anon' | 'mary' | 'samuel' | 'david'

export interface IDemoAccount {
  key: TDemoAccountKey
  label: string

  /** Absent on the anonymous entry, which signs in with `signInAnonymously`. */
  email?: string

  /** The fixed uid migration 0002 seeds; absent on the anonymous entry. */
  uid?: string
}

/** The demo password every seeded account shares (migration 0002). */
export const DEMO_PASSWORD = 'kizunasync-demo'

/**
 * The registered entries, in pill order. Their labels are proper names, so they
 * are not translated; only the anonymous entry's label is.
 */
const REGISTERED_ACCOUNTS: readonly (IDemoAccount & { email: string; uid: string })[] = [
  { key: 'mary', label: 'Mary', email: 'mary@kizunasync.local', uid: '11111111-1111-4111-8111-111111111111' },
  { key: 'samuel', label: 'Samuel', email: 'samuel@kizunasync.local', uid: '22222222-2222-4222-8222-222222222222' },
  { key: 'david', label: 'David', email: 'david@kizunasync.local', uid: '33333333-3333-4333-8333-333333333333' },
]

/**
 * The account pills, anonymous first. The anonymous label is the caller's own
 * translation, because each example owns its dictionary.
 */
export function createDemoAccounts(anonymousLabel: string): IDemoAccount[] {
  return [{ key: 'anon', label: anonymousLabel }, ...REGISTERED_ACCOUNTS.map((account) => ({ ...account }))]
}

// MARK: - Row ownership

/** The uids whose rows every visitor reads but only their owner writes. */
export const REGISTERED_UIDS: ReadonlySet<string> = new Set(REGISTERED_ACCOUNTS.map((account) => account.uid))

/**
 * uid → display name, so a registered user's row carries their name instead of
 * the "visitor" badge. Derived from the catalog, never hand-listed.
 */
export const REGISTERED_UID_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  REGISTERED_ACCOUNTS.map((account) => [account.uid, account.label]),
)

/**
 * Map a recovered or newly signed-in user id back to its account key, so a
 * reload that reuses Mary's persisted session shows Mary selected rather than
 * anon. An anonymous or unknown id matches no registered uid and falls back to
 * 'anon'.
 */
export function accountKeyForUserId(id: string | null): TDemoAccountKey {
  if (id === null) {
    return 'anon'
  }
  return REGISTERED_ACCOUNTS.find((account) => account.uid === id)?.key ?? 'anon'
}
