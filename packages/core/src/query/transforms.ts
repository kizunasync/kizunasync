// MARK: - Field transforms

/**
 * Firestore-shaped sentinels for `update()`. They never ride `columns`: the
 * builder splits them out and sends them as the write's `transforms`, which the
 * kernel puts on every mutation the filters resolve to. Increment is
 * a signed integer delta, not a CRDT counter: a later assign of the same
 * column can wipe offline increments. arrayUnion / arrayRemove are column
 * shortcuts, not OR-sets with per-member add-ids.
 */

import { EEngineErrorCode, TEngineError, type TColumnValue, type TColumnValues, type TTransform } from '../wire/types'

/** Array-transform members on the wire: scalars only, never null (D-field-transforms / `$defs/transform`). */
type TArrayMember = boolean | number | string

const TRANSFORM_BRAND: unique symbol = Symbol.for('kizunasync.transform')

const I32_ABS = 2147483648n

export type TIncrementSentinel = {
  readonly [TRANSFORM_BRAND]: 'increment'
  readonly by: bigint
}

export type TArrayUnionSentinel = {
  readonly [TRANSFORM_BRAND]: 'arrayUnion'
  readonly values: TArrayMember[]
}

export type TArrayRemoveSentinel = {
  readonly [TRANSFORM_BRAND]: 'arrayRemove'
  readonly values: TArrayMember[]
}

export type TFieldTransformSentinel = TIncrementSentinel | TArrayUnionSentinel | TArrayRemoveSentinel

/** `update()` values: ordinary assigns plus D-field-transforms sentinels (`increment` / `arrayUnion` / `arrayRemove`). */
export type TUpdateValues = Record<string, TColumnValue | TFieldTransformSentinel>

type TWireTransform = TTransform

type TWireTransforms = Record<string, TTransform>

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null

export const isIncrement = (value: unknown): value is TIncrementSentinel =>
  isRecord(value) && value[TRANSFORM_BRAND] === 'increment' && typeof value.by === 'bigint'

export const isArrayUnion = (value: unknown): value is TArrayUnionSentinel =>
  isRecord(value) && value[TRANSFORM_BRAND] === 'arrayUnion' && Array.isArray(value.values)

export const isArrayRemove = (value: unknown): value is TArrayRemoveSentinel =>
  isRecord(value) && value[TRANSFORM_BRAND] === 'arrayRemove' && Array.isArray(value.values)

const isFieldTransform = (value: unknown): value is TFieldTransformSentinel =>
  isIncrement(value) || isArrayUnion(value) || isArrayRemove(value)

const parseIntegerInput = (by: number | string, label: string): bigint => {
  if (typeof by === 'number') {
    if (!Number.isInteger(by)) {
      throw new TEngineError(
        EEngineErrorCode.LOCAL_CONSTRAINT,
        `${label} requires a signed integer, got ${by}`,
      )
    }
    return BigInt(by)
  }
  if (typeof by !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(by)) {
    throw new TEngineError(
      EEngineErrorCode.LOCAL_CONSTRAINT,
      `${label} requires a signed integer, got ${JSON.stringify(by)}`,
    )
  }
  return BigInt(by)
}

/** JSON number when |n| < 2^31, else a decimal string (C-4 exception on `$defs/transform` only). */
const encodeSignedInt = (n: bigint): number | string => {
  const abs = n < 0n ? -n : n

  if (abs < I32_ABS) {
    return Number(n)
  }
  return n.toString()
}

export const increment = (by: number | string): TIncrementSentinel => ({
  [TRANSFORM_BRAND]: 'increment',
  by: parseIntegerInput(by, 'increment()'),
})

export const arrayUnion = (...values: TArrayMember[]): TArrayUnionSentinel => {
  if (values.length === 0) {
    throw new TEngineError(
      EEngineErrorCode.LOCAL_CONSTRAINT,
      'arrayUnion() requires at least one value',
    )
  }
  return { [TRANSFORM_BRAND]: 'arrayUnion', values: [...values] }
}

export const arrayRemove = (...values: TArrayMember[]): TArrayRemoveSentinel => {
  if (values.length === 0) {
    throw new TEngineError(
      EEngineErrorCode.LOCAL_CONSTRAINT,
      'arrayRemove() requires at least one value',
    )
  }
  return { [TRANSFORM_BRAND]: 'arrayRemove', values: [...values] }
}

const toWireTransform = (sentinel: TFieldTransformSentinel): TWireTransform => {
  if (isIncrement(sentinel)) {
    return { op: 'increment', by: encodeSignedInt(sentinel.by) }
  }
  if (isArrayUnion(sentinel)) {
    return { op: 'arrayUnion', values: [...sentinel.values] }
  }
  if (isArrayRemove(sentinel)) {
    return { op: 'arrayRemove', values: [...sentinel.values] }
  }
  sentinel satisfies never

  throw new TEngineError(EEngineErrorCode.LOCAL_UNSUPPORTED, 'unknown field transform sentinel')
}

/** What `update()` wrote, on which table, and that table's key columns. */
export interface IUpdateValuesInput {
  values: Record<string, unknown>
  table: string
  key: readonly string[]
}

/** Split an `update()` values map into assign columns vs wire transforms. */
export const splitAssignsAndTransforms = (input: IUpdateValuesInput): { columns: TColumnValues; transforms: TWireTransforms } => {
  const { values, table, key } = input
  const columns: TColumnValues = {}
  const transforms: TWireTransforms = {}

  for (const [column, value] of Object.entries(values)) {
    if (isFieldTransform(value)) {
      if (key.includes(column)) {
        throw new TEngineError(
          EEngineErrorCode.LOCAL_CONSTRAINT,
          `update() cannot transform "${column}": the primary key is immutable`,
          { table },
        )
      }
      transforms[column] = toWireTransform(value)
      continue
    }
    columns[column] = value as TColumnValue
  }
  return { columns, transforms }
}
