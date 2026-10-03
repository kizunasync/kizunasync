/**
 * The static side of `returns()`, `overrideTypes()`, and `select({ head })`,
 * shared by the read and the write builders. postgrest-js retypes the query it
 * is called on without touching the rows, and so do these: every helper here is
 * a type, except `asRetyped`, the one place a query changes its static type.
 */

/** `data` of a read: `null` for a `head` read, which answers only the count. */
export type TUnlessHead<THead extends boolean, TData> = THead extends true ? null : TData

/** What `returns()` and `overrideTypes()` produce when the new type contradicts the shape of `data`, as postgrest-js reports it. */
export interface ITypeMismatch<TMessage extends string> {
  readonly Error: TMessage
}

/** A list query retyped with a single-row type. */
export type TListMismatch = ITypeMismatch<'Type mismatch: a list result takes an array type; use single() or maybeSingle() for one row'>

/** A one-row query retyped with an array type. */
export type TRowMismatch = ITypeMismatch<'Type mismatch: a one-row result takes a row type, not an array'>

/** `overrideTypes()`: `TNew` merged over `TRow` key by key, or `TNew` alone with `{ merge: false }`. */
export type TOverride<TRow, TNew, TOptions extends { merge?: boolean }> = TOptions extends { merge: false } ? TNew : Omit<TRow, keyof TNew> & TNew

/** `overrideTypes()` options: merge into the row type (the default) or replace it. */
export type TOverrideOptions = { merge?: boolean }

/**
 * `query` under the static type a caller asked for. A query's rows are typed
 * only at compile time, so retyping one changes nothing at runtime; the
 * signature that calls this states the type.
 */
export function asRetyped<TQuery>(query: TQuery): never {
  return query as never
}
