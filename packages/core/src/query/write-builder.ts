// MARK: - Local write builders

/**
 * `update()` and `delete()` hand their target filters to the kernel's
 * `apply_where`, which resolves the rows and applies one mutation to each;
 * `insert()` applies one row through `apply`. A `select()` after a write asks
 * for the rows it reached: `apply_where` returns an update's rows as they read
 * after it and a delete's as they read before it, and an insert reads its row
 * back by its key columns. The column list is judged and applied here, since
 * the kernel returns whole rows.
 */

import { EEngineErrorCode, TEngineError, type ISyncEngine, type TApplyWhereRequest, type TColumnValues, type TQueryFilter } from '../wire/types'
import { createFilterMethods, type IFilterMethods } from './filter-methods'
import { WRITE_REFUSALS, WRITE_SELECT_REFUSALS, createRefusals, isCountRequested, rejectOption, unsupported, type TCountOption, type TRefusals } from './refusals'
import { asRetyped, type TListMismatch, type TOverride, type TOverrideOptions } from './result-types'
import { parseReturnedColumns, projectRow, stripNullValues } from './row-shaping'
import { keyFilters, mintsKey, toStoredKey } from './row-key'
import { splitAssignsAndTransforms, type TUpdateValues } from './transforms'

// MARK: - Result envelope

export interface IWriteResult {
  data: null
  error: null

  /** How many rows the write reached when its options asked for a `count`, else `null`. */
  count: number | null
}

/** A write chained with `select()`: the rows it reached, cut to the columns `select()` named. */
export interface IWriteRowsResult<TRow = TColumnValues> {
  data: TRow[]
  error: null
  count: number | null
}

/** A write chained with `select().single()`. */
export interface IWriteOneResult<TRow = TColumnValues> {
  data: TRow
  error: null
  count: number | null
}

/** A write chained with `select().maybeSingle()`. */
export interface IWriteMaybeOneResult<TRow = TColumnValues> {
  data: TRow | null
  error: null
  count: number | null
}

// MARK: - Options

export interface IWriteOptions {
  precondition?: TColumnValues

  /** supabase-js row-count algorithm. Each of the three answers, in `count`, the exact number of rows the write reached. */
  count?: TCountOption | (string & {})
}

/** supabase-js insert and upsert options. `count` answers 1; the rest throw LOCAL_UNSUPPORTED naming why. */
export type TInsertOptions = {
  count?: TCountOption | (string & {})
  defaultToNull?: boolean
  onConflict?: string
  ignoreDuplicates?: boolean
}

// MARK: - Update and delete

export interface ILocalWriteBuilder extends PromiseLike<IWriteResult>, TRefusals<(typeof WRITE_REFUSALS)[number]>, IFilterMethods<ILocalWriteBuilder> {
  /**
   * Target the rows a table's soft-delete column marks as deleted too. Without
   * it they are no more write targets than they are read results.
   */
  includeDeleted(): ILocalWriteBuilder

  /**
   * The most rows the write may reach. When the filters match more, nothing is
   * written and the call fails LOCAL_CONSTRAINT naming the match count and
   * the cap.
   */
  maxAffected(count: number): ILocalWriteBuilder

  /** Identity: a local write already rejects its promise on error. */
  throwOnError(): ILocalWriteBuilder

  /** Identity: a local write has no network attempt to retry. */
  retry(enabled: boolean): ILocalWriteBuilder

  /**
   * Return the rows the write reached, cut to `columns`: an update's as they
   * read after it, a delete's as they read before it. An embed or a rename in
   * `columns` throws LOCAL_UNSUPPORTED before anything is written.
   */
  select<TRow = TColumnValues>(columns?: string): ILocalWriteSelectBuilder<NoInfer<TRow>>

  /** A write has no row window to page, so `range()` stays refused by name here while a read accepts it. */
  range(...args: unknown[]): never
}

/** An update or a delete chained with `select()`. */
export interface ILocalWriteSelectBuilder<TRow = TColumnValues> extends PromiseLike<IWriteRowsResult<TRow>>, TRefusals<(typeof WRITE_SELECT_REFUSALS)[number]>, IFilterMethods<ILocalWriteSelectBuilder<TRow>> {
  includeDeleted(): ILocalWriteSelectBuilder<TRow>
  maxAffected(count: number): ILocalWriteSelectBuilder<TRow>
  throwOnError(): ILocalWriteSelectBuilder<TRow>
  retry(enabled: boolean): ILocalWriteSelectBuilder<TRow>

