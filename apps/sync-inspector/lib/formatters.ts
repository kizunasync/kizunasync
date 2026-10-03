// MARK: - Inspector formatting

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function formatTimestamp(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}

/**
 * Grouped counts for the status strip. The locale is pinned rather than left
 * to the runtime: the server and the browser must format the same number
 * identically or hydration reports a mismatch.
 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

// MARK: - Device freshness

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export const FRESH_MAX_MS = 5 * MINUTE_MS
export const IDLE_MAX_MS = HOUR_MS

export type TFreshness = 'fresh' | 'idle' | 'gone'

/**
 * A device's own `last_seen` is the only evidence the server holds that it is
 * still syncing, so an unparseable one reads as `gone` rather than claiming a
 * freshness the row does not support.
 */
export function classifyFreshness(iso: string, now: number): TFreshness {
  const age = now - Date.parse(iso)

  if (age <= FRESH_MAX_MS) {
    return 'fresh'
  }
  if (age <= IDLE_MAX_MS) {
    return 'idle'
  }
  return 'gone'
}

/**
 * Coarse "3m ago" register: one unit, never a compound. A timestamp this
 * cannot parse degrades to itself: this is a display surface, not a gate.
 */
export function formatRelativeTime(iso: string, now: number): string {
  const age = now - Date.parse(iso)

  if (Number.isNaN(age)) {
    return iso
  }
  if (age < SECOND_MS) {
    return 'just now'
  }
  if (age < MINUTE_MS) {
    return `${String(Math.floor(age / SECOND_MS))}s ago`
  }
  if (age < HOUR_MS) {
    return `${String(Math.floor(age / MINUTE_MS))}m ago`
  }
  if (age < DAY_MS) {
    return `${String(Math.floor(age / HOUR_MS))}h ago`
  }
  return `${String(Math.floor(age / DAY_MS))}d ago`
}

// MARK: - Job schedules

/**
 * `crontab.guru` reads a schedule from its URL fragment with spaces as
 * underscores; the pack stores whitespace-separated fields (SQL:cron-schedule-grammar).
 */
export function crontabGuruUrl(schedule: string): string {
  return `https://crontab.guru/#${schedule.trim().split(/\s+/).join('_')}`
}

// MARK: - Attachment size

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * 1024-based, one unit at a time: how a developer reads a file size, not the
 * storage layer's raw byte count. One decimal only when the value is not whole.
 */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const rounded = Math.round(value * 10) / 10
  const digits = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)

  return `${digits} ${BYTE_UNITS[unitIndex]}`
}
