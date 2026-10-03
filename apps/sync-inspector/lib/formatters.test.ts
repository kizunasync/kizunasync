import { describe, expect, test } from 'bun:test'
import { classifyFreshness, crontabGuruUrl, formatBytes, formatCount, formatRelativeTime, formatTimestamp, shortId, type TFreshness } from './formatters'

describe('shortId', () => {
  test('returns the first 8 characters', () => {
    expect(shortId('abc12345-rest-of-uuid')).toBe('abc12345')
  })

  test('handles a string shorter than 8 characters', () => {
    expect(shortId('abc')).toBe('abc')
  })
})

describe('formatTimestamp', () => {
  test('replaces T separator with a space and trims to seconds', () => {
    expect(formatTimestamp('2025-06-20T14:30:00.123456+00:00')).toBe('2025-06-20 14:30:00')
  })

  test('handles a timestamp already without timezone suffix', () => {
    expect(formatTimestamp('2025-01-01T00:00:00')).toBe('2025-01-01 00:00:00')
  })
})

const NOW = Date.parse('2026-01-01T12:00:00.000Z')

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

describe('classifyFreshness', () => {
  const cases: [string, number, TFreshness][] = [
    ['a device seen seconds ago is fresh', 20_000, 'fresh'],
    ['the 5-minute boundary is still fresh', 5 * 60_000, 'fresh'],
    ['past 5 minutes it is idle', 5 * 60_000 + 1, 'idle'],
    ['the 1-hour boundary is still idle', 60 * 60_000, 'idle'],
    ['past an hour it is gone', 60 * 60_000 + 1, 'gone'],
  ]

  for (const [name, age, expected] of cases) {
    test(name, () => {
      expect(classifyFreshness(ago(age), NOW)).toBe(expected)
    })
  }

  test('an unparseable timestamp reads as gone, never as fresh', () => {
    expect(classifyFreshness('not-a-timestamp', NOW)).toBe('gone')
  })
})

describe('formatRelativeTime', () => {
  test('sub-second and future timestamps read as just now', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('just now')
    expect(formatRelativeTime(ago(-30_000), NOW)).toBe('just now')
  })

  test('seconds, minutes, hours, and days each get one unit', () => {
    expect(formatRelativeTime(ago(42_000), NOW)).toBe('42s ago')
    expect(formatRelativeTime(ago(3 * 60_000), NOW)).toBe('3m ago')
    expect(formatRelativeTime(ago(5 * 3_600_000), NOW)).toBe('5h ago')
    expect(formatRelativeTime(ago(9 * 86_400_000), NOW)).toBe('9d ago')
  })

  test('the unit floors rather than rounds up', () => {
    expect(formatRelativeTime(ago(119_000), NOW)).toBe('1m ago')
  })

  test('an unparseable timestamp degrades to itself', () => {
    expect(formatRelativeTime('not-a-timestamp', NOW)).toBe('not-a-timestamp')
  })
})

describe('formatCount', () => {
  test('groups thousands the same way on every runtime', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1204)).toBe('1,204')
    expect(formatCount(1_204_000)).toBe('1,204,000')
  })
})

describe('crontabGuruUrl', () => {
  test('turns whitespace-separated fields into an underscore fragment', () => {
    expect(crontabGuruUrl('16 3 * * *')).toBe('https://crontab.guru/#16_3_*_*_*')
  })

  test('collapses irregular whitespace and trims the ends', () => {
    expect(crontabGuruUrl('  47   3 * * * ')).toBe('https://crontab.guru/#47_3_*_*_*')
  })
})

describe('formatBytes', () => {
  test('stays in bytes below one kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  test('a whole number of units drops the decimal', () => {
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
  })

  test('a fractional unit keeps one decimal place', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  test('tops out at TB rather than inventing a larger unit', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB')
  })
})
