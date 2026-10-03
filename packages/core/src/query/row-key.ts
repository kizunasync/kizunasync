// MARK: - Row key

/**
 * A table syncs by its own key columns (D-row-key). The kernel derives every
 * pk from them, so the host never spells one: it only mints a uuid for a
 * table keyed by `id` whose row names no `id`, and finds a row it inserted by
 * the key columns it wrote.
 */

import type { TColumnValues, TQueryFilter } from '../wire/types'

/** The column a table is keyed by when its config names no key. */
const DEFAULT_KEY_COLUMN = 'id'

/** The key of a table whose config names none. */
export const DEFAULT_KEY: readonly string[] = [DEFAULT_KEY_COLUMN]

export function isDefaultKey(key: readonly string[]): boolean {
  return key.length === 1 && key[0] === DEFAULT_KEY_COLUMN
}

/** 8-4-4-4-12 hex digits joined by hyphens, in any case: the uuid grammar, which the kernel lowercases in a key. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A minted key in the form the kernel stores it: a uuid lowercased, anything else as it is. */
export function toStoredKey(minted: string): string {
  return UUID_PATTERN.test(minted) ? minted.toLowerCase() : minted
}

/** Whether an insert takes a minted uuid as its pk. A present `id`, null included, is the app's own key, which the kernel checks. */
export function mintsKey(key: readonly string[], values: TColumnValues): boolean {
  return isDefaultKey(key) && !(DEFAULT_KEY_COLUMN in values)
}

/** The filters that find the row an insert wrote: `id` equal to the minted pk, or each key column equal to the value written. */
export function keyFilters(input: { key: readonly string[]; values: TColumnValues; minted: string | null }): TQueryFilter[] {
  const { key, values, minted } = input

  if (minted !== null) {
    return [{ kind: 'eq', column: DEFAULT_KEY_COLUMN, value: minted }]
  }
  return key.map((column) => ({ kind: 'eq', column, value: values[column] ?? null }))
}
