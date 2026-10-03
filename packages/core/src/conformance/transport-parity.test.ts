/// <reference types="bun" />
// MARK: - Query parity vectors over the engine transport

/**
 * The third runner of `packages/core/src/query/parity-vectors.json`, the
 * regression fixture of the one evaluator: `parity-vectors.test.ts` drives the
 * shipped app client, `crates/kizunasync-query/tests/parity_vectors.rs` drives
 * `apply_query` directly, and this one drives `call('query')` on an
 * `IEngineTransport`, the whole path the browser worker speaks, store included.
 * Every runner asserts the same rows and the same refusal codes.
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it there is no engine to reach.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCallEnvelope } from '../query/engine-envelope'
import { loadNapiAddon, type INapiAddon } from '../query/napi-loader'
import { toRustConfig } from '../query/rust-engine'
import type { IEngineTransport } from '../ports/engine-transport'
import type { TColumnValues, TEngineConfig } from '../wire/types'

const addon = loadNapiAddon()
const hasAddon = addon !== null

const TABLE = 'items'
/** The minimum vector count both sibling runners assert, so neither can shrink the set unnoticed. */
const MINIMUM_VECTORS = 60
/** The vectors never sync; the clock only dates the rows they insert. */
const FIXED_NOW = '2020-01-01T00:00:00.000Z'
/** A remote that is never called still has to exist for the engine to open. */
const NO_REMOTE = JSON.stringify({ ok: false, message: 'no remote injected', retryable: false })

const CONFIG: TEngineConfig = {
  schemaVersion: 1,
  tables: { [TABLE]: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } },
}

// MARK: - Vector shape

type TVector = {
  name: string
  rows: TColumnValues[]
  plan: unknown
  expected: string[]
  expectError: boolean
  expectCode: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (message: string): never => {
  throw new Error(`parity-vectors.json: ${message}`)
}

const readVectors = (): TVector[] => {
  const raw: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, '../query/parity-vectors.json'), 'utf8'),
  )
  const list = isRecord(raw) && Array.isArray(raw.vectors) ? raw.vectors : fail('vectors must be an array')

  return list.map((entry, index) => {
    const vector = isRecord(entry) ? entry : fail(`vectors[${index}] must be an object`)
    const name = typeof vector.name === 'string' ? vector.name : fail(`vectors[${index}].name must be a string`)
    const rows = Array.isArray(vector.rows) ? vector.rows : fail(`${name}.rows must be an array`)

    return {
      name,
      rows: rows.map((row, i) => (isRecord(row) ? (row as TColumnValues) : fail(`${name}.rows[${i}] must be an object`))),
      plan: vector.plan,
      expected: Array.isArray(vector.expected)
        ? vector.expected.map((id, i) =>
            typeof id === 'string' ? id : fail(`${name}.expected[${i}] must be a string`),
          )
        : fail(`${name}.expected must be an array`),
      expectError: vector.expectError === true,
      expectCode: typeof vector.expectCode === 'string' ? vector.expectCode : null,
    }
  })
}

// MARK: - One engine per vector

const openTransport = (bridge: INapiAddon): IEngineTransport => {
  const engine = new bridge.KizunaSyncEngine(
    JSON.stringify(toRustConfig(CONFIG, 'parity-transport-client')),
    null,
    async () => NO_REMOTE,
    async () => NO_REMOTE,
    () => undefined,
  )

  return {
    call: async (method, paramsJson) => engine.call(method, paramsJson),
    close: () => {
      engine.close()
    },
  }
}

const call = async (
  transport: IEngineTransport,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> =>
  parseCallEnvelope(
    await transport.call(
      method,
      JSON.stringify({ ...params, now: FIXED_NOW, now_ms: Date.parse(FIXED_NOW) }),
    ),
  )

/**
 * `query` answers `Many` as an array, `One` as an object and `Maybe` as either
 * an object or null; the vector pins the row ids in result order.
 */
const resultIds = (result: unknown): string[] => {
  const rows = Array.isArray(result) ? result : result === null ? [] : [result]

  return rows.map((row) => {
    const id = isRecord(row) ? row.id : undefined

    return typeof id === 'string' ? id : '<missing id>'
  })
}

const runVector = async (bridge: INapiAddon, vector: TVector): Promise<string[]> => {
  const transport = openTransport(bridge)

  try {
    for (const [index, row] of vector.rows.entries()) {
      const pk = typeof row.id === 'string' ? row.id : fail(`${vector.name}.rows[${index}].id must be a string`)

      await call(transport, 'apply', {
        table: TABLE,
        pk,
        op: 'insert',
        columns: row,
        mutation_id: `parity-${index}`,
      })
    }
    return resultIds(await call(transport, 'query', { table: TABLE, plan: vector.plan }))
  } finally {
    transport.close()
  }
}

// MARK: - Suite

const vectors = readVectors()

describe.skipIf(!hasAddon)('local query parity vectors over the engine transport', () => {
  test('the oracle carries the documented matrix and unique names', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(MINIMUM_VECTORS)
    expect(new Set(vectors.map((vector) => vector.name)).size).toBe(vectors.length)
  })

  for (const vector of vectors) {
    test(`vector: ${vector.name}`, async () => {
      if (addon === null) {
        throw new Error('the native addon is required for this suite')
      }
      if (vector.expectError) {
        if (vector.expectCode === null) {
          fail(`${vector.name}: expectError without expectCode`)
        }
        await expect(runVector(addon, vector)).rejects.toMatchObject({
          code: vector.expectCode,
        })

        return
      }
      expect(await runVector(addon, vector)).toEqual(vector.expected)
    })
  }
})
