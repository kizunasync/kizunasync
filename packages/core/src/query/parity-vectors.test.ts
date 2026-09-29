/// <reference types="bun" />
// MARK: - Shared local-query parity vectors

/**
 * Drives `parity-vectors.json`, the regression fixture of the shared evaluator,
 * through the shipped `createKizunaSync` client on the NAPI addon. Each vector's
 * rows are inserted through `from(table).insert`, its plan is replayed as
 * builder calls, and the rows the kernel answers with are compared against
 * the vector's own. The two sibling runners,
 * `crates/kizunasync-query/tests/parity_vectors.rs` and
 * `conformance/transport-parity.test.ts`, read the same file and assert the
 * same rows and the same refusal codes.
 *
 * Compound `or` / `and` nodes are replayed through the real PostgREST clause
 * parser: the harness renders the vector's child filters back to a clause
 * string and asserts the parser rebuilds exactly those children before
 * running it.
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it `createKizunaSync` has no engine to run.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from '../config/config'
import { createTempDatabase } from '../testing/temp-database'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { loadNapiAddon } from './napi-loader'
import { parseFilterList } from './filter-clauses'
import type { ILocalSelectBuilder } from './builder'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { TColumnValue, TColumnValues, TContainsValue } from '../wire/types'

const hasAddon = loadNapiAddon() !== null

const TABLE = 'items'
/** Same floor both sibling runners assert, so no runner can silently shrink. */
const MINIMUM_VECTORS = 60
/** The vectors never sync; the clock only dates the rows they insert. */
const FIXED_NOW = '2020-01-01T00:00:00.000Z'

const CONFIG = defineConfig({ tables: { [TABLE]: { sync: 'read-write' } } })

/** These vectors never sync; the remote exists only because the client takes one. */
const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the parity vectors never sync')),
  push: () => Promise.reject(new Error('the parity vectors never sync')),
}

// MARK: - Vector shape

type TVectorPlan = {
  filters: Record<string, unknown>[]
  orders: Record<string, unknown>[]
  limit: number | undefined
  projection: string[] | undefined
  cardinality: string
}

type TVector = {
  name: string
  rows: TColumnValues[]
  plan: TVectorPlan
  expected: string[]
  expectError: boolean
  expectCode: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (message: string): never => {
  throw new Error(`parity-vectors.json: ${message}`)
}

const asRecord = (value: unknown, label: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(`${label} must be an object`)

const asArray = (value: unknown, label: string): unknown[] =>
  Array.isArray(value) ? value : fail(`${label} must be an array`)

const asString = (value: unknown, label: string): string =>
  typeof value === 'string' ? value : fail(`${label} must be a string`)

const asColumnValue = (value: unknown, label: string): TColumnValue =>
  value === null || typeof value === 'string' || typeof value === 'number' ||
  typeof value === 'boolean'
    ? value
    : fail(`${label} must be null|boolean|number|string`)

const asContainsValue = (value: unknown, label: string): TContainsValue => {
  if (Array.isArray(value)) {
    return value.map((item, index) => asContainsValue(item, `${label}[${index}]`))
  }
  if (isRecord(value)) {
    const out: Record<string, TContainsValue> = {}

    for (const [key, item] of Object.entries(value)) {
      out[key] = asContainsValue(item, `${label}.${key}`)
    }
    return out
  }
  return asColumnValue(value, label)
}

const asRow = (value: unknown, label: string): TColumnValues => {
  const record = asRecord(value, label)
  const row: TColumnValues = {}

  for (const [key, cell] of Object.entries(record)) {
    row[key] = asColumnValue(cell, `${label}.${key}`)
  }
  return row
}

const readPlan = (value: unknown, label: string): TVectorPlan => {
  const plan = asRecord(value, label)
  const filters = plan.filters === undefined
    ? []
    : asArray(plan.filters, `${label}.filters`).map((f, i) =>
        asRecord(f, `${label}.filters[${i}]`),
      )
  const orders = plan.orders === undefined
    ? []
    : asArray(plan.orders, `${label}.orders`).map((o, i) =>
        asRecord(o, `${label}.orders[${i}]`),
      )
  const projection = plan.projection === undefined
    ? undefined
    : asArray(plan.projection, `${label}.projection`).map((c, i) =>
        asString(c, `${label}.projection[${i}]`),
      )
  const limit = plan.limit === undefined
    ? undefined
    : typeof plan.limit === 'number'
      ? plan.limit
      : fail(`${label}.limit must be a number`)

  return {
    filters,
    orders,
    limit,
    projection,
    cardinality: plan.cardinality === undefined ? 'many' : asString(plan.cardinality, `${label}.cardinality`),
  }
}

const readVectors = (): TVector[] => {
  const raw: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, 'parity-vectors.json'), 'utf8'),
  )
  const list = asArray(asRecord(raw, 'root').vectors, 'vectors')

  return list.map((entry, index) => {
    const vector = asRecord(entry, `vectors[${index}]`)
    const name = asString(vector.name, `vectors[${index}].name`)

    return {
      name,
      rows: asArray(vector.rows, `${name}.rows`).map((row, i) => asRow(row, `${name}.rows[${i}]`)),
      plan: readPlan(vector.plan, `${name}.plan`),
      expected: asArray(vector.expected, `${name}.expected`).map((id, i) =>
        asString(id, `${name}.expected[${i}]`),
      ),
      expectError: vector.expectError === true,
      expectCode: typeof vector.expectCode === 'string' ? vector.expectCode : null,
    }
  })
}

