// MARK: - Local query builder

/**
 * One builder per `kizunasync.from(table)` call. A select accumulates a `TQueryPlan`
 * and hands it to the kernel's `query`; an update or a delete hands its target
 * filters to `apply_where`, which resolves the rows and applies one mutation to
 * each. No row is read or matched here. The only TypeScript query logic is the
 * PostgREST clause parser in `filter-clauses.ts`: supabase-js forwards `.or()`
 * and `.and()` as raw strings; local reads never reach PostgREST to decode
 * them, so `filter-clauses.ts` does it.
 *
 * Constructs outside the local subset throw a typed
 * `TEngineError(LOCAL_UNSUPPORTED)` (@../../../../CONVENTIONS.md). The operators
 * below are refused here because they never reach a plan at all; an operand, a
 * projection, or a row cap the kernel refuses carries the same code back from
 * there.
 *
 * Supported reads: select, eq, neq, gt, gte, lt, lte, like, ilike, is, in,
 * contains, containedBy, or, and, not, search, textSearch (plain|phrase|
 * websearch), order, limit, single, maybeSingle. Writes: insert / update /
 * delete with comparison / boolean / like / in / contains filters for target
 * selection (at least one filter required). Unsupported: rpc, upsert,
 * relational embeds, range / overlaps / match / filter / csv, every other
 * method `node_modules/@supabase/postgrest-js` exposes on its filter,
 * transform, and base builder classes (`likeAllOf`, `regexMatch`, `isDistinct`,
 * `notIn`, `rangeGt`..`rangeAdjacent`, `abortSignal`, `geojson`, `explain`,
 * `rollback`, `maxAffected`, `returns`, `overrideTypes`, `throwOnError`,
 * `stripNulls`, `setHeader`, `retry`, a write's `.select()`), and the
 * `count` / `head` / `referencedTable` / `foreignTable` / `defaultToNull`
 * options those methods ignore, refused by name rather than accepted or
 * raised as a bare TypeError (D4, the reference Errors tables list them).
 */

import { EEngineErrorCode, TEngineError, type ISyncEngine, type TApplyWhereRequest, type TColumnValues, type TQueryFilter, type TQueryOrder, type TQueryPlan } from '../wire/types'
import { PK_COLUMN, splitAssignsAndTransforms, type TUpdateValues } from './transforms'
import { createFilterMethods, unsupported, type IFilterMethods } from './filter-methods'

// MARK: - Unsupported supabase-js operators

const UNSUPPORTED_OPERATORS = [
  'range', 'overlaps', 'match', 'filter', 'csv',
  'likeAllOf', 'likeAnyOf', 'ilikeAllOf', 'ilikeAnyOf',
  'regexMatch', 'regexIMatch', 'isDistinct', 'notIn',
  'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent',
  'abortSignal', 'geojson', 'explain', 'rollback', 'maxAffected',
  'returns', 'overrideTypes', 'throwOnError', 'stripNulls', 'setHeader', 'retry',
  'select',
] as const

type TUnsupportedOperator = (typeof UNSUPPORTED_OPERATORS)[number]

type TUnsupportedOperators = { [K in TUnsupportedOperator]: (...args: unknown[]) => never }

const unsupportedOperators = (): TUnsupportedOperators => {
  const stubs = {} as TUnsupportedOperators

  for (const name of UNSUPPORTED_OPERATORS) {
    stubs[name] = (): never => {
      throw unsupported(`${name}()`)
    }
  }
  return stubs
}

/** Throws LOCAL_UNSUPPORTED naming a supabase-js option this builder ignores rather than honours. */
const rejectOption = (call: string, key: string): never => {
  throw unsupported(`${call}({ ${key} })`)
}

