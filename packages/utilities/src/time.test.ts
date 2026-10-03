/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { formatClockTime, formatRelativeTime } from './time'

describe('formatClockTime', () => {
  test('pads a 24h HH:MM:SS clock string', () => {
    const at = new Date(2026, 0, 1, 4, 5, 6).getTime()

    expect(formatClockTime(at)).toBe('04:05:06')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date(2026, 0, 1, 12, 0, 0).getTime()

  test('under a minute reads as just now', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now')
  })

  test('minutes, hours, and days each get their own unit', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now)).toBe('2h ago')
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now)).toBe('3d ago')
  })

  test('defaults now to the current clock', () => {
    expect(formatRelativeTime(Date.now())).toBe('just now')
  })
})
