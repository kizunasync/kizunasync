// MARK: - Local query builder

/**
 * One builder per `kizunasync.from(table)` call. A select accumulates a `TQueryPlan`
 * and hands it to the kernel's `query`; an update or a delete hands its target
 * filters to `apply_where` (`write-builder.ts`). No row is read or matched here.
 * The only TypeScript query logic is the PostgREST clause parser in
 * `filter-clauses.ts`: supabase-js forwards `.or()`, `.and()`, and `.filter()`
 * as raw strings; local reads never reach PostgREST to decode them, so
 * `filter-clauses.ts` does it. What the host does to rows the kernel answered
 * (`stripNulls()`, `csv()`, a head read) lives in `row-shaping.ts`.
 *
 * Every method postgrest-js exposes on its filter, transform, and base builder
 * classes is here. The ones with no local meaning throw a typed
 * `TEngineError(LOCAL_UNSUPPORTED)` (@../../../../CONVENTIONS.md) that names the
 * reason (`refusals.ts`), never a bare TypeError. An operand, a projection, or a
 * row cap the kernel refuses carries the same code back from there.
 *
 * The row type is static only: `returns()`, `overrideTypes()`, and the type
 * argument of `single()` and `maybeSingle()` retype the query and change
 * nothing at runtime, as in postgrest-js.
 */

import { READ_REFUSALS, createRefusals, isCountRequested, refuse, rejectReferencedTable, unsupported, type TCountOption, type TRefusals } from './refusals'
import { asRetyped, type TListMismatch, type TOverride, type TOverrideOptions, type TRowMismatch, type TUnlessHead } from './result-types'
import { parseProjection, stripNullValues, toCsv } from './row-shaping'
import { createInsertQuery, createWriteBuilder, type ILocalInsertQuery, type ILocalWriteBuilder, type IWriteOptions, type TInsertOptions } from './write-builder'
import { createFilterMethods, type IFilterMethods } from './filter-methods'
import type { TUpdateValues } from './transforms'
import type { ISyncEngine, TColumnValues, TCountedQueryResult, TQueryFilter, TQueryOrder, TQueryPlan, TQueryResult } from '../wire/types'

// MARK: - Result envelope

/** Default select: zero or more rows as an array, `null` on a head read. */
export interface ISelectResult<TRow = TColumnValues, THead extends boolean = false> {
  data: TUnlessHead<THead, TRow[]>
  error: null

  /** The rows the filters matched before `range()` and `limit()` when `select()` asked for a `count`, else `null`. */
  count: number | null
}

/** `.single()`: exactly one row (throws LOCAL_CONSTRAINT otherwise). */
export interface ISelectOneResult<TRow = TColumnValues, THead extends boolean = false> {
  data: TUnlessHead<THead, TRow>
  error: null
  count: number | null
}

/** `.maybeSingle()`: zero or one row; throws if more than one. */
export interface ISelectMaybeOneResult<TRow = TColumnValues, THead extends boolean = false> {
  data: TUnlessHead<THead, TRow | null>
  error: null
  count: number | null
}

/** `.csv()`: the rows as CSV text. */
export interface ISelectCsvResult<THead extends boolean = false> {
  data: TUnlessHead<THead, string>
  error: null
  count: number | null
}

/** The modifiers the one-row terminals keep, as postgrest-js keeps them after `single()`. */
interface IOneRowModifiers<TSelf> extends TRefusals<'setHeader'> {
  /** Return the row without its null-valued keys. */
  stripNulls(): TSelf

  /** Identity: a local read already rejects its promise on error. */
  throwOnError(): TSelf

  /** Identity: a local read has no network attempt to retry. */
  retry(enabled: boolean): TSelf
}

/** What `.single()` returns: evaluated only when awaited, to exactly one row (LOCAL_CONSTRAINT otherwise). */
export interface ISelectSingleQuery<TRow = TColumnValues, THead extends boolean = false> extends PromiseLike<ISelectOneResult<TRow, THead>>, IOneRowModifiers<ISelectSingleQuery<TRow, THead>> {
  readonly cardinality: 'single'

  /** Retype the row; the type is the whole result, one row (postgrest-js `returns`). */
  returns<TResult>(): TResult extends readonly unknown[] ? TRowMismatch : ISelectSingleQuery<TResult, THead>

  /** Retype the row by merging into its type, or replacing it with `{ merge: false }` (postgrest-js `overrideTypes`). */
  overrideTypes<TResult, TOptions extends TOverrideOptions = { merge: true }>(): TResult extends readonly unknown[] ? TRowMismatch : ISelectSingleQuery<TOverride<TRow, TResult, TOptions>, THead>
}