/** `order()` and `limit()` share this supabase-js pair: no relational embed to order or cap here. */
const rejectReferencedTable = (
  call: string,
  options?: { referencedTable?: string; foreignTable?: string },
): void => {
  if (options?.referencedTable !== undefined) {
    rejectOption(call, 'referencedTable')
  }
  if (options?.foreignTable !== undefined) {
    rejectOption(call, 'foreignTable')
  }
}

// MARK: - Result envelope

/** Default select: zero or more rows as an array. */
export interface ISelectResult {
  data: TColumnValues[]
  error: null
}

/** `.single()`: exactly one row (throws LOCAL_CONSTRAINT otherwise). */
export interface ISelectOneResult {
  data: TColumnValues
  error: null
}

/** `.maybeSingle()`: zero or one row; throws if more than one. */
export interface ISelectMaybeOneResult {
  data: TColumnValues | null
  error: null
}

export interface IWriteResult {
  data: null
  error: null
}

// MARK: - Read builder

export interface ILocalSelectBuilder extends PromiseLike<ISelectResult>, TUnsupportedOperators, IFilterMethods<ILocalSelectBuilder> {
  /**
   * Case-insensitive substring search. With no `columns`, searches every
   * string/number column on each row.
   */
  search(query: string, options?: { columns?: string[] }): ILocalSelectBuilder

  /**
   * Column-scoped local full-text stand-in (not Postgres FTS / FTS5 / tsvector).
   * `plain` (default): all whitespace tokens must appear (order-independent).
   * `phrase`: the full query string must appear. `websearch`: like plain, plus
   * `"quoted phrases"` as indivisible needles.
   */
  textSearch(
    column: string,
    query: string,
    options?: { type?: 'plain' | 'phrase' | 'websearch' },
  ): ILocalSelectBuilder

  /**
   * `referencedTable` / the deprecated `foreignTable` order a related table's
   * columns in supabase-js; this builder has no relational embed to order, so
   * either throws LOCAL_UNSUPPORTED naming the option.
   */
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string },
  ): ILocalSelectBuilder

  /**
   * Row cap applied after the sort. A whole number is forwarded unchanged, so a
   * negative one is refused by the kernel with LOCAL_UNSUPPORTED.
   * `referencedTable` / `foreignTable` cap a related table's rows in
   * supabase-js; either throws LOCAL_UNSUPPORTED naming the option.
   */
  limit(count: number, options?: { referencedTable?: string; foreignTable?: string }): ILocalSelectBuilder

  /**
   * Keep the rows a table's soft-delete column marks as deleted. Without it a
   * marked row is not a row: the kernel excludes it before the plan runs, so a
   * `limit` counts the rows you can see. On a table that declares no soft-delete
   * column this changes nothing.
   */
  includeDeleted(): ILocalSelectBuilder

  /**
   * Terminal: exactly one row as an object. Throws LOCAL_CONSTRAINT if 0 or
   * more than 1. Further builder chaining is not available after this call.
   */
  single(): PromiseLike<ISelectOneResult>

  /**
   * Terminal: zero or one row. Throws LOCAL_CONSTRAINT if more than one.
   * Further builder chaining is not available after this call.
   */
  maybeSingle(): PromiseLike<ISelectMaybeOneResult>
}

/**
 * `select()` and `select('*')` keep every column. Anything else is a column
 * list: an embed, a rename and an empty segment are the kernel's to judge, so
 * the string is only split and trimmed here.
 */
const parseProjection = (columns?: string): string[] | null => {
  if (columns === undefined || columns.trim() === '' || columns.trim() === '*') {
    return null
  }
  return columns.split(',').map((column) => column.trim())
}

interface ISelectBuilderState {
  engine: ISyncEngine
  table: string
  projection: string[] | null
  filters: TQueryFilter[]
  orders: TQueryOrder[]
  limit: number | null
  includeDeleted: boolean
}

