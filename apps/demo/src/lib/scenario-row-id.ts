import type { TScenarioRole } from '@/runtime/demo-config'

// MARK: - Per-visitor pks for the scripted scenarios

/**
 * Each scripted scenario contests one row. That row's pk is derived from the
 * visitor's uid so that each visitor's scenario row is its own row: two
 * visitors running the same scenario never write to the same pk. A constant pk
 * would put every visitor on one row, so one visitor's run would fight
 * another's.
 *
 * Derivation gives three properties the scenarios depend on:
 *   * one visitor, both panes → the SAME id (the panes share a uid), so the A/B
 *     race still contests a single row;
 *   * different visitors → different ids, so no pk is ever contended across
 *     visitors;
 *   * a reload of the same session → the same id, so ensureRow stays idempotent
 *     and the buttons stay re-runnable.
 *
 * The digest is truncated to 16 bytes and stamped with the version-4 and RFC-4122
 * variant bits: the value is deterministic, not random, but it must still be a
 * well-formed uuid because the column is `uuid`.
 */
const derived = new Map<string, Promise<string>>()

/**
 * Memoized per uid+role: the digest is stable for the life of the session, so it
 * is computed once rather than on every button press.
 */
export function deriveScenarioRowId(userId: string, role: TScenarioRole): Promise<string> {
  const seed = `${userId}:${role}`
  const existing = derived.get(seed)

  if (existing !== undefined) {
    return existing
  }
  const pending = digestToUuid(seed)

  derived.set(seed, pending)

  return pending
}

// MARK: - internal

async function digestToUuid(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))
  // A DataView rather than indexing a Uint8Array: `noUncheckedIndexedAccess` types every element read as possibly-undefined, and getUint8 does not.
  const bytes = new DataView(digest, 0, 16)

  bytes.setUint8(6, (bytes.getUint8(6) & 0x0f) | 0x40)
  bytes.setUint8(8, (bytes.getUint8(8) & 0x3f) | 0x80)

  let hex = ''

  for (let i = 0; i < 16; i++) {
    hex += bytes.getUint8(i).toString(16).padStart(2, '0')
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