/** What `.maybeSingle()` returns: evaluated only when awaited, to zero or one row (LOCAL_CONSTRAINT on more). */
export interface ISelectMaybeSingleQuery<TRow = TColumnValues, THead extends boolean = false> extends PromiseLike<ISelectMaybeOneResult<TRow, THead>>, IOneRowModifiers<ISelectMaybeSingleQuery<TRow, THead>> {
  readonly cardinality: 'maybeSingle'
  returns<TResult>(): TResult extends readonly unknown[] ? TRowMismatch : ISelectMaybeSingleQuery<TResult, THead>
  overrideTypes<TResult, TOptions extends TOverrideOptions = { merge: true }>(): TResult extends readonly unknown[] ? TRowMismatch : ISelectMaybeSingleQuery<TOverride<TRow, TResult, TOptions>, THead>
}

/** What `.csv()` returns: evaluated only when awaited. */
export interface ISelectCsvQuery<THead extends boolean = false> extends PromiseLike<ISelectCsvResult<THead>>, TRefusals<'setHeader'> {
  /** Identity: a local read already rejects its promise on error. */
  throwOnError(): ISelectCsvQuery<THead>

  /** Identity: a local read has no network attempt to retry. */
  retry(enabled: boolean): ISelectCsvQuery<THead>

  /** CSV text has no null values to strip, so this throws LOCAL_UNSUPPORTED, as postgrest-js refuses it after `csv()`. */
  stripNulls(): never
}

// MARK: - Read builder

export interface ILocalSelectBuilder<TRow = TColumnValues, THead extends boolean = false>
  extends PromiseLike<ISelectResult<TRow, THead>>, TRefusals<(typeof READ_REFUSALS)[number]>, IFilterMethods<ILocalSelectBuilder<TRow, THead>> {
  /**
   * The result shape, readable before anything runs: `many` here, `single` and
   * `maybeSingle` on the two terminals, so a binding can pick its initial data.
   */
  readonly cardinality: 'many'

  /**
   * Case-insensitive substring search. With no `columns`, searches every
   * string/number column on each row.
   */
  search(query: string, options?: { columns?: string[] }): ILocalSelectBuilder<TRow, THead>

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
  ): ILocalSelectBuilder<TRow, THead>

  /**
   * `referencedTable` / the deprecated `foreignTable` order a related table's
   * columns in supabase-js; this builder has no relational embed to order, so
   * either throws LOCAL_UNSUPPORTED naming the option.
   */
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string },
  ): ILocalSelectBuilder<TRow, THead>

  /**
   * Row cap applied after the sort. A whole number is forwarded unchanged, so a
   * negative one is refused by the kernel with LOCAL_UNSUPPORTED.
   * `referencedTable` / `foreignTable` cap a related table's rows in
   * supabase-js; either throws LOCAL_UNSUPPORTED naming the option.
   */
  limit(count: number, options?: { referencedTable?: string; foreignTable?: string }): ILocalSelectBuilder<TRow, THead>

  /**
   * The rows at indexes `from` through `to`, both inclusive and counted from
   * zero after the sort, as in supabase-js: the plan skips `from` rows and keeps
   * `to - from + 1`, so a `to` one below `from` keeps none. A later `limit()`
   * replaces only the row count. A bound that is not a whole number of zero or
   * more, a `to` further below `from`, and `referencedTable` / `foreignTable`
   * throw LOCAL_UNSUPPORTED before any plan is built.
   */
  range(from: number, to: number, options?: { referencedTable?: string; foreignTable?: string }): ILocalSelectBuilder<TRow, THead>

  /**
   * Keep the rows a table's soft-delete column marks as deleted. Without it a
   * marked row is not a row: the kernel excludes it before the plan runs, so a
   * `limit` counts the rows you can see. On a table that declares no soft-delete
   * column this changes nothing.
   */
  includeDeleted(): ILocalSelectBuilder<TRow, THead>

  /** Return the rows without their null-valued keys. */
  stripNulls(): ILocalSelectBuilder<TRow, THead>

  /** Identity: a local read already rejects its promise on error. */
  throwOnError(): ILocalSelectBuilder<TRow, THead>

  /** Identity: a local read has no network attempt to retry. */
  retry(enabled: boolean): ILocalSelectBuilder<TRow, THead>

  /**
   * When `signal` aborts before the read settles, the read rejects with the
   * signal's reason (an `AbortError` DOMException when it has none) and its
   * result is discarded.
   */
  abortSignal(signal: AbortSignal): ILocalSelectBuilder<TRow, THead>

  /** Retype the rows; the type is the whole result, an array (postgrest-js `returns`). */
  returns<TResult>(): TResult extends readonly (infer TNew)[] ? ILocalSelectBuilder<TNew, THead> : TListMismatch

  /** Retype the rows by merging into their type, or replacing it with `{ merge: false }` (postgrest-js `overrideTypes`). */
  overrideTypes<TResult, TOptions extends TOverrideOptions = { merge: true }>(): TResult extends readonly (infer TNew)[] ? ILocalSelectBuilder<TOverride<TRow, TNew, TOptions>, THead> : TListMismatch

  /**
   * Terminal: the rows as CSV text, a header line of the selected columns (or
   * of every key the rows carry for `*`) and one line per row.
   */
  csv(): ISelectCsvQuery<THead>

  /**
   * Terminal: exactly one row as an object. Throws LOCAL_CONSTRAINT if 0 or
   * more than 1. Further builder chaining is not available after this call.
   * The row type comes from the type argument or the builder, never from where
   * the query is passed.
   */
  single<TOne = TRow>(): ISelectSingleQuery<NoInfer<TOne>, THead>

  /**
   * Terminal: zero or one row. Throws LOCAL_CONSTRAINT if more than one.
   * Further builder chaining is not available after this call.
   */
  maybeSingle<TOne = TRow>(): ISelectMaybeSingleQuery<NoInfer<TOne>, THead>
}