  /** Return the rows without their null-valued keys. */
  stripNulls(): ILocalWriteSelectBuilder<TRow>

  /** Retype the rows; the type is the whole result, an array (postgrest-js `returns`). */
  returns<TResult>(): TResult extends readonly (infer TNew)[] ? ILocalWriteSelectBuilder<TNew> : TListMismatch

  /** Retype the rows by merging into their type, or replacing it with `{ merge: false }` (postgrest-js `overrideTypes`). */
  overrideTypes<TResult, TOptions extends TOverrideOptions = { merge: true }>(): TResult extends readonly (infer TNew)[] ? ILocalWriteSelectBuilder<TOverride<TRow, TNew, TOptions>> : TListMismatch

  /**
   * Exactly one row. A write whose filters match another count writes nothing
   * and throws LOCAL_CONSTRAINT with the message a read gives
   * (`single() requires exactly one row; got N`).
   */
  single<TOne = TRow>(): PromiseLike<IWriteOneResult<NoInfer<TOne>>>

  /** Zero or one row. A write whose filters match more writes nothing, and throws as `single()` does. */
  maybeSingle<TOne = TRow>(): PromiseLike<IWriteMaybeOneResult<NoInfer<TOne>>>

  range(...args: unknown[]): never
}

interface IWriteState {
  engine: ISyncEngine
  table: string
  key: readonly string[]
  op: 'delete' | 'update'
  columns: TUpdateValues
  precondition: TColumnValues | undefined
  isCounted: boolean
  filters: TQueryFilter[]
  includeDeleted: boolean
  maxAffected?: number
  returned?: string[] | null
  stripNulls: boolean
}

/** The wire field is an unsigned 32-bit integer. */
const MAX_AFFECTED_CAP = 4_294_967_295

function toMaxAffected(count: number): number {
  if (!Number.isInteger(count) || count < 0 || count > MAX_AFFECTED_CAP) {
    throw unsupported(`maxAffected(${count}) (the cap must be a whole number from 0 to ${MAX_AFFECTED_CAP})`)
  }
  return count
}

/** The one-row terminal a write's `select()` ends in, if any. */
type TWriteCardinality = TApplyWhereRequest['cardinality']

/** The kernel request one write sends, with the one-row terminal it ends in. */
function toApplyWhereRequest(state: IWriteState, cardinality?: TWriteCardinality): TApplyWhereRequest {
  const { columns: assigns, transforms } =
    state.op === 'update' ? splitAssignsAndTransforms({ values: state.columns as Record<string, unknown>, table: state.table, key: state.key }) : { columns: {}, transforms: {} }
  const request: TApplyWhereRequest = { table: state.table, op: state.op, filters: state.filters, columns: assigns }

  if (Object.keys(transforms).length > 0) {
    request.transforms = transforms
  }
  if (state.precondition !== undefined) {
    request.precondition = state.precondition
  }
  if (state.includeDeleted) {
    request.includeDeleted = true
  }
  if (state.maxAffected !== undefined) {
    request.maxAffected = state.maxAffected
  }
  if (state.returned !== undefined) {
    request.returning = true
  }
  if (cardinality !== undefined) {
    request.cardinality = cardinality
  }
  return request
}

async function applyWrite(state: IWriteState): Promise<IWriteResult> {
  const keys = (await state.engine.applyWhere(toApplyWhereRequest(state))) as string[]

  return { data: null, error: null, count: state.isCounted ? keys.length : null }
}

/** The rows `apply_where` returned, cut to the `select()` columns and stripped of nulls when asked. */
async function applyReturning(state: IWriteState, cardinality?: TWriteCardinality): Promise<TColumnValues[]> {
  const rows = (await state.engine.applyWhere(toApplyWhereRequest(state, cardinality))) as TColumnValues[]

  return shapeReturnedRows(rows, state)
}

function shapeReturnedRows(rows: readonly TColumnValues[], shape: { returned?: string[] | null; stripNulls: boolean }): TColumnValues[] {
  const projected = rows.map((row) => projectRow(row, shape.returned ?? null))

  return shape.stripNulls ? projected.map(stripNullValues) : projected
}

/** The single row a `single()` write returned. The kernel already refused any other count; this narrows the list to its row. */
function requireOneRow(rows: readonly TColumnValues[]): TColumnValues {
  const [row] = rows

  if (rows.length !== 1 || row === undefined) {
    throw new TEngineError(EEngineErrorCode.LOCAL_CONSTRAINT, `single() requires exactly one row; got ${rows.length}`)
  }
  return row
}