function plan(state: ISelectBuilderState, cardinality: TQueryPlan['cardinality']): TQueryPlan {
  const built: TQueryPlan = { filters: state.filters, orders: state.orders, cardinality }

  if (state.limit !== null) {
    built.limit = state.limit
  }
  if (state.projection !== null) {
    built.projection = state.projection
  }
  if (state.includeDeleted) {
    built.includeDeleted = true
  }
  return built
}

/**
 * `QueryResult` is untagged on the wire: an array, one row, or a row and null.
 * The plan's own cardinality is what names the arm, so each terminal reads the
 * shape it asked for.
 */
async function evaluateMany(state: ISelectBuilderState): Promise<ISelectResult> {
  const rows = (await state.engine.query(state.table, plan(state, 'many'))) as TColumnValues[]

  return { data: rows, error: null }
}

async function evaluateOne(state: ISelectBuilderState): Promise<ISelectOneResult> {
  const row = (await state.engine.query(state.table, plan(state, 'single'))) as TColumnValues

  return { data: row, error: null }
}

async function evaluateMaybeOne(state: ISelectBuilderState): Promise<ISelectMaybeOneResult> {
  const row = (await state.engine.query(state.table, plan(state, 'maybeSingle'))) as TColumnValues | null

  return { data: row, error: null }
}

const createSelectBuilder = (
  engine: ISyncEngine,
  table: string,
  projection: string[] | null,
): ILocalSelectBuilder => {
  const state: ISelectBuilderState = {
    engine,
    table,
    projection,
    filters: [],
    orders: [],
    limit: null,
    includeDeleted: false,
  }

  const builder: ILocalSelectBuilder = {
    ...unsupportedOperators(),
    ...createFilterMethods(state.filters, () => builder),
    search(query, options) {
      state.filters.push({
        kind: 'search',
        query,
        columns: options?.columns ?? null,
      })

      return builder
    },
    textSearch(column, query, options) {
      state.filters.push({
        kind: 'textSearch',
        column,
        query,
        type: options?.type ?? 'plain',
      })

      return builder
    },
    order(column, options) {
      rejectReferencedTable('order', options)
      const ascending = options?.ascending ?? true
      const nullsFirst = options?.nullsFirst ?? !ascending

      state.orders.push({ column, ascending, nullsFirst })

      return builder
    },
    limit(count, options) {
      // The wire limit field is an integer, so a fractional cap has no field to travel in; a negative integer does, and the kernel is the one that refuses it.
      if (!Number.isInteger(count)) {
        throw unsupported(`limit(${count}) (the row cap must be a whole number)`)
      }
      rejectReferencedTable('limit', options)
      state.limit = count

      return builder
    },
    includeDeleted() {
      state.includeDeleted = true

      return builder
    },
    single() {
      return {
        then(onfulfilled, onrejected) {
          return evaluateOne(state).then(onfulfilled, onrejected)
        },
      }
    },
    maybeSingle() {
      return {
        then(onfulfilled, onrejected) {
          return evaluateMaybeOne(state).then(onfulfilled, onrejected)
        },
      }
    },
    then(onfulfilled, onrejected) {
      return evaluateMany(state).then(onfulfilled, onrejected)
    },
  }

  return builder
}

// MARK: - Write builder

export interface IWriteOptions {
  precondition?: TColumnValues

  /** supabase-js row-count algorithm; this builder returns no count, so any value throws LOCAL_UNSUPPORTED. */
  count?: 'exact' | 'planned' | 'estimated' | (string & {})
}

export interface ILocalWriteBuilder extends PromiseLike<IWriteResult>, TUnsupportedOperators, IFilterMethods<ILocalWriteBuilder> {
  /**
   * Target the rows a table's soft-delete column marks as deleted too. Without
   * it they are no more write targets than they are read results.
   */
  includeDeleted(): ILocalWriteBuilder
}

interface ICreateWriteBuilderOptions {
  engine: ISyncEngine
  table: string
  op: 'delete' | 'update'
  columns: TUpdateValues
  precondition: TColumnValues | undefined
}

