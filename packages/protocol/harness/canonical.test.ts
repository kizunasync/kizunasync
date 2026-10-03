import { describe, expect, test } from 'bun:test'
import { assertCanonicalFile, canonicalize, compareUtf8 } from './canonical'

// MARK: - canonicalize

describe('canonicalize', () => {
  test('sorts object keys byte-wise ascending at every level (C-2)', () => {
    expect(canonicalize({ b: 1, a: { z: 1, y: 2 } })).toBe(
      '{\n  "a": {\n    "y": 2,\n    "z": 1\n  },\n  "b": 1\n}\n'
    )
  })

  test('byte-wise key order: "$" < uppercase < "_" < lowercase', () => {
    const keys = Object.keys(JSON.parse(canonicalize({ a: 1, _x: 1, $ref: 1, Z: 1 })) as object)

    expect(keys).toEqual(['$ref', 'Z', '_x', 'a'])
  })

  test('never reorders arrays (C-3)', () => {
    expect(canonicalize([2, 1, 0])).toBe('[\n  2,\n  1,\n  0\n]\n')
  })

  test('renders empty containers inline', () => {
    expect(canonicalize({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}\n')
  })

  test('ends with exactly one trailing newline (C-1)', () => {
    expect(canonicalize(null)).toBe('null\n')
    expect(canonicalize(true)).toBe('true\n')
  })

  test('accepts non-negative integers below 2^31 (C-4)', () => {
    expect(canonicalize(0)).toBe('0\n')
    expect(canonicalize(2 ** 31 - 1)).toBe('2147483647\n')
  })

  test('rejects floats, negatives, -0 and int64-range numbers (C-4 [DR:cursor-and-sequence-decimal-string-grammar])', () => {
    expect(() => canonicalize(1.5)).toThrow('C-4')
    expect(() => canonicalize(-1)).toThrow('C-4')
    expect(() => canonicalize(-0)).toThrow('C-4')
    expect(() => canonicalize(2 ** 31)).toThrow('C-4')
  })

  test('applies only mandatory string escapes (C-5)', () => {
    expect(canonicalize('a"b\\c\nd\u0001')).toBe('"a\\"b\\\\c\\nd\\u0001"\n')
    expect(canonicalize('絆')).toBe('"絆"\n')
  })

  test('rejects non-NFC strings (C-5)', () => {
    expect(() => canonicalize('e\u0301')).toThrow('NFC')
    expect(canonicalize('é')).toBe('"é"\n')
  })
})

// MARK: - compareUtf8

describe('compareUtf8', () => {
  test('orders by UTF-8 bytes, prefixes first', () => {
    expect(compareUtf8('a', 'b')).toBeLessThan(0)
    expect(compareUtf8('a', 'a')).toBe(0)
    expect(compareUtf8('ab', 'a')).toBeGreaterThan(0)
    expect(compareUtf8('Z', '_')).toBeLessThan(0)
    expect(compareUtf8('_', 'a')).toBeLessThan(0)
  })
})

// MARK: - assertCanonicalFile

describe('assertCanonicalFile', () => {
  test('accepts canonical bytes (C-7)', () => {
    const value = { cursor: '0', rows: [], signal: null }

    expect(() => assertCanonicalFile('ok.json', canonicalize(value))).not.toThrow()
  })

  test('reports the first divergent byte offset for unsorted keys', () => {
    expect(() => assertCanonicalFile('bad.json', '{\n  "b": 1,\n  "a": 2\n}\n')).toThrow('offset 5')
  })

  test('rejects a missing trailing newline', () => {
    expect(() => assertCanonicalFile('bad.json', '{}')).toThrow('C-7')
  })

  test('rejects CRLF line endings (C-1)', () => {
    expect(() => assertCanonicalFile('bad.json', '{\r\n  "a": 1\r\n}\r\n')).toThrow('C-7')
  })

  test('rejects a byte-order mark (C-1)', () => {
    expect(() => assertCanonicalFile('bad.json', '\ufeff{}\n')).toThrow('C-1')
  })

  test('rejects duplicate keys via the re-serialization comparison (C-9)', () => {
    expect(() => assertCanonicalFile('bad.json', '{\n  "a": 1,\n  "a": 2\n}\n')).toThrow('C-7')
  })

  test('rejects invalid JSON with the file path in the message', () => {
    expect(() => assertCanonicalFile('broken.json', '{nope')).toThrow('broken.json')
  })
})
