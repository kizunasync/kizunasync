/// <reference types="bun" />
// MARK: - The pk reaches the query grammar as `id`

/**
 * The store keeps the primary key in its own column, not inside the row's
 * column map. A row a pull delivered therefore carries no `id` key. The
 * kernel folds the pk in under `id` for reads and for the rows a
 * filter-targeted write resolves over: a filter naming `id` addresses the
 * row a read reports under that name. A stored `id` that disagrees with the
 * pk never exists; the kernel refuses to write one.
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it there is no engine to reach.
 */

import { describe, expect, test } from 'bun:test'
import { createFromBuilder } from './builder'
import { loadNapiAddon } from './napi-loader'
import { createRustEngine } from './rust-engine'
import { noopLogger } from '../util/logger'
import { EEngineErrorCode } from '../wire/types'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { TColumnValues, TEngineConfig } from '../wire/types'

const addon = loadNapiAddon()
const hasAddon = addon !== null

const CONFIG: TEngineConfig = {
  tables: { items: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } },
  schemaVersion: 1,
}

const NOW = '2024-01-01T00:00:00.000Z'
const PK = '00000000-0000-4000-8000-e10000000001'
const OTHER_PK = '00000000-0000-4000-8000-e10000000002'

/** These tests never sync; the remote exists only because the engine takes one. */
const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('no remote in this suite')),
  push: () => Promise.reject(new Error('no remote in this suite')),
}

const openEngine = (): ReturnType<typeof createRustEngine> => {
  if (addon === null) {
    throw new Error('the native addon is required for this suite')
  }
  let minted = 0

  return createRustEngine({
    addon,
    databasePath: null,
    remote: idleRemote,
    config: CONFIG,
    clientId: 'builder-pk-id-test',
    now: () => NOW,
    uuid: () => `mutation-${(minted += 1)}`,
    logger: noopLogger,
    deps: { pollIntervalMs: 0 },
  })
}

/**
 * The shape a pull writes: the pk stands on its own and the column map has no
 * `id` key of its own.
 */
const seedPulledRow = async (
  engine: ReturnType<typeof createRustEngine>,
  pk: string,
  columns: TColumnValues,
): Promise<void> => {
  await engine.apply({ table: 'items', pk, op: 'insert', columns })
}

const readRows = async (
  engine: ReturnType<typeof createRustEngine>,
): Promise<TColumnValues[]> =>
  (await createFromBuilder(engine, 'items', () => PK).select().order('id', { ascending: true }))
    .data

describe.skipIf(!hasAddon)('the query seam addresses the pk as `id`', () => {
  test('a filter on id over the Rust engine returns that row', async () => {
    const engine = openEngine()

    try {
      await seedPulledRow(engine, PK, { title: 'pinned', user_id: 'u1' })
      await seedPulledRow(engine, OTHER_PK, { title: 'other', user_id: 'u1' })

      const { data } = await createFromBuilder(engine, 'items', () => PK).select().eq('id', PK)

      expect(data).toEqual([{ id: PK, title: 'pinned', user_id: 'u1' }])
    } finally {
      engine.dispose?.()
    }
  })

  test('an insert whose id disagrees with the pk is refused with LOCAL_CONSTRAINT', async () => {
    const engine = openEngine()

    try {
      await expect(
        engine.apply({
          table: 'items',
          pk: PK,
          op: 'insert',
          columns: { id: OTHER_PK, title: 'stale id', user_id: 'u1' },
        }),
      ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })

      expect(await readRows(engine)).toEqual([])
    } finally {
      engine.dispose?.()
    }
  })

  test('an insert whose id repeats the pk is an ordinary write', async () => {
    const engine = openEngine()

    try {
      await createFromBuilder(engine, 'items', () => PK).insert({
        id: PK,
        title: 'named',
        user_id: 'u1',
      })

      expect(await readRows(engine)).toEqual([{ id: PK, title: 'named', user_id: 'u1' }])
    } finally {
      engine.dispose?.()
    }
  })

  test('an order on id over the Rust engine sorts by the pk', async () => {
    const engine = openEngine()

    try {
      await seedPulledRow(engine, OTHER_PK, { title: 'second', user_id: 'u1' })
      await seedPulledRow(engine, PK, { title: 'first', user_id: 'u1' })

      const { data } = await createFromBuilder(engine, 'items', () => PK)
        .select('id')
        .order('id', { ascending: true })

      expect(data).toEqual([{ id: PK }, { id: OTHER_PK }])
    } finally {
      engine.dispose?.()
    }
  })
})

// MARK: - Writes target pulled rows by `id` too

describe.skipIf(!hasAddon)('a filter-targeted write addresses the pk as `id`', () => {
  const seedPair = async (engine: ReturnType<typeof createRustEngine>): Promise<void> => {
    await seedPulledRow(engine, PK, { title: 'pinned', done: false, user_id: 'u1' })
    await seedPulledRow(engine, OTHER_PK, { title: 'other', done: false, user_id: 'u1' })
  }

  test('in(id, …) updates the named row and spares the rest', async () => {
    const engine = openEngine()

    try {
      await seedPair(engine)
      await createFromBuilder(engine, 'items', () => PK).update({ done: true }).in('id', [PK])

      const rows = await readRows(engine)

      expect(rows.map((row) => [row.id, row.done])).toEqual([
        [PK, true],
        [OTHER_PK, false],
      ])
    } finally {
      engine.dispose?.()
    }
  })

  test('eq(id) beside another filter still matches the row', async () => {
    const engine = openEngine()

    try {
      await seedPair(engine)
      await createFromBuilder(engine, 'items', () => PK)
        .update({ done: true })
        .eq('id', PK)
        .eq('title', 'pinned')

      const rows = await readRows(engine)

      expect(rows.map((row) => [row.id, row.done])).toEqual([
        [PK, true],
        [OTHER_PK, false],
      ])
    } finally {
      engine.dispose?.()
    }
  })

  test('neq(id, keep) spares the row it names and takes the others', async () => {
    const engine = openEngine()

    try {
      await seedPair(engine)
      await createFromBuilder(engine, 'items', () => PK).update({ done: true }).neq('id', PK)

      const rows = await readRows(engine)

      expect(rows.map((row) => [row.id, row.done])).toEqual([
        [PK, false],
        [OTHER_PK, true],
      ])
    } finally {
      engine.dispose?.()
    }
  })
})
