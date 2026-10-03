// MARK: - Shared filter methods for the select/write builders

/**
 * `createSelectBuilder` and `createWriteBuilder` both expose the same
 * supabase-js filter surface; this factory is their one implementation, spread
 * into each builder's object literal so a new operator is added once. `.or()`,
 * `.and()`, and `.filter()` accept strings because that is the supabase-js API
 * shape; the string is a PostgREST clause list that `filter-clauses.ts` decodes
 * into filter nodes the kernel expects.
 */

import type { TColumnValue, TContainsValue, TQueryFilter } from '../wire/types'
import { parseFilterClause, parseFilterList, parseNotArgs } from './filter-clauses'
import { rejectReferencedTable, unsupported } from './refusals'

// MARK: - Filter methods

export interface IFilterMethods<TSelf> extends ICompositeFilterMethods<TSelf> {
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

  /**
   * PostgREST-style `column.op.value,column.op.value` list (OR).
   * `referencedTable` / `foreignTable` throw LOCAL_UNSUPPORTED: there is no
   * embedded table to address.
   */
  or(filters: string, options?: { referencedTable?: string; foreignTable?: string }): TSelf

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
  ...createCompositeFilterMethods(filters, self),
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
  or(expression, options) {
    rejectReferencedTable('or', options)
    filters.push(parseOrRefuse(`or('${expression}')`, () => ({ kind: 'or', filters: parseFilterList(expression) })))

    return self()
  },
  and(expression) {
    filters.push(parseOrRefuse(`and('${expression}')`, () => ({ kind: 'and', filters: parseFilterList(expression) })))

    return self()
  },
  not(column, operator, value) {
    filters.push(parseOrRefuse(`not('${column}', '${operator}', …)`, () => parseNotArgs(column, operator, value)))

    return self()
  },
})

/** The node `parse` decodes, or LOCAL_UNSUPPORTED naming `construct` and why the clause parser refused it. */
function parseOrRefuse(construct: string, parse: () => TQueryFilter): TQueryFilter {
  try {
    return parse()
  } catch (error) {
    throw unsupported(`${construct} (${error instanceof Error ? error.message : String(error)})`)
  }
}

// MARK: - Composite filter methods

/**
 * The supabase-js filters that build on the nodes above: `match`, `filter`,
 * the pattern lists, and `notIn` compose them, and `regexMatch`,
 * `regexIMatch`, `isDistinct`, and `overlaps` are kernel nodes of their own.
 */
export interface ICompositeFilterMethods<TSelf> {
  /**
   * `eq` on every key whose value is not `undefined`, combined with AND. An
   * empty object matches every row on a read; a write refuses it, as it
   * refuses any filter that names no rows.
   */
  match(query: Readonly<Record<string, TColumnValue | undefined>>): TSelf

  /**
   * One PostgREST clause, `column.operator.value`, decoded as an `.or()`
   * clause is, so it takes the operators `.or()` takes, a `not.` prefix
   * included.
   */
  filter(column: string, operator: string, value: unknown): TSelf

  /** `like` against any of `patterns`. An empty list matches no row on a read. */
  likeAnyOf(column: string, patterns: readonly string[]): TSelf

  /** `like` against every one of `patterns`. An empty list matches every row on a read. */
  likeAllOf(column: string, patterns: readonly string[]): TSelf

  /** Case-insensitive {@link ICompositeFilterMethods.likeAnyOf}. */
  ilikeAnyOf(column: string, patterns: readonly string[]): TSelf

  /** Case-insensitive {@link ICompositeFilterMethods.likeAllOf}. */
  ilikeAllOf(column: string, patterns: readonly string[]): TSelf

  /** The negation of `in`: a null cell, or a null among `values`, keeps the row out, as SQL `NOT IN` does. */
  notIn(column: string, values: readonly TColumnValue[]): TSelf

  /** Postgres `~`: the pattern matches somewhere in the cell's text. Backreferences and lookaround throw LOCAL_UNSUPPORTED when the read runs. */
  regexMatch(column: string, pattern: string): TSelf

  /** Case-insensitive {@link ICompositeFilterMethods.regexMatch}, Postgres `~*`. */
  regexIMatch(column: string, pattern: string): TSelf

  /** `IS DISTINCT FROM`: `neq` that treats null as a value, so a null cell differs from any non-null `value`. */
  isDistinct(column: string, value: TColumnValue): TSelf

  /**
   * Postgres `&&` on an array column: the cell shares an element with `value`,
   * an array or text that parses as a JSON array. A range literal throws
   * LOCAL_UNSUPPORTED when the read runs.
   */
  overlaps(column: string, value: string | readonly TContainsValue[]): TSelf
}

/** One `like` or `ilike` node per pattern, under `or` for AnyOf and `and` for AllOf. */
function patternList(kind: 'like' | 'ilike', column: string, patterns: readonly string[]): TQueryFilter[] {
  return patterns.map((pattern) => ({ kind, column, pattern }))
}

export const createCompositeFilterMethods = <TSelf>(filters: TQueryFilter[], self: () => TSelf): ICompositeFilterMethods<TSelf> => {
  const push = (filter: TQueryFilter): TSelf => {
    filters.push(filter)

    return self()
  }

  return {
    match: (query) =>
      push({
        kind: 'and',
        filters: Object.entries(query).flatMap(([column, value]) => (value === undefined ? [] : [{ kind: 'eq' as const, column, value }])),
      }),
    filter: (column, operator, value) => push(parseOrRefuse(`filter('${column}', '${operator}', …)`, () => parseFilterClause(`${column}.${operator}.${String(value)}`))),
    likeAnyOf: (column, patterns) => push({ kind: 'or', filters: patternList('like', column, patterns) }),
    likeAllOf: (column, patterns) => push({ kind: 'and', filters: patternList('like', column, patterns) }),
    ilikeAnyOf: (column, patterns) => push({ kind: 'or', filters: patternList('ilike', column, patterns) }),
    ilikeAllOf: (column, patterns) => push({ kind: 'and', filters: patternList('ilike', column, patterns) }),
    notIn: (column, values) => push({ kind: 'not', filter: { kind: 'in', column, values: [...values] } }),
    regexMatch: (column, pattern) => push({ kind: 'regexMatch', column, pattern }),
    regexIMatch: (column, pattern) => push({ kind: 'regexIMatch', column, pattern }),
    isDistinct: (column, value) => push({ kind: 'isDistinct', column, value }),
    overlaps: (column, value) => push({ kind: 'overlaps', column, value }),
  }
}
