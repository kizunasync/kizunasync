/**
 * Cursor token codec tests (D-cursor-opaque-token).
 *
 * Shared accept/reject vectors plus encode-side guards. Parse of a wire string
 * that is not already canonical is invalid; encode may still sort a hole set
 * it is building.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURSOR_TOKEN, decodeCursor, encodeCursor, parseCursorToken } from './cursor-token'

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, 'cursor-token-vectors.json'), 'utf8'),
) as { accept: string[]; reject: string[] }

describe('cursor codec', () => {
  test('accepts every shared canonical token and round-trips it', () => {
    for (const token of vectors.accept) {
      expect(CURSOR_TOKEN.test(token)).toBe(true)
      const decoded = decodeCursor(token)

      expect(parseCursorToken(token)).toEqual(decoded)
      expect(encodeCursor(decoded)).toBe(token)
    }
  })

  test('rejects every shared non-canonical token', () => {
    for (const token of vectors.reject) {
      expect(parseCursorToken(token)).toBeNull()
      expect(() => decodeCursor(token)).toThrow(`decodeCursor: invalid cursor token: ${token}`)
    }
  })

  test('decodes every server-authored form', () => {
    expect(decodeCursor('0')).toEqual({ start: null, highWater: 0n, holes: [] })
    expect(decodeCursor('42')).toEqual({ start: null, highWater: 42n, holes: [] })
    expect(decodeCursor('6~5')).toEqual({ start: null, highWater: 6n, holes: [5n] })
    expect(decodeCursor('0:2')).toEqual({ start: 0n, highWater: 2n, holes: [] })
    expect(decodeCursor('4:9~5.7')).toEqual({ start: 4n, highWater: 9n, holes: [5n, 7n] })
  })

  test('a start above the high-water is a valid continuation', () => {
    expect(decodeCursor('12:3')).toEqual({ start: 12n, highWater: 3n, holes: [] })
  })

  test('rejects a malformed start', () => {
    for (const token of [':6', '-1:6', '+1:6', '1:2:3', '04:6', '4:']) {
      expect(parseCursorToken(token)).toBeNull()
    }
  })

  test('encodes empty holes to the bare decimal', () => {
    expect(encodeCursor({ start: null, highWater: 6n, holes: [] })).toBe('6')
    expect(encodeCursor({ start: null, highWater: 0n, holes: [] })).toBe('0')
  })

  test('encodes a continuation token with its start', () => {
    expect(encodeCursor({ start: 0n, highWater: 2n, holes: [] })).toBe('0:2')
    expect(encodeCursor({ start: 4n, highWater: 9n, holes: [7n, 5n] })).toBe('4:9~5.7')
  })

  test('encode sorts a hole set it is building', () => {
    expect(encodeCursor({ start: null, highWater: 10n, holes: [8n, 3n, 5n] })).toBe('10~3.5.8')
  })

  test('encode throws when a hole equals highWater', () => {
    expect(() => encodeCursor({ start: null, highWater: 6n, holes: [6n] })).toThrow(
      'encodeCursor: hole 6 must be strictly less than highWater 6',
    )
  })

  test('encode throws when a hole exceeds highWater', () => {
    expect(() => encodeCursor({ start: null, highWater: 5n, holes: [7n] })).toThrow(
      'encodeCursor: hole 7 must be strictly less than highWater 5',
    )
  })

  test('encode throws on a negative start', () => {
    expect(() => encodeCursor({ start: -1n, highWater: 5n, holes: [] })).toThrow('encodeCursor: start -1 must be >= 0')
  })

  test('common.schema.json cursor.pattern equals CURSOR_TOKEN.source', () => {
    const schema = JSON.parse(
      readFileSync(join(import.meta.dir, '../schemas/common.schema.json'), 'utf8'),
    ) as { $defs: { cursor: { pattern: string } } }

    expect(schema.$defs.cursor.pattern).toBe(CURSOR_TOKEN.source)
  })
})
