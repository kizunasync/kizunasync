'use client'

import { useEffect, useState } from 'react'

// MARK: - Ticking clock for relative times

const TICK_INTERVAL_MS = 1000

/**
 * Returns a wall clock that advances on an interval, or `null` until the
 * browser has mounted. The null phase is deliberate: the server renders this
 * page at request time, so reading `Date.now()` during render would produce
 * markup that disagrees with the client a second later. Callers show an
 * absolute timestamp while it is null and switch to "3m ago" once it ticks.
 */
export function useNow(intervalMs: number = TICK_INTERVAL_MS): number | null {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)

    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}