/** How a write's `select()` reads the rows it reached, and whether the write's options asked for a count. */
interface IReturnedRows {
  read: () => Promise<TColumnValues[]>
  isCounted: boolean
}

function readRowsResult(returned: IReturnedRows): Promise<IWriteRowsResult> {
  return returned.read().then((rows) => ({ data: rows, error: null, count: returned.isCounted ? rows.length : null }))
}

function createOneRowQuery(returned: IReturnedRows): PromiseLike<IWriteOneResult> {
  return {
    then: (onfulfilled, onrejected) =>
      returned
        .read()
        .then((rows) => ({ data: requireOneRow(rows), error: null, count: returned.isCounted ? rows.length : null }))
        .then(onfulfilled, onrejected),
  }
}

function createMaybeRowQuery(returned: IReturnedRows): PromiseLike<IWriteMaybeOneResult> {
  return {
    then: (onfulfilled, onrejected) =>
      returned
        .read()
        .then((rows) => ({ data: rows[0] ?? null, error: null, count: returned.isCounted ? rows.length : null }))
        .then(onfulfilled, onrejected),
  }
}

const createWriteSelectBuilder = (state: IWriteState): ILocalWriteSelectBuilder => {
  const builder: ILocalWriteSelectBuilder = {
    ...createRefusals(WRITE_SELECT_REFUSALS),
    ...createFilterMethods(state.filters, () => builder),
    includeDeleted() {
      state.includeDeleted = true

      return builder
    },
    maxAffected(count) {
      state.maxAffected = toMaxAffected(count)

      return builder
    },
    throwOnError: () => builder,
    retry: () => builder,
    stripNulls() {
      state.stripNulls = true

      return builder
    },
    returns: () => asRetyped(builder),
    overrideTypes: () => asRetyped(builder),
    single: () => asRetyped(createOneRowQuery({ read: () => applyReturning(state, 'single'), isCounted: state.isCounted })),
    maybeSingle: () => asRetyped(createMaybeRowQuery({ read: () => applyReturning(state, 'maybeSingle'), isCounted: state.isCounted })),
    range(): never {
      throw unsupported('range()')
    },
    then: (onfulfilled, onrejected) => readRowsResult({ read: () => applyReturning(state), isCounted: state.isCounted }).then(onfulfilled, onrejected),
  }

  return builder
}

interface ICreateWriteBuilderOptions {
  engine: ISyncEngine
  table: string
  key: readonly string[]
  op: 'delete' | 'update'
  columns: TUpdateValues
  options: IWriteOptions | undefined
}

export const createWriteBuilder = (request: ICreateWriteBuilderOptions): ILocalWriteBuilder => {
  const { engine, table, key, op, columns, options } = request
  const state: IWriteState = {
    engine,
    table,
    key,
    op,
    columns,
    precondition: options?.precondition,
    isCounted: isCountRequested(op, options?.count),
    filters: [],
    includeDeleted: false,
    stripNulls: false,
  }

  const builder: ILocalWriteBuilder = {
    ...createRefusals(WRITE_REFUSALS),
    ...createFilterMethods(state.filters, () => builder),
    includeDeleted() {
      state.includeDeleted = true

      return builder
    },
    maxAffected(count) {
      state.maxAffected = toMaxAffected(count)

      return builder
    },
    throwOnError: () => builder,
    retry: () => builder,
    select(columns) {
      state.returned = parseReturnedColumns(columns)

      return asRetyped(createWriteSelectBuilder(state))
    },
    range(): never {
      throw unsupported('range()')
    },
    then: (onfulfilled, onrejected) => applyWrite(state).then(onfulfilled, onrejected),
  }

  return builder
}

// MARK: - Insert

/** What `insert()` returns: the write, already under way, and `select()` to read the row back. */
export interface ILocalInsertQuery extends Promise<IWriteResult> {
  /**
   * Return the inserted row, cut to `columns`, read back by its key columns.
   * The row is written when `insert()` is called, before `select()` runs, so
   * an embed or a rename in `columns` throws LOCAL_UNSUPPORTED about the
   * read-back only.
   */
  select<TRow = TColumnValues>(columns?: string): IInsertSelectQuery<NoInfer<TRow>>

  /** Identity: a local write already rejects its promise on error. */
  throwOnError(): ILocalInsertQuery

  /** Identity: a local write has no network attempt to retry. */
  retry(enabled: boolean): ILocalInsertQuery
}

