import { formatRelativeTime, formatTimestamp } from '@/lib/formatters'

// MARK: - Time cell

/**
 * The same relative-time reading in every panel, absolute timestamp on hover.
 * Falls back to the absolute value until the clock mounts, so the server
 * markup and the first client render agree.
 */
export function TimeCell({ iso, now }: { iso: string; now: number | null }) {
  return (
    <span title={formatTimestamp(iso)}>
      {now === null ? formatTimestamp(iso) : formatRelativeTime(iso, now)}
    </span>
  )
}
