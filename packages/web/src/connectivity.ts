/**
 * Web connectivity adapter.
 *
 * The browser IConnectivity (core connectivity port): navigator.onLine for the
 * current state, the window online/offline events for transitions. The engine
 * keeps mutations queued while offline and flushes the outbox on false→true.
 *
 * SSR-safe: with no window (server/prebuild) it reports always-online and a no-op
 * subscription, matching the core's `alwaysOnline` fallback.
 */

// MARK: - Web connectivity adapter

import type { IConnectivity } from '@kizunasync/core'

export function createWebConnectivity(): IConnectivity {
  return {
    // Optimistic when unknown (core contract): SSR/non-browser runtimes have no navigator, and some (e.g. bun) expose navigator without `onLine`. Both resolve to true rather than a falsy "offline".
    isOnline: () => {
      const online = typeof navigator === 'undefined' ? undefined : navigator.onLine

      return online ?? true
    },
    subscribe: (onChange) => {
      if (typeof window === 'undefined') {
        return () => {}
      }
      const handleOnline = () => onChange(true)
      const handleOffline = () => onChange(false)

      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)

      return () => {
        window.removeEventListener('online', handleOnline)
        window.removeEventListener('offline', handleOffline)
      }
    },
  }
}
