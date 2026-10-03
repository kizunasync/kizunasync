/**
 * The React and Vue `useQuery` bindings pick the shape of `data` from the
 * `cardinality` a select query carries before it runs: a list for the builder,
 * one row for `.single()` and `.maybeSingle()`.
 */

import type { ILocalSelectBuilder, ISelectMaybeSingleQuery, ISelectSingleQuery } from '../query/builder'
import type { IKizunaSync } from '../query/kizunasync'
import type { TColumnValues } from '../wire/types'

export type TSingleRowQuery<TRow = TColumnValues> = ISelectSingleQuery<TRow> | ISelectMaybeSingleQuery<TRow>

export type TQuery<TRow = TColumnValues> = ILocalSelectBuilder<TRow> | TSingleRowQuery<TRow>

export type TQueryBuild<TRow = TColumnValues> = (kizunasync: IKizunaSync) => TQuery<TRow>

export type TQueryData<T> = T[] | T | null

/** What names a query's shape: its `cardinality`, whatever its row type. */
type TShapedQuery = Pick<TQuery, 'cardinality'>

/** Only the two one-row terminals read as one row, so a query object that carries no cardinality stays a list. */
export function isSingleRow(query: TShapedQuery): boolean {
  return query.cardinality === 'single' || query.cardinality === 'maybeSingle'
}

/** A build that throws reads as a list here; the binding's read path then reports the throw in `error`. */
export function isSingleRowBuild(build: (kizunasync: IKizunaSync) => TShapedQuery, client: IKizunaSync): boolean {
  try {
    return isSingleRow(build(client))
  } catch {
    return false
  }
}

/** The `data` a binding holds before its first read resolves. */
export function createEmptyQueryData<T>(isSingle: boolean): TQueryData<T> {
  return isSingle ? null : []
}

/**
 * A failed read keeps the last resolved data, unless that data has the other
 * shape because deps switched the build between a list and one row. `null`
 * means the build threw before it named a shape.
 */
export function resolveDataAfterFailure<T>(previous: TQueryData<T>, isSingle: boolean | null): TQueryData<T> {
  const hasSameShape = Array.isArray(previous) !== isSingle

  if (isSingle === null || hasSameShape) {
    return previous
  }
  return createEmptyQueryData(isSingle)
}