/** The builder as it runs: every row is a column map, and a head read is decided per call. */
type TRuntimeSelectBuilder = ILocalSelectBuilder<TColumnValues, boolean>

/** A `range()` bound: a whole row index, counted from zero. */
function isRowIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

interface IRangeRequest {
  from: number
  to: number
  options?: { referencedTable?: string; foreignTable?: string }
}

/**
 * The plan fields a supabase-js `range(from, to)` names. Both bounds become
 * integer wire fields, and supabase-js reads a `to` one below `from` as the
 * empty window, so nothing lower has a plan to become.
 */
function toRowWindow(request: IRangeRequest): { offset: number; limit: number } {
  const { from, to, options } = request

  if (!isRowIndex(from) || !isRowIndex(to) || to < from - 1) {
    throw unsupported(`range(${from}, ${to}) (the bounds must be whole numbers of zero or more, and to at least from - 1)`)
  }
  rejectReferencedTable('range', options)

  return { offset: from, limit: to - from + 1 }
}

interface ISelectBuilderState {
  engine: ISyncEngine
  table: string
  projection: string[] | null
  filters: TQueryFilter[]
  orders: TQueryOrder[]
  limit: number | null
  offset?: number
  includeDeleted: boolean
  isCounted: boolean
  isHead: boolean
  stripNulls: boolean
  signal?: AbortSignal
}

function plan(state: ISelectBuilderState, cardinality: TQueryPlan['cardinality']): TQueryPlan {
  const built: TQueryPlan = { filters: state.filters, orders: state.orders, cardinality }

  if (state.limit !== null) {
    built.limit = state.limit
  }
  if (state.offset !== undefined) {
    built.offset = state.offset
  }
  if (state.projection !== null) {
    built.projection = state.projection
  }
  if (state.includeDeleted) {
    built.includeDeleted = true
  }
  if (state.isCounted) {
    built.count = true
  }
  return built
}

// MARK: - Evaluation

/**
 * `QueryResult` is untagged on the wire: an array, one row, or a row and null,
 * wrapped as `{ rows, count }` when the plan asked for a count. The plan's own
 * cardinality and count name the arm, so each terminal reads the shape it
 * asked for.
 */
interface IAnswer<TRows> {
  rows: TRows
  count: number | null
}

/** The error an aborted read rejects with when its signal carries no reason. */
function createAbortError(): Error {
  const message = 'The local read was aborted'

  return typeof DOMException === 'function' ? new DOMException(message, 'AbortError') : Object.assign(new Error(message), { name: 'AbortError' })
}

