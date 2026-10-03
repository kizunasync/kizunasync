// MARK: - SHA-256 known-answer vectors + streaming == one-shot

/**
 * FIPS-180-4 / NIST CAVP example digests plus a chunk-boundary sweep proving the
 * incremental update() path is byte-identical to a single update(), the
 * property the attachment queue relies on when it hashes a file in ranges.
 */

import { describe, expect, test } from 'bun:test'
import { createSha256, sha256Hex } from './sha256'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const VECTORS: { input: string; digest: string }[] = [
  { input: '', digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  { input: 'abc', digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  {
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    digest: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
  {
    input: 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    digest: 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  },
]

describe('sha256', () => {
  for (const { input, digest } of VECTORS) {
    test(`vector: "${input.slice(0, 16)}${input.length > 16 ? '…' : ''}"`, () => {
      expect(sha256Hex(utf8(input))).toBe(digest)
    })
  }

  test('one million "a" bytes', () => {
    const hasher = createSha256()
    const chunk = new Uint8Array(1000).fill(0x61)

    for (let i = 0; i < 1000; i++) {
      hasher.update(chunk)
    }
    expect(hasher.digest()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  test('streaming in arbitrary chunk sizes equals one-shot', () => {
    const data = new Uint8Array(1024)

    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 31 + 7) & 0xff
    }
    const oneShot = sha256Hex(data)

    for (const size of [1, 3, 7, 31, 63, 64, 65, 100, 256, 1023]) {
      const hasher = createSha256()

      for (let i = 0; i < data.length; i += size) {
        hasher.update(data.subarray(i, Math.min(i + size, data.length)))
      }
      expect(hasher.digest()).toBe(oneShot)
    }
  })

  test('digest is idempotent; update after digest throws', () => {
    const hasher = createSha256()

    hasher.update(utf8('abc'))
    const first = hasher.digest()

    expect(hasher.digest()).toBe(first)
    expect(() => hasher.update(utf8('x'))).toThrow()
  })

  test('sha256Hex accepts ArrayBuffer and Uint8Array equivalently', () => {
    const u8 = utf8('the bonds that sync us')
    const buf = new ArrayBuffer(u8.byteLength)

    new Uint8Array(buf).set(u8)
    expect(sha256Hex(buf)).toBe(sha256Hex(u8))
  })
})
