/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createEmptyQueryData, isSingleRow, isSingleRowBuild, resolveDataAfterFailure, type TQuery } from './query-cardinality'
import { createFromBuilder } from '../query/builder'
import type { IKizunaSync } from '../query/kizunasync'
import type { ISyncEngine, TQueryPlan } from '../wire/types'

const ROW = { id: '00000000-0000-4000-8000-000000000001', title: 'works on a plane' }

/** A client whose `from` hands out real builders over an engine that records every plan it is asked to run. */
const makeClient = (): { client: IKizunaSync; plans: TQueryPlan[] } => {
  const plans: TQueryPlan[] = []
  const engine = {
    query: (_table: string, plan: TQueryPlan) => {
      plans.push(plan)

      return Promise.resolve(plan.cardinality === 'many' ? [ROW] : ROW)
    },
  } as unknown as ISyncEngine
  const client = { from: (table: string) => createFromBuilder({ engine, table, key: ['id'], uuid: () => ROW.id }) } as unknown as IKizunaSync

  return { client, plans }
}

describe('isSingleRow', () => {
  test('only the two one-row terminals read as one row', () => {
    const { client } = makeClient()

    expect(isSingleRow(client.from('todos').select())).toBe(false)
    expect(isSingleRow(client.from('todos').select().single())).toBe(true)
    expect(isSingleRow(client.from('todos').select().maybeSingle())).toBe(true)
  })

  test('a query object that carries no cardinality reads as a list', () => {
    const bare = Promise.resolve({ data: [ROW], error: null }) as unknown as TQuery

    expect(isSingleRow(bare)).toBe(false)
  })
})

describe('isSingleRowBuild', () => {
  test('reads the shape of the query the build returns without running it', () => {
    const { client, plans } = makeClient()

    expect(isSingleRowBuild((kizunasync) => kizunasync.from('todos').select().eq('id', ROW.id).single(), client)).toBe(true)
    expect(isSingleRowBuild((kizunasync) => kizunasync.from('todos').select().maybeSingle(), client)).toBe(true)
    expect(isSingleRowBuild((kizunasync) => kizunasync.from('todos').select().order('title'), client)).toBe(false)
    expect(plans).toEqual([])
  })

  test('a build that throws reads as a list', () => {
    const { client } = makeClient()

    expect(isSingleRowBuild(() => {
      throw new Error('boom')
    }, client)).toBe(false)
  })
})

describe('createEmptyQueryData', () => {
  test('is [] for a list and null for one row', () => {
    expect(createEmptyQueryData(false)).toEqual([])
    expect(createEmptyQueryData(true)).toBeNull()
  })
})

describe('resolveDataAfterFailure', () => {
  test('keeps the previous data when the failed read asked for the same shape', () => {
    const rows = [ROW]

    expect(resolveDataAfterFailure(rows, false)).toBe(rows)
    expect(resolveDataAfterFailure(ROW, true)).toBe(ROW)
    expect(resolveDataAfterFailure(null, true)).toBeNull()
  })

  test('drops data of the other shape to the empty value of the shape the read asked for', () => {
    expect(resolveDataAfterFailure([ROW], true)).toBeNull()
    expect(resolveDataAfterFailure(ROW, false)).toEqual([])
    expect(resolveDataAfterFailure(null, false)).toEqual([])
  })

  test('keeps the previous data when the build threw before it named a shape', () => {
    const rows = [ROW]

    expect(resolveDataAfterFailure(rows, null)).toBe(rows)
    expect(resolveDataAfterFailure(ROW, null)).toBe(ROW)
    expect(resolveDataAfterFailure(null, null)).toBeNull()
  })
})
