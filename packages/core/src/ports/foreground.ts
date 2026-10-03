// MARK: - Foreground port

/**
 * Distinct from IConnectivity (network) and IWakeup (server hint). A tab or
 * native app returning to the foreground is the recovery path Chrome and iOS
 * throttle away from timers: GoTrue JWTs expire in ~1h while a backgrounded
 * poll may not run. The engine treats a signal as "attempt a sync now"; the
 * adapter that owns the session (createSupabaseKizunaSync, a native host) refreshes
 * the JWT BEFORE forwarding the signal so the attempt does not ride a dead
 * Bearer. Absent ⇒ poll + reconnect only.
 */
export interface IForeground {
  /** Returns an unsubscribe function. The engine treats signals as hints. */
  subscribe(onForeground: () => void): () => void
}
