'use client'

import { Button } from '@heroui/react/button'
import { useDoorbellRefresh } from '@/lib/use-doorbell-refresh'

const BACKSTOP_INTERVAL_MS = 10_000

/** The realtime-doorbell / paused / auth-failed toggle. Lives in the status strip, beside the "updated Ns ago" reading it governs. */
export function LiveRefresh({ intervalMs = BACKSTOP_INTERVAL_MS }: { intervalMs?: number }) {
  const { doorbellState, toggle } = useDoorbellRefresh(intervalMs)
  const paused = doorbellState === 'paused'
  const isAuthFailed = doorbellState === 'auth-failed'

  const label = isAuthFailed ? 'doorbell unavailable' : paused ? 'paused' : 'live'
  const titleText = isAuthFailed
    ? 'Anonymous sign-in failed. Live doorbell updates are unavailable, but the slow poll still runs.'
    : paused
      ? 'Resume live updates'
      : 'Pause live updates'

  return (
    <Button
      size="sm"
      variant="outline"
      onPress={isAuthFailed ? undefined : toggle}
      aria-label={titleText}
      aria-pressed={paused}
      className="border-site-border text-site-muted hover:text-site-text gap-1.5 rounded-full px-2.5 py-1 text-xs"
      isDisabled={isAuthFailed}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${
          isAuthFailed
            ? 'bg-site-gold'
            : paused
              ? 'bg-site-faint'
              : 'bg-site-ok animate-pulse'
        }`}
      />
      {label}
    </Button>
  )
}
