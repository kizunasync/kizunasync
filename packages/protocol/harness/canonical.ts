/**
 * Canonical JSON (rules C-1..C-7 and C-9). C-8 is the logical timestamp grammar,
 * enforced by the timestamp schema, not by this serializer.
 *
 * Every JSON artifact in packages/protocol/ is byte-canonical: UTF-8, no BOM, LF only,
 * exactly one trailing newline (C-1); 2-space indent, object keys sorted
 * byte-wise ascending at every level (C-2); arrays never reordered (C-3);
 * JSON numbers only for non-negative integers < 2^31: every int64-class
 * protocol value (seq, cursor) is a decimal string (C-4) [DR:cursor-and-sequence-decimal-string-grammar];
 * strings NFC with only mandatory escapes (C-5); literal booleans/null (C-6).
 * `assertCanonicalFile` re-serializes and byte-compares to disk (C-7); a
 * duplicate key in the source (C-9) re-parses to a different shape and is
 * caught by the same byte comparison.
 *
 * This module is the byte-canonicalization layer only. Transcript execution is
 * implemented separately by executor/ and by the Rust conformance runner.
 */

// MARK: - Constants

const INDENT = '  '
const INT_LIMIT = 2 ** 31

// MARK: - Byte helpers

const UTF8 = new TextEncoder()

export const compareUtf8 = (a: string, b: string): number => {
  const left = UTF8.encode(a)
  const right = UTF8.encode(b)
  const length = Math.min(left.length, right.length)

  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)

    if (delta !== 0) {
      return delta
    }
  }
  return left.length - right.length
}

const describeByte = (byte: number | undefined): string =>
  byte === undefined ? 'end of input' : `0x${byte.toString(16).padStart(2, '0')}`

// MARK: - Scalar rendering

function escapeChar(char: string): string {
  const code = char.codePointAt(0) ?? 0

  if (char === '"') {
    return '\\"'
  }
  if (char === '\\') {
    return '\\\\'
  }
  if (code === 0x08) {
    return '\\b'
  }
  if (code === 0x09) {
    return '\\t'
  }
  if (code === 0x0a) {
    return '\\n'
  }
  if (code === 0x0c) {
    return '\\f'
  }
  if (code === 0x0d) {
    return '\\r'
  }
  if (code < 0x20) {
    return `\\u${code.toString(16).padStart(4, '0')}`
  }
  return char
}

const renderString = (value: string): string => {
  if (value !== value.normalize('NFC')) {
    throw new Error(`canonicalize: string is not NFC-normalized (C-5): ${JSON.stringify(value)}`)
  }
  let out = '"'

  for (const char of value) {
    out += escapeChar(char)
  }
  return `${out}"`
}

const renderNumber = (value: number): string => {
  if (!Number.isInteger(value) || Object.is(value, -0) || value < 0 || value >= INT_LIMIT) {
    throw new Error(
      'canonicalize: JSON numbers are restricted to non-negative integers < 2^31 (C-4); ' +
        `int64-class values are decimal strings [DR:cursor-and-sequence-decimal-string-grammar]: got ${String(value)}`
    )
  }
  return String(value)
}

// MARK: - Recursive rendering

const render = (value: unknown, depth: number): string => {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    return renderNumber(value)
  }
  if (typeof value === 'string') {
    return renderString(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }
    const inner = INDENT.repeat(depth + 1)
    const items = value.map((item) => `${inner}${render(item, depth + 1)}`)

    return `[\n${items.join(',\n')}\n${INDENT.repeat(depth)}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)

    if (entries.length === 0) {
      return '{}'
    }
    entries.sort((a, b) => compareUtf8(a[0], b[0]))
    const inner = INDENT.repeat(depth + 1)
    const lines = entries.map(([key, item]) => `${inner}${renderString(key)}: ${render(item, depth + 1)}`)

    return `{\n${lines.join(',\n')}\n${INDENT.repeat(depth)}}`
  }
  throw new Error(`canonicalize: unsupported value of type ${typeof value} (JSON values only, C-1..C-6)`)
}

// MARK: - Public API

export const canonicalize = (value: unknown): string => `${render(value, 0)}\n`

export const assertCanonicalFile = (path: string, raw: string): void => {
  if (raw.startsWith('\ufeff')) {
    throw new Error(`${path}: byte-order mark present (C-1: UTF-8, no BOM)`)
  }
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const canonical = canonicalize(parsed)

  if (raw === canonical) {
    return
  }
  const rawBytes = UTF8.encode(raw)
  const canonicalBytes = UTF8.encode(canonical)
  const length = Math.min(rawBytes.length, canonicalBytes.length)
  let offset = length

  for (let i = 0; i < length; i += 1) {
    if (rawBytes[i] !== canonicalBytes[i]) {
      offset = i
      break
    }
  }
  throw new Error(
    `${path}: not byte-canonical (C-7): first divergent byte at offset ${offset} ` +
      `(found ${describeByte(rawBytes[offset])}, expected ${describeByte(canonicalBytes[offset])})`
  )
}
