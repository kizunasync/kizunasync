/**
 * Time formatting shared by the three example apps: a 24h clock stamp for the
 * sync bar's "Last sync" text, and a coarse relative-time label for the
 * rejections list and the engine-event ring.
 */

// MARK: - Clock time

/** Formats a ms epoch as a 24h HH:MM:SS clock string. */
export function formatClockTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// MARK: - Relative time

/**
 * A coarse relative-time label ("just now" / "5m ago" / "2h ago" / "3d ago")
 * for a ms epoch. `now` is injectable so a caller re-rendering on every new
 * event needs no live-ticking clock, and so a test can pin the delta.
 */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const deltaSeconds = Math.max(0, Math.floor((now - at) / 1000))

  if (deltaSeconds < 60) {
    return 'just now'
  }
  const deltaMinutes = Math.floor(deltaSeconds / 60)

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`
  }
  const deltaHours = Math.floor(deltaMinutes / 60)

  if (deltaHours < 24) {
    return `${deltaHours}h ago`
  }
  const deltaDays = Math.floor(deltaHours / 24)

  return `${deltaDays}d ago`
}