/** An insert chained with `select()`. */
export interface IInsertSelectQuery<TRow = TColumnValues> extends PromiseLike<IWriteRowsResult<TRow>> {
  single<TOne = TRow>(): PromiseLike<IWriteOneResult<NoInfer<TOne>>>
  maybeSingle<TOne = TRow>(): PromiseLike<IWriteMaybeOneResult<NoInfer<TOne>>>
  stripNulls(): IInsertSelectQuery<TRow>
  throwOnError(): IInsertSelectQuery<TRow>
  retry(enabled: boolean): IInsertSelectQuery<TRow>
  returns<TResult>(): TResult extends readonly (infer TNew)[] ? IInsertSelectQuery<TNew> : TListMismatch
  overrideTypes<TResult, TOptions extends TOverrideOptions = { merge: true }>(): TResult extends readonly (infer TNew)[] ? IInsertSelectQuery<TOverride<TRow, TNew, TOptions>> : TListMismatch
}

export interface ICreateInsertOptions {
  engine: ISyncEngine
  table: string
  key: readonly string[]
  values: TColumnValues
  options: TInsertOptions | undefined
  uuid: () => string
}

interface IInsertState extends ICreateInsertOptions {
  returned?: string[] | null
  stripNulls: boolean
}

const UPSERT_ONLY = 'it belongs to upsert(), which the local store does not offer'

/** Throws LOCAL_UNSUPPORTED for the first insert option the local store cannot honour. */
function rejectInsertOptions(options: TInsertOptions | undefined): void {
  isCountRequested('insert', options?.count)

  if (options?.defaultToNull !== undefined) {
    rejectOption('insert', 'defaultToNull', 'the push sends only the columns written and the database fills defaults')
  }
  if (options?.onConflict !== undefined) {
    rejectOption('insert', 'onConflict', UPSERT_ONLY)
  }
  if (options?.ignoreDuplicates !== undefined) {
    rejectOption('insert', 'ignoreDuplicates', UPSERT_ONLY)
  }
}

/** The filters that find the row once it is applied. Every option a local insert cannot honour is refused first, so nothing is written. */
async function applyInsert(state: IInsertState): Promise<TQueryFilter[]> {
  const { engine, table, key, values, options } = state

  rejectInsertOptions(options)
  // An empty pk leaves it to the kernel, which derives it from the key columns and refuses a row whose key columns spell none.
  const minted = mintsKey(key, values) ? toStoredKey(state.uuid()) : null

  await engine.apply({ table, pk: minted ?? '', op: 'insert', columns: values })

  return keyFilters({ key, values, minted })
}

/** The inserted row read back by its key, the soft-delete filter lifted so the row the caller wrote is the row it gets. */
async function readInserted(state: IInsertState, filters: TQueryFilter[]): Promise<TColumnValues[]> {
  const plan = { filters, orders: [], cardinality: 'many' as const, includeDeleted: true }
  const rows = (await state.engine.query(state.table, plan)) as TColumnValues[]

  return shapeReturnedRows(rows, state)
}

const createInsertSelectQuery = (state: IInsertState, applied: Promise<TQueryFilter[]>): IInsertSelectQuery => {
  const returned: IReturnedRows = {
    read: () => applied.then((filters) => readInserted(state, filters)),
    isCounted: state.options?.count !== undefined,
  }

  const query: IInsertSelectQuery = {
    single: () => asRetyped(createOneRowQuery(returned)),
    maybeSingle: () => asRetyped(createMaybeRowQuery(returned)),
    stripNulls() {
      state.stripNulls = true

      return query
    },
    throwOnError: () => query,
    retry: () => query,
    returns: () => asRetyped(query),
    overrideTypes: () => asRetyped(query),
    then: (onfulfilled, onrejected) => readRowsResult(returned).then(onfulfilled, onrejected),
  }

  return query
}

export const createInsertQuery = (options: ICreateInsertOptions): ILocalInsertQuery => {
  const state: IInsertState = { ...options, stripNulls: false }
  // Started here, as every local write is, so the kernel sees it before any call issued after it (a push included).
  const applied = applyInsert(state)
  const written = applied.then((): IWriteResult => ({ data: null, error: null, count: state.options?.count === undefined ? null : 1 }))

  const query: ILocalInsertQuery = Object.assign(written, {
    select(columns?: string) {
      // The caller awaits the select() chain, which reports any failure; the bare write promise is marked handled so it cannot also surface as unhandled.
      void written.catch(() => undefined)
      state.returned = parseReturnedColumns(columns)

      return asRetyped(createInsertSelectQuery(state, applied))
    },
    throwOnError: () => query,
    retry: () => query,
  })

  return query
}
