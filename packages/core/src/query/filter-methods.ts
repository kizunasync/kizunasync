// MARK: - Shared filter methods for the select/write builders

/**
 * `createSelectBuilder` and `createWriteBuilder` (`builder.ts`) both expose the
 * same supabase-js comparison, pattern, containment, and boolean filter surface
 * (`eq` through `not`); this factory is their one implementation, spread into
 * each builder's object literal so a new operator is added once. `unsupported`
 * and its compatibility-matrix pointer live here rather than `builder.ts` so
 * both modules can import it with `builder.ts` depending on this one, not the
 * reverse. `.or()` and `.and()` accept strings because that is the supabase-js
 * API shape; the string is a PostgREST clause list that `filter-clauses.ts`
 * decodes into filter nodes the kernel expects.
 */

import { EEngineErrorCode, TEngineError, type TColumnValue, type TContainsValue, type TQueryFilter } from '../wire/types'
import { parseFilterList, parseNotArgs } from './filter-clauses'

// MARK: - Compatibility matrix pointer

const MATRIX_HINT =
  'see the local query compatibility matrix in docs/reference/javascript/fetch-data.md'

export const unsupported = (construct: string): TEngineError =>
  new TEngineError(
    EEngineErrorCode.LOCAL_UNSUPPORTED,
    `"${construct}" is not supported by the local query API (no network fallback): ${MATRIX_HINT}`,
    construct,
  )

// MARK: - Filter methods

export interface IFilterMethods<TSelf> {
  eq(column: string, value: TColumnValue): TSelf
  neq(column: string, value: TColumnValue): TSelf
  gt(column: string, value: TColumnValue): TSelf
  gte(column: string, value: TColumnValue): TSelf
  lt(column: string, value: TColumnValue): TSelf
  lte(column: string, value: TColumnValue): TSelf
  like(column: string, pattern: string): TSelf
  ilike(column: string, pattern: string): TSelf
  is(column: string, value: null | boolean): TSelf
  in(column: string, values: readonly TColumnValue[]): TSelf

  /**
   * Local jsonb/array containment (`@>`). The column may hold a JSON string
   * (array/object) or a scalar; the needle is an array, object map, or scalar.
   */
  contains(column: string, value: TContainsValue): TSelf

  /** Inverse of `.contains` (`<@`). */
  containedBy(column: string, value: TContainsValue): TSelf

  /** PostgREST-style `column.op.value,column.op.value` list (OR). */
  or(filters: string): TSelf

  /** PostgREST-style list (AND), same clause grammar as `.or()`. */
  and(filters: string): TSelf

  not(column: string, operator: string, value: unknown): TSelf
}

/**
 * `self` is a thunk rather than the builder itself: `createSelectBuilder` and
 * `createWriteBuilder` call this while still assembling their own builder
 * object (`...createFilterMethods(filters, () => builder)`), so each method
 * resolves `self()` at call time, once `builder` exists, not before.
 */
export const createFilterMethods = <TSelf>(filters: TQueryFilter[], self: () => TSelf): IFilterMethods<TSelf> => ({
  eq(column, value) {
    filters.push({ kind: 'eq', column, value })

    return self()
  },
  neq(column, value) {
    filters.push({ kind: 'neq', column, value })

    return self()
  },
  gt(column, value) {
    filters.push({ kind: 'gt', column, value })

    return self()
  },
  gte(column, value) {
    filters.push({ kind: 'gte', column, value })

    return self()
  },
  lt(column, value) {
    filters.push({ kind: 'lt', column, value })

    return self()
  },
  lte(column, value) {
    filters.push({ kind: 'lte', column, value })

    return self()
  },
  like(column, pattern) {
    filters.push({ kind: 'like', column, pattern })

    return self()
  },
  ilike(column, pattern) {
    filters.push({ kind: 'ilike', column, pattern })

    return self()
  },
  is(column, value) {
    filters.push({ kind: 'is', column, value })

    return self()
  },
  in(column, values) {
    filters.push({ kind: 'in', column, values: [...values] })

    return self()
  },
  contains(column, value) {
    filters.push({ kind: 'contains', column, value })

    return self()
  },
  containedBy(column, value) {
    filters.push({ kind: 'containedBy', column, value })

    return self()
  },
  or(expression) {
    try {
      filters.push({ kind: 'or', filters: parseFilterList(expression) })
    } catch (error) {
      throw unsupported(
        `or('${expression}') (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    return self()
  },
  and(expression) {
    try {
      filters.push({ kind: 'and', filters: parseFilterList(expression) })
    } catch (error) {
      throw unsupported(
        `and('${expression}') (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    return self()
  },
  not(column, operator, value) {
    try {
      filters.push(parseNotArgs(column, operator, value))
    } catch (error) {
      throw unsupported(
        `not('${column}', '${operator}', …) (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    return self()
  },
})
