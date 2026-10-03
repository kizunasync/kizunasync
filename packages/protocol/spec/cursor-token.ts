/**
 * Cursor token codec (D-cursor-opaque-token, the opaque token).
 *
 * The pull cursor is OPAQUE on the wire (TCursor, D-cursor-opaque-token): the client persists
 * and replays it verbatim; only the server interprets it. The reference oracle's
 * refined horizon (D-visibility-horizon) delivers committed rows above an
 * in-flight gap and records each gap as a hole below the high-water mark. The
 * SQL pack numbers changes at commit and emits no holes. A continuation page
 * (D-page-cap-and-checkpoint-boundary) also carries the start: the high-water of
 * the checkpoint its transfer started from, which the expiry gate checks.
 *
 * Encoding:
 *   - checkpoint                → `<highWater>`                      e.g. "6"
 *   - checkpoint with holes     → `<highWater>~<h1>.<h2>...`          e.g. "6~5"
 *   - continuation              → `<start>:<highWater>`              e.g. "0:2"
 *   - continuation with holes   → `<start>:<highWater>~<h1>.<h2>...`  e.g. "4:9~5.7"
 * Holes are strictly ascending and strictly below the high-water mark. `:`, `~`,
 * and `.` never appear in a decimal, so decode is unambiguous. The start has no
 * ordering constraint against the high-water: a page that delivered only holes
 * leaves the position below it. Bootstrap "0" decodes to
 * `{ start: null, highWater: 0n, holes: [] }`.
 *
 * Parse rejects a string that is not already canonical: leading zeros, a sign,
 * an empty or second start, a 0 hole, a hole at or above the high-water mark,
 * unsorted holes, or duplicates. Encode still sorts a hole set it is building so
 * a new token is canonical.
 *
 * This is the TypeScript codec. The Rust engine and the SQL pack each implement
 * the same grammar; `cursor-token-vectors.json` is the shared accept/reject list.
 * The harness imports `parseCursorToken` rather than re-declaring the regex.
 */

// MARK: - Types

export type TCursorToken = { start: bigint | null; highWater: bigint; holes: bigint[] }

// MARK: - Constants

const START_SEPARATOR = ':'
const HIGH_WATER_HOLES_SEPARATOR = '~'
const HOLE_SEPARATOR = '.'

/** Wire grammar for a canonical cursor token. Semantic rules (holes strictly below the mark, strictly ascending, unique) are checked in `parseCursorToken`. */
export const CURSOR_TOKEN = /^((0|[1-9][0-9]*):)?(0|[1-9][0-9]*)(~[1-9][0-9]*(\.[1-9][0-9]*)*)?$/

// MARK: - Decode

/**
 * Parse a wire cursor token. Returns null when the string is outside the
 * canonical grammar or the semantic hole rules.
 */
export const parseCursorToken = (token: string): TCursorToken | null => {
  if (!CURSOR_TOKEN.test(token)) {
    return null
  }
  const colon = token.indexOf(START_SEPARATOR)
  const start = colon === -1 ? null : BigInt(token.slice(0, colon))
  const position = token.slice(colon + 1)
  const tilde = position.indexOf(HIGH_WATER_HOLES_SEPARATOR)

  if (tilde === -1) {
    return { start, highWater: BigInt(position), holes: [] }
  }
  const highWater = BigInt(position.slice(0, tilde))
  const holes = position
    .slice(tilde + 1)
    .split(HOLE_SEPARATOR)
    .map((part) => BigInt(part))

  for (let index = 0; index < holes.length; index += 1) {
    const hole = holes[index]!

    if (hole >= highWater) {
      return null
    }
    if (index > 0 && hole <= holes[index - 1]!) {
      return null
    }
  }
  return { start, highWater, holes }
}

/**
 * Decode an opaque cursor token. Throws when the token is not canonical.
 */
export const decodeCursor = (token: string): TCursorToken => {
  const parsed = parseCursorToken(token)

  if (parsed === null) {
    throw new Error(`decodeCursor: invalid cursor token: ${token}`)
  }
  return parsed
}

// MARK: - Encode

/**
 * Encode a cursor token. A null start and empty holes give the bare decimal
 * high-water mark (byte-identical to the flat decimal cursor); a start prefixes
 * `<start>:`. Non-empty holes are emitted ascending so the token is canonical
 * for a given { start, highWater, holes } set.
 *
 * Throws if any hole is >= highWater or the start is negative: every hole must
 * be a strictly-below-mark in-flight seq, and encoding an invalid token would
 * pass wire-format validation silently (fail loud, never fabricate semantically
 * invalid state; @../../../CONVENTIONS.md).
 */
export const encodeCursor = (token: TCursorToken): string => {
  for (const hole of token.holes) {
    if (hole >= token.highWater) {
      throw new Error(`encodeCursor: hole ${hole} must be strictly less than highWater ${token.highWater}`)
    }
    if (hole < 1n) {
      throw new Error(`encodeCursor: hole ${hole} must be >= 1`)
    }
  }
  if (token.start !== null && token.start < 0n) {
    throw new Error(`encodeCursor: start ${token.start} must be >= 0`)
  }
  const prefix = token.start === null ? '' : `${token.start}${START_SEPARATOR}`

  if (token.holes.length === 0) {
    return `${prefix}${token.highWater}`
  }
  const ascending = [...token.holes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return `${prefix}${token.highWater}${HIGH_WATER_HOLES_SEPARATOR}${ascending.join(HOLE_SEPARATOR)}`
}