// MARK: - Vector filter to builder call

/** Render a leaf filter back to its PostgREST clause form (`.or` / `.and` input). */
const toClauseValue = (value: unknown, label: string): string => {
  const scalar = asColumnValue(value, label)

  if (scalar === null) {
    return 'null'
  }
  if (typeof scalar === 'string') {
    return /["',()\s]/.test(scalar) ? `"${scalar}"` : scalar
  }
  return String(scalar)
}

const toClause = (filter: Record<string, unknown>, label: string): string => {
  const kind = asString(filter.kind, `${label}.kind`)
  const column = asString(filter.column, `${label}.column`)

  if (kind === 'in') {
    const values = asArray(filter.values, `${label}.values`)
      .map((value, index) => toClauseValue(value, `${label}.values[${index}]`))
      .join(',')

    return `${column}.in.(${values})`
  }
  if (kind === 'like' || kind === 'ilike') {
    return `${column}.${kind}.${asString(filter.pattern, `${label}.pattern`)}`
  }
  return `${column}.${kind}.${toClauseValue(filter.value, `${label}.value`)}`
}

const applyCompound = (
  builder: ILocalSelectBuilder,
  filter: Record<string, unknown>,
  label: string,
  kind: 'and' | 'or',
): ILocalSelectBuilder => {
  const children = asArray(filter.filters, `${label}.filters`).map((child, index) =>
    asRecord(child, `${label}.filters[${index}]`),
  )
  const clause = children
    .map((child, index) => toClause(child, `${label}.filters[${index}]`))
    .join(',')
  // The rendered clause must rebuild the vector's own AST, or the vector is untestable here.
  const rebuilt: unknown = parseFilterList(clause)

  expect(rebuilt).toEqual(children)

  return kind === 'or' ? builder.or(clause) : builder.and(clause)
}

const applyNot = (
  builder: ILocalSelectBuilder,
  filter: Record<string, unknown>,
  label: string,
): ILocalSelectBuilder => {
  const inner = asRecord(filter.filter, `${label}.filter`)
  const kind = asString(inner.kind, `${label}.filter.kind`)
  const column = asString(inner.column, `${label}.filter.column`)

  if (kind === 'in') {
    return builder.not(column, 'in', asArray(inner.values, `${label}.filter.values`))
  }
  if (kind === 'like' || kind === 'ilike') {
    return builder.not(column, kind, asString(inner.pattern, `${label}.filter.pattern`))
  }
  return builder.not(column, kind, asColumnValue(inner.value, `${label}.filter.value`))
}

/**
 * One arm per wire filter kind: the exhaustive shape is the parity contract. The
 * `is` operand and the `textSearch` type are widened past the builder's own types
 * on purpose, because the vectors carry the operands the KERNEL refuses and a
 * JavaScript caller can pass them at runtime.
 */
const applyFilter = (
  builder: ILocalSelectBuilder,
  filter: Record<string, unknown>,
  label: string,
): ILocalSelectBuilder => {
  const kind = asString(filter.kind, `${label}.kind`)
  const column = (): string => asString(filter.column, `${label}.column`)
  const value = (): TColumnValue => asColumnValue(filter.value, `${label}.value`)
  const pattern = (): string => asString(filter.pattern, `${label}.pattern`)

  switch (kind) {
    case 'eq':
      return builder.eq(column(), value())
    case 'neq':
      return builder.neq(column(), value())
    case 'gt':
      return builder.gt(column(), value())
    case 'gte':
      return builder.gte(column(), value())
    case 'lt':
      return builder.lt(column(), value())
    case 'lte':
      return builder.lte(column(), value())
    case 'like':
      return builder.like(column(), pattern())
    case 'ilike':
      return builder.ilike(column(), pattern())
    case 'is':
      return builder.is(column(), value() as null | boolean)
    case 'in':
      return builder.in(
        column(),
        asArray(filter.values, `${label}.values`).map((item, index) =>
          asColumnValue(item, `${label}.values[${index}]`),
        ),
      )
    case 'contains':
      return builder.contains(column(), asContainsValue(filter.value, `${label}.value`))
    case 'containedBy':
      return builder.containedBy(column(), asContainsValue(filter.value, `${label}.value`))
    case 'and':
    case 'or':
      return applyCompound(builder, filter, label, kind)
    case 'not':
      return applyNot(builder, filter, label)
    case 'search': {
      const columns = filter.columns === undefined || filter.columns === null
        ? undefined
        : asArray(filter.columns, `${label}.columns`).map((item, index) =>
            asString(item, `${label}.columns[${index}]`),
          )
      const query = asString(filter.query, `${label}.query`)

      return columns === undefined ? builder.search(query) : builder.search(query, { columns })
    }
    case 'textSearch': {
      const type = filter.type === undefined ? 'plain' : asString(filter.type, `${label}.type`)

      return builder.textSearch(column(), asString(filter.query, `${label}.query`), {
        type: type as 'plain' | 'phrase' | 'websearch',
      })
    }
    default:
      return fail(`${label}.kind "${kind}" is not a local filter`)
  }
}

const buildSelect = (kizunasync: IKizunaSync, vector: TVector): ILocalSelectBuilder => {
  const projection = vector.plan.projection
  let builder = kizunasync
    .from(TABLE)
    .select(projection === undefined ? undefined : projection.join(','))

  vector.plan.filters.forEach((filter, index) => {
    builder = applyFilter(builder, filter, `plan.filters[${index}]`)
  })

  for (const [index, order] of vector.plan.orders.entries()) {
    const label = `plan.orders[${index}]`
    const ascending = order.ascending === undefined ? true : order.ascending === true
    const nullsFirst = order.nullsFirst

    builder =
      nullsFirst === undefined || nullsFirst === null
        ? builder.order(asString(order.column, `${label}.column`), { ascending })
        : builder.order(asString(order.column, `${label}.column`), {
            ascending,
            nullsFirst: nullsFirst === true,
          })
  }
  if (vector.plan.limit !== undefined) {
    builder = builder.limit(vector.plan.limit)
  }
  return builder
}

// MARK: - One client per vector

const openClient = (): IKizunaSync =>
  createKizunaSync(createTempDatabase().driver, idleRemote, CONFIG, {
    pollIntervalMs: 0,
    now: () => FIXED_NOW,
  })

/**
 * `query` answers `many` as an array, `single` as one row and `maybeSingle` as a
 * row or null; the vector pins the ids in result order, and a projection that
 * dropped `id` is pinned by the sentinel every runner uses.
 */
const resultIds = (result: unknown): string[] => {
  const rows = Array.isArray(result) ? result : result === null ? [] : [result]

  return rows.map((row) => {
    const id = isRecord(row) ? row.id : undefined

    return typeof id === 'string' ? id : '<missing id>'
  })
}

const runVector = async (vector: TVector): Promise<string[]> => {
  const kizunasync = openClient()

  try {
    for (const row of vector.rows) {
      await kizunasync.from(TABLE).insert(row)
    }
    const builder = buildSelect(kizunasync, vector)

    if (vector.plan.cardinality === 'single') {
      return resultIds((await builder.single()).data)
    }
    if (vector.plan.cardinality === 'maybeSingle') {
      return resultIds((await builder.maybeSingle()).data)
    }
    return resultIds((await builder).data)
  } finally {
    kizunasync.dispose()
  }
}

// MARK: - Suite

const vectors = readVectors()

describe.skipIf(!hasAddon)('local query parity vectors (the JavaScript app client)', () => {
  test('the fixture carries the documented matrix and unique names', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(MINIMUM_VECTORS)
    expect(new Set(vectors.map((vector) => vector.name)).size).toBe(vectors.length)
  })

  for (const vector of vectors) {
    test(`vector: ${vector.name}`, async () => {
      if (vector.expectError) {
        if (vector.expectCode === null) {
          fail(`${vector.name}: expectError without expectCode`)
        }
        await expect(runVector(vector)).rejects.toMatchObject({ code: vector.expectCode })

        return
      }
      expect(await runVector(vector)).toEqual(vector.expected)
    })
  }
})
