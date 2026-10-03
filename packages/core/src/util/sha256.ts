// MARK: - SHA-256

/**
 * WebCrypto's crypto.subtle.digest and expo-crypto are ONE-SHOT: they hash a
 * whole buffer, never a stream. An incremental hasher lets a file store hash an
 * attachment in bounded chunks instead of holding it whole; a store that
 * buffers its input anyway makes a single update(). `@noble/hashes` provides
 * that streaming SHA-256 in plain JavaScript, identical on web, React Native
 * and Node with no native dependency. Hot path is content-addressing at
 * enqueue; correctness is gated by known-answer vectors in the test.
 */

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

// MARK: - Hasher

export interface ISha256 {
  update(chunk: Uint8Array): void

  /**
   * Lowercase hex digest. Idempotent once finalized, so a second call returns
   * the same string; update() after digest() throws (the state is consumed).
   */
  digest(): string
}

export const createSha256 = (): ISha256 => {
  const hash = sha256.create()
  let finalized: string | null = null

  const update = (chunk: Uint8Array): void => {
    if (finalized !== null) {
      throw new Error('sha256: update after digest')
    }
    hash.update(chunk)
  }

  const digest = (): string => {
    if (finalized !== null) {
      return finalized
    }
    finalized = bytesToHex(hash.digest())

    return finalized
  }

  return { update, digest }
}

// MARK: - One-shot convenience

export const sha256Hex = (data: ArrayBuffer | Uint8Array): string => {
  const hasher = createSha256()

  hasher.update(data instanceof Uint8Array ? data : new Uint8Array(data))

  return hasher.digest()
}
