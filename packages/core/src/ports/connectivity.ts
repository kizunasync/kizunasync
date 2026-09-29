/**
 * Device network state, distinct from the IWakeup port (which is a server-side
 * "something changed, pull now" hint). The engine uses connectivity to:
 *   - keep mutations queued (never push) while offline,
 *   - flush the outbox automatically on the offline → online transition,
 *   - surface `isOnline` to useSyncStatus.
 *
 * The core depends on NOTHING environment-specific (published invariant: pure TS,
 * isomorphic, fakeable). Adapters live in bindings: @kizunasync/web wraps
 * navigator.onLine + online/offline events; @kizunasync/expo wraps NetInfo /
 * expo-network; Node/SSR is a no-op (always online). An adapter MAY wrap an
 * agnostic helper (e.g. TanStack Query's onlineManager) but the core does not.
 */

// MARK: - Connectivity port

export interface IConnectivity {
  /** Best-known current state. Optimistic by default (true) when unknown. */
  isOnline(): boolean

  /**
   * Subscribe to transitions. Returns an unsubscribe function. The engine
   * treats a false→true transition as "try to flush the outbox now".
   */
  subscribe(onChange: (online: boolean) => void): () => void
}

/**
 * Default adapter for environments without connectivity signals (Node/SSR, or
 * a binding that opts out): always online, no transitions.
 */
export const alwaysOnline: IConnectivity = {
  isOnline: () => true,
  subscribe: () => () => {},
}
