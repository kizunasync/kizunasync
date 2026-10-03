/// <reference types="bun" />
// MARK: - Every select query names its shape before it runs

/**
 * `useQuery` in the React and Vue bindings has to know whether a build ends in a
 * list or in one row before the first read resolves, so its initial `data` is
 * `[]` or `null`. The select builder and the two one-row terminals carry that
 * shape as `cardinality`, and reading it must not evaluate anything: the engine
 * sees a plan only when the query is awaited.
 */

import { describe, expect, test } from 'bun:test'
import { createFromBuilder, type ILocalSelectBuilder, type ISelectMaybeSingleQuery, type ISelectSingleQuery } from './builder'
import type { ISyncEngine, TQueryPlan } from '../wire/types'

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

describe('select query cardinality', () => {
  test('the select builder is many, through every filter and modifier', () => {
    const { from } = makeFrom()
    const builder: ILocalSelectBuilder = from.select('id, title').eq('done', false).order('title').limit(5)

    expect(builder.cardinality).toBe('many')
  })

  test('single() is single and maybeSingle() is maybeSingle', () => {
    const { from } = makeFrom()
    const single: ISelectSingleQuery = from.select().eq('id', ROW.id).single()
    const maybeSingle: ISelectMaybeSingleQuery = from.select().eq('id', ROW.id).maybeSingle()

    expect(single.cardinality).toBe('single')
    expect(maybeSingle.cardinality).toBe('maybeSingle')
  })

  test('reading the cardinality evaluates nothing', () => {
    const { from, plans } = makeFrom()

    expect(from.select().cardinality).toBe('many')
    expect(from.select().single().cardinality).toBe('single')
    expect(from.select().maybeSingle().cardinality).toBe('maybeSingle')
    expect(plans).toEqual([])
  })

  test('awaiting each query sends the plan its cardinality names', async () => {
    const { from, plans } = makeFrom()

    expect((await from.select()).data).toEqual([ROW])
    expect((await from.select().single()).data).toEqual(ROW)
    expect((await from.select().maybeSingle()).data).toEqual(ROW)
    expect(plans.map((plan) => plan.cardinality)).toEqual(['many', 'single', 'maybeSingle'])
  })
})
