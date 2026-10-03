/**
 * The supabase-js methods and options the local builders refuse by name, each
 * with the reason it has no local meaning, so a call outside the local subset
 * throws a typed LOCAL_UNSUPPORTED (@../../../../CONVENTIONS.md) instead of a
 * bare TypeError or a quiet no-op. The reference Errors tables list the same
 * reasons.
 */

import { EEngineErrorCode, TEngineError } from '../wire/types'

// MARK: - Compatibility matrix pointer

const MATRIX_HINT = 'see the supported query operators in docs/reference/query-operators.md'

export const unsupported = (construct: string): TEngineError =>
  new TEngineError(
    EEngineErrorCode.LOCAL_UNSUPPORTED,
    `"${construct}" is not supported by the local query API (no network fallback): ${MATRIX_HINT}`,
    construct,
  )

// MARK: - Reasons

const RANGE_TYPES = 'Postgres range types have no local representation'

/** `referencedTable` / `foreignTable` name an embedded table, and the local store has none to address. */
export const NO_JOINS = 'the local store holds each synced table without foreign-key joins; read related rows with a second query'

/** Why each refused supabase-js method has no local meaning. */
const REFUSAL_REASONS = {
  rangeGt: RANGE_TYPES,
  rangeGte: RANGE_TYPES,
  rangeLt: RANGE_TYPES,
  rangeLte: RANGE_TYPES,
  rangeAdjacent: RANGE_TYPES,
  geojson: 'PostGIS output has no local representation',
  explain: 'EXPLAIN describes the server query planner',
  rollback: 'there is no server transaction to roll back; local writes enter the outbox',
  setHeader: 'a local read or write sends no HTTP request',
  rpc: 'rpc() runs a server function; call it through supabase-js when online',
  schema: 'synced tables are addressed by name',
  getOpenApiSpec: 'the OpenAPI spec is server metadata',
  upsert: 'an offline device cannot know whether the server holds the row; use insert or update',
  maxAffected: 'maxAffected() caps an update or a delete, not a read',
  csv: 'csv() formats a read, not a write',
  returns: 'a write without select() has no rows to type',
  overrideTypes: 'a write without select() has no rows to type',
  stripNulls: 'a write without select() has no rows to strip',
  abortSignal: 'a local write is applied at once and cannot be aborted',
} as const

export type TRefusedMethod = keyof typeof REFUSAL_REASONS

/** Each named method as a stub that throws its LOCAL_UNSUPPORTED. */
export type TRefusals<TName extends TRefusedMethod> = { [K in TName]: (...args: unknown[]) => never }

/** Every method a read refuses: the range-type filters and the server-only transforms. */
export const READ_REFUSALS = ['rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent', 'geojson', 'explain', 'rollback', 'setHeader', 'maxAffected'] as const

/** Every method an update or a delete refuses before `select()` names rows to return. */
export const WRITE_REFUSALS = ['rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent', 'geojson', 'explain', 'rollback', 'setHeader', 'csv', 'returns', 'overrideTypes', 'stripNulls', 'abortSignal'] as const

/** Every method an update or a delete refuses after `select()`. */
export const WRITE_SELECT_REFUSALS = ['rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent', 'geojson', 'explain', 'rollback', 'setHeader', 'csv', 'abortSignal'] as const

// MARK: - Stubs

/** The LOCAL_UNSUPPORTED a refused method throws, its reason in the message. */
export function refuse(method: TRefusedMethod): never {
  throw unsupported(`${method}() (${REFUSAL_REASONS[method]})`)
}

export function createRefusals<TName extends TRefusedMethod>(names: readonly TName[]): TRefusals<TName> {
  const stubs = {} as TRefusals<TName>

  for (const name of names) {
    stubs[name] = (): never => refuse(name)
  }
  return stubs
}

// MARK: - Options

/** Throws LOCAL_UNSUPPORTED naming a supabase-js option this builder cannot honour, and why. */
export function rejectOption(call: string, key: string, reason: string): never {
  throw unsupported(`${call}({ ${key} }) (${reason})`)
}

/** `order()`, `limit()`, `range()`, `or()`, and `textSearch()` share this supabase-js pair: there is no embedded table to address here. */
export function rejectReferencedTable(call: string, options?: { referencedTable?: string; foreignTable?: string }): void {
  if (options?.referencedTable !== undefined) {
    rejectOption(call, 'referencedTable', NO_JOINS)
  }
  if (options?.foreignTable !== undefined) {
    rejectOption(call, 'foreignTable', NO_JOINS)
  }
}

/** The row-count algorithms supabase-js names; each answers the exact local count, since the kernel counts every match. */
export type TCountOption = 'exact' | 'planned' | 'estimated'

const COUNT_OPTIONS: readonly string[] = ['exact', 'planned', 'estimated'] satisfies readonly TCountOption[]

/** Whether a supabase-js `count` option asks for a count: absent asks for none, and a mode outside the three throws LOCAL_UNSUPPORTED. */
export function isCountRequested(call: string, count: string | undefined): boolean {
  if (count === undefined) {
    return false
  }
  if (!COUNT_OPTIONS.includes(count)) {
    rejectOption(call, `count: '${count}'`, 'count takes exact, planned, or estimated')
  }
  return true
}