const createWriteBuilder = (options: ICreateWriteBuilderOptions): ILocalWriteBuilder => {
  const { engine, table, op, columns, precondition } = options
  const filters: TQueryFilter[] = []
  let deletedIncluded = false

  const execute = async (): Promise<void> => {
    const { columns: assigns, transforms } =
      op === 'update'
        ? splitAssignsAndTransforms(columns as Record<string, unknown>, table)
        : { columns: {}, transforms: {} }
    const request: TApplyWhereRequest = { table, op, filters, columns: assigns }

    if (Object.keys(transforms).length > 0) {
      request.transforms = transforms
    }
    if (precondition !== undefined) {
      request.precondition = precondition
    }
    if (deletedIncluded) {
      request.includeDeleted = true
    }
    await engine.applyWhere(request)
  }

  const builder: ILocalWriteBuilder = {
    ...unsupportedOperators(),
    ...createFilterMethods(filters, () => builder),
    includeDeleted() {
      deletedIncluded = true

      return builder
    },
    then(onfulfilled, onrejected) {
      return execute()
        .then(() => ({ data: null, error: null as null }))
        .then(onfulfilled, onrejected)
    },
  }

  return builder
}

// MARK: - Per-table entry builder

/** supabase-js insert/upsert options this builder never applies (no server-computed count, no column defaults to fall back to). */
export type TInsertOptions = {
  count?: 'exact' | 'planned' | 'estimated' | (string & {})
  defaultToNull?: boolean
}

export interface ILocalFromBuilder {
  insert(values: TColumnValues, options?: TInsertOptions): Promise<IWriteResult>
  update(values: TUpdateValues, options?: IWriteOptions): ILocalWriteBuilder
  delete(options?: IWriteOptions): ILocalWriteBuilder
  select(columns?: string, options?: { head?: boolean; count?: 'exact' | 'planned' | 'estimated' | (string & {}) }): ILocalSelectBuilder
  upsert(values?: unknown, options?: unknown): never
  rpc(name?: unknown): never
}

export const createFromBuilder = (
  engine: ISyncEngine,
  table: string,
  uuid: () => string,
): ILocalFromBuilder => ({
  async insert(values, options) {
    if (options?.count !== undefined) {
      rejectOption('insert', 'count')
    }
    if (options?.defaultToNull !== undefined) {
      rejectOption('insert', 'defaultToNull')
    }
    const pkValue = values[PK_COLUMN]

    if (PK_COLUMN in values && pkValue !== undefined && typeof pkValue !== 'string') {
      throw new TEngineError(
        EEngineErrorCode.LOCAL_CONSTRAINT,
        `insert into "${table}": "${PK_COLUMN}" must be a uuid string, got ${typeof pkValue}`,
        { table },
      )
    }
    // The columns go out as the caller wrote them: an `id` equal to the pk is an ordinary column, and the kernel refuses one that disagrees.
    const pk = typeof pkValue === 'string' && pkValue.length > 0 ? pkValue : uuid()

    await engine.apply({ table, pk, op: 'insert', columns: values })

    return { data: null, error: null }
  },
  update(values, options) {
    if (options?.count !== undefined) {
      rejectOption('update', 'count')
    }
    return createWriteBuilder({ engine, table, op: 'update', columns: values, precondition: options?.precondition })
  },
  delete(options) {
    if (options?.count !== undefined) {
      rejectOption('delete', 'count')
    }
    return createWriteBuilder({ engine, table, op: 'delete', columns: {}, precondition: options?.precondition })
  },
  select(columns, options) {
    if (options?.head !== undefined) {
      rejectOption('select', 'head')
    }
    if (options?.count !== undefined) {
      rejectOption('select', 'count')
    }
    return createSelectBuilder(engine, table, parseProjection(columns))
  },
  upsert() {
    throw unsupported('upsert()')
  },
  rpc() {
    throw unsupported('rpc()')
  },
})