/** `read`, rejected with the signal's reason instead when `signal` aborts first; a later answer is discarded. */
function raceAbort<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return read
  }
  const reason = (): unknown => (signal.reason as unknown) ?? createAbortError()

  if (signal.aborted) {
    void read.catch(() => undefined)

    return Promise.reject(reason())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(reason())

    signal.addEventListener('abort', onAbort, { once: true })
    read.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function readAnswer<TRows>(state: ISelectBuilderState, cardinality: TQueryPlan['cardinality']): Promise<IAnswer<TRows>> {
  const answer: TQueryResult = await state.engine.query(state.table, plan(state, cardinality))

  if (!state.isCounted) {
    return { rows: answer as TRows, count: null }
  }
  const counted = answer as TCountedQueryResult

  return { rows: counted.rows as TRows, count: counted.count }
}

function stripRow(state: ISelectBuilderState, row: TColumnValues | null): TColumnValues | null {
  return state.stripNulls && row !== null ? stripNullValues(row) : row
}

async function evaluateMany(state: ISelectBuilderState): Promise<ISelectResult<TColumnValues, boolean>> {
  const { rows, count } = await readAnswer<TColumnValues[]>(state, 'many')
  const shaped = state.stripNulls ? rows.map(stripNullValues) : rows

  return { data: state.isHead ? null : shaped, error: null, count }
}

async function evaluateOne(state: ISelectBuilderState): Promise<ISelectOneResult<TColumnValues, boolean>> {
  const { rows, count } = await readAnswer<TColumnValues>(state, 'single')

  return { data: state.isHead ? null : stripRow(state, rows), error: null, count }
}

async function evaluateMaybeOne(state: ISelectBuilderState): Promise<ISelectMaybeOneResult<TColumnValues, boolean>> {
  const { rows, count } = await readAnswer<TColumnValues | null>(state, 'maybeSingle')

  return { data: state.isHead ? null : stripRow(state, rows), error: null, count }
}

async function evaluateCsv(state: ISelectBuilderState): Promise<ISelectCsvResult<boolean>> {
  const { rows, count } = await readAnswer<TColumnValues[]>(state, 'many')

  return { data: state.isHead ? null : toCsv(rows, state.projection), error: null, count }
}

// MARK: - Terminals

function createSingleQuery(state: ISelectBuilderState): ISelectSingleQuery<TColumnValues, boolean> {
  const query: ISelectSingleQuery<TColumnValues, boolean> = {
    ...createRefusals(['setHeader']),
    cardinality: 'single',
    stripNulls() {
      state.stripNulls = true

      return query
    },
    throwOnError: () => query,
    retry: () => query,
    returns: () => asRetyped(query),
    overrideTypes: () => asRetyped(query),
    then: (onfulfilled, onrejected) => raceAbort(evaluateOne(state), state.signal).then(onfulfilled, onrejected),
  }

  return query
}

function createMaybeSingleQuery(state: ISelectBuilderState): ISelectMaybeSingleQuery<TColumnValues, boolean> {
  const query: ISelectMaybeSingleQuery<TColumnValues, boolean> = {
    ...createRefusals(['setHeader']),
    cardinality: 'maybeSingle',
    stripNulls() {
      state.stripNulls = true

      return query
    },
    throwOnError: () => query,
    retry: () => query,
    returns: () => asRetyped(query),
    overrideTypes: () => asRetyped(query),
    then: (onfulfilled, onrejected) => raceAbort(evaluateMaybeOne(state), state.signal).then(onfulfilled, onrejected),
  }

  return query
}

function createCsvQuery(state: ISelectBuilderState): ISelectCsvQuery<boolean> {
  const query: ISelectCsvQuery<boolean> = {
    ...createRefusals(['setHeader']),
    throwOnError: () => query,
    retry: () => query,
    stripNulls(): never {
      throw unsupported('stripNulls() (csv() answers text, which has no null values to strip)')
    },
    then: (onfulfilled, onrejected) => raceAbort(evaluateCsv(state), state.signal).then(onfulfilled, onrejected),
  }

  return query
}

// MARK: - Builder pieces

type TSelectPiece<TKey extends keyof TRuntimeSelectBuilder> = Pick<TRuntimeSelectBuilder, TKey>

/** The read-only filters: the two searches and the soft-delete lift. */
function createReadFilters(state: ISelectBuilderState, self: () => TRuntimeSelectBuilder): TSelectPiece<'search' | 'textSearch' | 'includeDeleted'> {
  return {
    search(query, options) {
      state.filters.push({ kind: 'search', query, columns: options?.columns ?? null })

      return self()
    },
    textSearch(column, query, options) {
      state.filters.push({ kind: 'textSearch', column, query, type: options?.type ?? 'plain' })

      return self()
    },
    includeDeleted() {
      state.includeDeleted = true

      return self()
    },
  }
}

/** The modifiers that shape the plan: sort, cap, and page. */
function createModifiers(state: ISelectBuilderState, self: () => TRuntimeSelectBuilder): TSelectPiece<'order' | 'limit' | 'range'> {
  return {
    order(column, options) {
      rejectReferencedTable('order', options)
      const ascending = options?.ascending ?? true
      const nullsFirst = options?.nullsFirst ?? !ascending

      state.orders.push({ column, ascending, nullsFirst })

      return self()
    },
    limit(count, options) {
      // The wire limit field is an integer, so a fractional cap has no field to travel in; a negative integer does, and the kernel is the one that refuses it.
      if (!Number.isInteger(count)) {
        throw unsupported(`limit(${count}) (the row cap must be a whole number)`)
      }
      rejectReferencedTable('limit', options)
      state.limit = count

      return self()
    },
    range(from, to, options) {
      Object.assign(state, toRowWindow({ from, to, options }))

      return self()
    },
  }
}

/** The transforms that change what comes back, or only its static type. */
function createTransforms(
  state: ISelectBuilderState,
  self: () => TRuntimeSelectBuilder,
): TSelectPiece<'stripNulls' | 'throwOnError' | 'retry' | 'abortSignal' | 'returns' | 'overrideTypes'> {
  return {
    stripNulls() {
      state.stripNulls = true

      return self()
    },
    throwOnError: () => self(),
    retry: () => self(),
    abortSignal(signal) {
      state.signal = signal

      return self()
    },
    returns: () => asRetyped(self()),
    overrideTypes: () => asRetyped(self()),
  }
}

interface ICreateSelectBuilderOptions {
  engine: ISyncEngine
  table: string
  projection: string[] | null
  isCounted: boolean
  isHead: boolean
}

const createSelectBuilder = (options: ICreateSelectBuilderOptions): TRuntimeSelectBuilder => {
  const state: ISelectBuilderState = { ...options, filters: [], orders: [], limit: null, includeDeleted: false, stripNulls: false }
  const self = (): TRuntimeSelectBuilder => builder

  const builder: TRuntimeSelectBuilder = {
    ...createRefusals(READ_REFUSALS),
    ...createFilterMethods(state.filters, self),
    ...createReadFilters(state, self),
    ...createModifiers(state, self),
    ...createTransforms(state, self),
    cardinality: 'many',
    csv: () => createCsvQuery(state),
    single: () => asRetyped(createSingleQuery(state)),
    maybeSingle: () => asRetyped(createMaybeSingleQuery(state)),
    then: (onfulfilled, onrejected) => raceAbort(evaluateMany(state), state.signal).then(onfulfilled, onrejected),
  }

  return builder
}

// MARK: - Per-table entry builder

/** supabase-js `select()` options: any `count` mode answers the exact local count, and `head` answers the count without rows. */
export interface ISelectOptions<THead extends boolean = false> {
  head?: THead
  count?: TCountOption | (string & {})
}

export interface ILocalFromBuilder {
  insert(values: TColumnValues, options?: TInsertOptions): ILocalInsertQuery
  update(values: TUpdateValues, options?: IWriteOptions): ILocalWriteBuilder
  delete(options?: IWriteOptions): ILocalWriteBuilder
  select<THead extends boolean = false>(columns?: string, options?: ISelectOptions<THead>): ILocalSelectBuilder<TColumnValues, THead>
  upsert(values?: unknown, options?: unknown): never
  rpc(name?: unknown): never
}

/** The engine a `from(table)` builder writes through, the table, its key columns, and the uuid source an `id` key mints from. */
export interface ICreateFromBuilderOptions {
  engine: ISyncEngine
  table: string
  key: readonly string[]
  uuid: () => string
}

export const createFromBuilder = (input: ICreateFromBuilderOptions): ILocalFromBuilder => {
  const { engine, table, key, uuid } = input

  return {
    insert: (values, options) => createInsertQuery({ engine, table, key, values, options, uuid }),
    update: (values, options) => createWriteBuilder({ engine, table, key, op: 'update', columns: values, options }),
    delete: (options) => createWriteBuilder({ engine, table, key, op: 'delete', columns: {}, options }),
    select(columns, options) {
      const isCounted = isCountRequested('select', options?.count)

      return asRetyped(createSelectBuilder({ engine, table, projection: parseProjection(columns), isCounted, isHead: options?.head === true }))
    },
    upsert: () => refuse('upsert'),
    rpc: () => refuse('rpc'),
  }
}
