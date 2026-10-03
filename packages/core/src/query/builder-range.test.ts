/// <reference types="bun" />
// MARK: - range() pages a select through offset and limit

/**
 * supabase-js `range(from, to)` names an inclusive window of row indexes. The
 * select builder sends it to the kernel as the plan's `offset` and `limit`, so
 * the read skips `from` rows after the sort and keeps `to - from + 1`. The fake
 * engine only records the plans it is handed.
 */

import { describe, expect, test } from 'bun:test'
import { createFromBuilder, type ILocalSelectBuilder } from './builder'
import { EEngineErrorCode, TEngineError, type ISyncEngine, type TQueryPlan } from '../wire/types'

const ROW = { id: '00000000-0000-4000-8000-000000000001', title: 'works on a plane' }

const makeFrom = (): { from: ReturnType<typeof createFromBuilder>; plans: TQueryPlan[] } => {
  const plans: TQueryPlan[] = []
  const engine = {
    query: (_table: string, plan: TQueryPlan) => {
      plans.push(plan)

      return Promise.resolve(plan.cardinality === 'many' ? [ROW] : ROW)
    },
  } as unknown as ISyncEngine

  return { from: createFromBuilder({ engine, table: 'todos', key: ['id'], uuid: () => ROW.id }), plans }
}

const expectRefused = (run: () => unknown, named: string): void => {
  try {
    run()

    throw new Error('expected LOCAL_UNSUPPORTED to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
    expect((error as TEngineError).message).toContain(named)
  }
}

describe('select range', () => {
  test('the inclusive bounds become the offset and the row count', async () => {
    const { from, plans } = makeFrom()
    const page: ILocalSelectBuilder = from.select('id, title').order('title').range(10, 19)

    await page

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ offset: 10, limit: 10, orders: [{ column: 'title', ascending: true, nullsFirst: false }] })
  })

  test('equal bounds keep one row, and a to one below from keeps none', async () => {
    const { from, plans } = makeFrom()

    await from.select().range(0, 0)
    await from.select().range(3, 2)

    expect(plans.map(({ offset, limit }) => ({ offset, limit }))).toEqual([
      { offset: 0, limit: 1 },
      { offset: 3, limit: 0 },
    ])
  })

  test('a later limit replaces only the row count', async () => {
    const { from, plans } = makeFrom()

    await from.select().range(10, 19).limit(5)

    expect(plans[0]).toMatchObject({ offset: 10, limit: 5 })
  })

  test('a later range replaces both the offset and the row count', async () => {
    const { from, plans } = makeFrom()

    await from.select().limit(5).range(2, 3)
    await from.select().range(10, 19).range(0, 4)

    expect(plans.map(({ offset, limit }) => ({ offset, limit }))).toEqual([
      { offset: 2, limit: 2 },
      { offset: 0, limit: 5 },
    ])
  })

  test('a plan built without range carries no offset', async () => {
    const { from, plans } = makeFrom()

    await from.select().limit(3)

    expect('offset' in plans[0]!).toBe(false)
  })

  test('single and maybeSingle read the window range names', async () => {
    const { from, plans } = makeFrom()

    await from.select().order('title').range(2, 2).single()
    await from.select().order('title').range(4, 5).maybeSingle()

    expect(plans.map(({ offset, limit, cardinality }) => ({ offset, limit, cardinality }))).toEqual([
      { offset: 2, limit: 1, cardinality: 'single' },
      { offset: 4, limit: 2, cardinality: 'maybeSingle' },
    ])
  })

  test('bounds that are not whole numbers of zero or more, or a to below from - 1, are refused before any plan', () => {
    const { from, plans } = makeFrom()
    const refused: Array<[number, number]> = [[-1, 5], [0, -1], [-2, -3], [1.5, 3], [0, 2.5], [5, 3], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY]]

    for (const [start, end] of refused) {
      expectRefused(() => from.select().range(start, end), `range(${start}, ${end})`)
    }
    expect(plans).toEqual([])
  })

  test('referencedTable and foreignTable are refused by name, as limit refuses them', () => {
    const { from } = makeFrom()

    expectRefused(() => from.select().range(0, 9, { referencedTable: 'authors' }), 'referencedTable')
    expectRefused(() => from.select().range(0, 9, { foreignTable: 'authors' }), 'foreignTable')
  })

  test('a write chain still refuses range by name', () => {
    const { from } = makeFrom()

    expectRefused(() => from.update({ title: 'renamed' }).eq('id', ROW.id).range(0, 1), 'range()')
    expectRefused(() => from.delete().eq('id', ROW.id).range(0, 1), 'range()')
  })
})
