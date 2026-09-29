// MARK: - Wakeup port

/**
 * Realtime is a latency optimization, never the source of truth: a missed
 * signal only delays the next poll. The adapter wraps a Supabase Realtime
 * broadcast subscription plus a jittered poll fallback; the engine only ever
 * sees "something changed, pull now".
 */
export interface IWakeup {
  /** Returns an unsubscribe function. The engine treats signals as hints. */
  subscribe(onSignal: () => void): () => void
}
