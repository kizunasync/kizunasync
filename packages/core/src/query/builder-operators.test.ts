/// <reference types="bun" />
// MARK: - Every postgrest-js method, local or refused by name

/**
 * The builders speak postgrest-js: each filter becomes the kernel node it
 * names, each option and transform shapes the plan or the answer, and every
 * method with no local meaning throws LOCAL_UNSUPPORTED with its reason. The
 * fake engine records the plans and the write requests it is handed and
 * answers what the kernel would, so these pin the builder alone.
 */

import { describe, expect, test } from 'bun:test'
import { createFromBuilder, type ILocalSelectBuilder, type ISelectMaybeSingleQuery, type ISelectSingleQuery } from './builder'
import { EEngineErrorCode, TEngineError, type ISyncEngine, type TApplyWhereRequest, type TColumnValues, type TLocalMutation, type TQueryPlan, type TQueryResult } from '../wire/types'
import { createKizunaSync } from './kizunasync'
import { defineConfig } from '../config/config'
import type { ITypeMismatch } from './result-types'

const ROW_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ID = '00000000-0000-4000-8000-000000000002'
const ROW: TColumnValues = { id: ROW_ID, title: 'works on a plane', note: null, done: false }
const OTHER: TColumnValues = { id: OTHER_ID, title: 'a, "quoted" title', note: 'line\nbreak', done: true }

interface IFake {
  from: ReturnType<typeof createFromBuilder>
  plans: TQueryPlan[]
  writes: TApplyWhereRequest[]
  applied: TLocalMutation[]
  answerWith: (next: (plan: TQueryPlan) => Promise<TQueryResult>) => void
}

/** The answer the kernel gives `plan` over `rows`, before any offset or limit. */
const answer = (plan: TQueryPlan, rows: TColumnValues[]): TQueryResult => {
  const shaped: TQueryResult = plan.cardinality === 'many' ? rows : (rows[0] ?? null)

  return plan.count === true ? { rows: shaped, count: rows.length } : shaped
}

const makeFake = (rows: TColumnValues[] = [ROW, OTHER]): IFake => {
  const plans: TQueryPlan[] = []
  const writes: TApplyWhereRequest[] = []
  const applied: TLocalMutation[] = []
  let respond = (plan: TQueryPlan): Promise<TQueryResult> => Promise.resolve(answer(plan, rows))
  const engine = {
    query: (_table: string, plan: TQueryPlan) => {
      plans.push(plan)

      return respond(plan)
    },
    applyWhere: (request: TApplyWhereRequest) => {
      writes.push(request)

      if (request.cardinality === 'single' && rows.length !== 1) {
        return Promise.reject(new TEngineError(EEngineErrorCode.LOCAL_CONSTRAINT, `single() requires exactly one row; got ${rows.length}`))
      }
      if (request.cardinality === 'maybeSingle' && rows.length > 1) {
        return Promise.reject(new TEngineError(EEngineErrorCode.LOCAL_CONSTRAINT, `maybeSingle() requires at most one row; got ${rows.length}`))
      }
      if (request.maxAffected !== undefined && rows.length > request.maxAffected) {
        return Promise.reject(new TEngineError(EEngineErrorCode.LOCAL_CONSTRAINT, `matched ${rows.length} rows, more than maxAffected(${request.maxAffected})`))
      }
      return Promise.resolve(request.returning === true ? rows : rows.map((row) => row.id))
    },
    apply: (mutation: TLocalMutation) => {
      applied.push(mutation)

      return Promise.resolve()
    },
  } as unknown as ISyncEngine

  return {
    from: createFromBuilder({ engine, table: 'todos', key: ['id'], uuid: () => ROW_ID }),
    plans,
    writes,
    applied,
    answerWith: (next) => {
      respond = next
    },
  }
}

const refusal = (run: () => unknown): TEngineError => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)

    return error as TEngineError
  }
  throw new Error('expected LOCAL_UNSUPPORTED to throw')
}

// MARK: - Filters

describe('filters build the kernel nodes they name', () => {
  test('match() is an and of eq, skipping undefined values', async () => {
    const { from, plans } = makeFake()

    await from.select().match({ title: 'works on a plane', done: false, note: undefined })
    await from.select().match({})

    expect(plans.map((plan) => plan.filters)).toEqual([
      [{ kind: 'and', filters: [{ kind: 'eq', column: 'title', value: 'works on a plane' }, { kind: 'eq', column: 'done', value: false }] }],
      [{ kind: 'and', filters: [] }],
    ])
  })

  test('filter() decodes one clause, negated by a not. prefix', async () => {
    const { from, plans } = makeFake()

    await from.select().filter('done', 'eq', false).filter('title', 'not.like', 'works*').filter('id', 'in', '(a,b)')

    expect(plans[0]!.filters).toEqual([
      { kind: 'eq', column: 'done', value: false },
      { kind: 'not', filter: { kind: 'like', column: 'title', pattern: 'works*' } },
      { kind: 'in', column: 'id', values: ['a', 'b'] },
    ])
  })

  test('or() and and() take a not. prefix inside the clause string', async () => {
    const { from, plans } = makeFake()

    await from.select().or('title.not.eq.x,done.eq.true').and('rank.not.in.(1,2)')

    expect(plans[0]!.filters).toEqual([
      { kind: 'or', filters: [{ kind: 'not', filter: { kind: 'eq', column: 'title', value: 'x' } }, { kind: 'eq', column: 'done', value: true }] },
      { kind: 'and', filters: [{ kind: 'not', filter: { kind: 'in', column: 'rank', values: [1, 2] } }] },
    ])
  })

  test('filter() refuses an operator the clause grammar does not take', () => {
    const { from } = makeFake()
    const error = refusal(() => from.select().filter('tags', 'cs', '{a}'))

    expect(error.message).toContain("filter('tags', 'cs', …)")
    expect(error.message).toContain('unsupported filter operator "cs"')
  })

  test('the pattern lists are an or (AnyOf) or an and (AllOf) of like and ilike nodes', async () => {
    const { from, plans } = makeFake()

    await from.select().likeAnyOf('title', ['a%', '%b']).likeAllOf('title', ['%a%']).ilikeAnyOf('title', ['A%']).ilikeAllOf('title', [])

    expect(plans[0]!.filters).toEqual([
      { kind: 'or', filters: [{ kind: 'like', column: 'title', pattern: 'a%' }, { kind: 'like', column: 'title', pattern: '%b' }] },
      { kind: 'and', filters: [{ kind: 'like', column: 'title', pattern: '%a%' }] },
      { kind: 'or', filters: [{ kind: 'ilike', column: 'title', pattern: 'A%' }] },
      { kind: 'and', filters: [] },
    ])
  })

  test('notIn, regexMatch, regexIMatch, isDistinct, and overlaps are their own nodes', async () => {
    const { from, plans } = makeFake()
    const values = ['a', 'b']

    await from
      .select()
      .notIn('id', values)
      .regexMatch('title', '^works')
      .regexIMatch('title', 'PLANE$')
      .isDistinct('note', null)
      .overlaps('tags', ['a', 'z'])
      .overlaps('tags', '["a"]')
    values.push('c')

    expect(plans[0]!.filters).toEqual([
      { kind: 'not', filter: { kind: 'in', column: 'id', values: ['a', 'b'] } },
      { kind: 'regexMatch', column: 'title', pattern: '^works' },
      { kind: 'regexIMatch', column: 'title', pattern: 'PLANE$' },
      { kind: 'isDistinct', column: 'note', value: null },
      { kind: 'overlaps', column: 'tags', value: ['a', 'z'] },
      { kind: 'overlaps', column: 'tags', value: '["a"]' },
    ])
  })

  test('a write carries the same filters to apply_where', async () => {
    const { from, writes } = makeFake()

    await from.update({ done: true }).match({ id: ROW_ID }).notIn('title', ['x']).regexMatch('title', '^w')

    expect(writes[0]!.filters).toEqual([
      { kind: 'and', filters: [{ kind: 'eq', column: 'id', value: ROW_ID }] },
      { kind: 'not', filter: { kind: 'in', column: 'title', values: ['x'] } },
      { kind: 'regexMatch', column: 'title', pattern: '^w' },
    ])
  })
})

// MARK: - Count and head

describe('select() count and head', () => {
  test('every count mode asks the kernel for the exact count and answers it', async () => {
    for (const mode of ['exact', 'planned', 'estimated'] as const) {
      const { from, plans } = makeFake()
      const { data, count } = await from.select('id', { count: mode }).limit(1)

      expect(plans[0]!.count).toBe(true)
      expect(count).toBe(2)
      expect(data).toEqual([ROW, OTHER])
    }
  })

  test('without a count the plan carries none and count is null', async () => {
    const { from, plans } = makeFake()
    const result = await from.select()

    expect(plans[0]).not.toHaveProperty('count')
    expect(result.count).toBeNull()
  })

  test('the one-row terminals and csv() read the count beside their rows', async () => {
    const { from } = makeFake([ROW])

    expect(await from.select('*', { count: 'exact' }).single()).toEqual({ data: ROW, error: null, count: 1 })
    expect(await from.select('*', { count: 'exact' }).maybeSingle()).toEqual({ data: ROW, error: null, count: 1 })
    expect((await from.select('id', { count: 'exact' }).csv()).count).toBe(1)
  })

  test('head answers the count with no rows', async () => {
    const { from } = makeFake()

    expect(await from.select('*', { count: 'exact', head: true })).toEqual({ data: null, error: null, count: 2 })
    expect(await from.select('*', { head: true })).toEqual({ data: null, error: null, count: null })
    expect((await from.select('*', { head: true }).maybeSingle()).data).toBeNull()
  })

  test('a count mode outside the three is refused', () => {
    const error = refusal(() => makeFake().from.select('*', { count: 'fuzzy' }))

    expect(error.message).toContain('count takes exact, planned, or estimated')
  })
})

// MARK: - Writes that return rows

describe('writes: count, select(), and maxAffected()', () => {
  test('a write count is the number of rows it reached', async () => {
    const { from } = makeFake()

    expect(await from.update({ done: true }, { count: 'exact' }).eq('done', false)).toEqual({ data: null, error: null, count: 2 })
    expect(await from.delete({ count: 'planned' }).eq('done', false)).toEqual({ data: null, error: null, count: 2 })
    expect(await from.delete().eq('done', false)).toEqual({ data: null, error: null, count: null })
    expect(await from.insert({ title: 'x' }, { count: 'exact' })).toEqual({ data: null, error: null, count: 1 })
  })

  test('select() after an update asks for the rows and cuts them to its columns', async () => {
    const { from, writes } = makeFake()
    const { data, count } = await from.update({ done: true }, { count: 'exact' }).eq('done', false).select('id, note, missing')

    expect(writes[0]).toMatchObject({ returning: true })
    expect(data).toEqual([
      { id: ROW_ID, note: null, missing: null },
      { id: OTHER_ID, note: 'line\nbreak', missing: null },
    ])
    expect(count).toBe(2)
  })

  test('filters chained after select() still target the write', async () => {
    const { from, writes } = makeFake()

    await from.delete().select().eq('id', ROW_ID)

    expect(writes[0]!.filters).toEqual([{ kind: 'eq', column: 'id', value: ROW_ID }])
  })

  test('single() and maybeSingle() hand the kernel their cardinality, beside any cap', async () => {
    const { from, writes } = makeFake([ROW])

    expect((await from.update({ done: true }).eq('done', false).select('id').single()).data).toEqual({ id: ROW_ID })
    expect((await from.delete().eq('id', ROW_ID).maxAffected(3).select().maybeSingle()).data).toEqual(ROW)
    expect(writes.map(({ cardinality, maxAffected, returning }) => ({ cardinality, maxAffected, returning }))).toEqual([
      { cardinality: 'single', maxAffected: undefined, returning: true },
      { cardinality: 'maybeSingle', maxAffected: 3, returning: true },
    ])
  })

  test('a one-row write that reaches another count fails with the message a read gives', async () => {
    const none = makeFake([]).from
    const two = makeFake().from

    await expect(Promise.resolve(none.update({ done: true }).eq('id', 'none').select().single())).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
      message: 'single() requires exactly one row; got 0',
    })
    await expect(Promise.resolve(two.delete().eq('done', false).select().maybeSingle())).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
      message: 'maybeSingle() requires at most one row; got 2',
    })
    expect((await none.update({ done: true }).eq('id', 'none').select().maybeSingle()).data).toBeNull()
  })

  test('maxAffected() rides the request, and a cap that is no u32 is refused', async () => {
    const { from, writes } = makeFake()

    await from.update({ done: true }).eq('done', false).maxAffected(2)

    expect(writes[0]!.maxAffected).toBe(2)

    for (const cap of [-1, 1.5, 4_294_967_296]) {
      refusal(() => from.delete().eq('done', false).maxAffected(cap))
    }
  })

  test('an embed in a write select() is refused before anything is written', () => {
    const { from, writes } = makeFake()
    const error = refusal(() => from.update({ done: true }).eq('id', ROW_ID).select('id, author(name)'))

    expect(error.message).toContain('without foreign-key joins')
    expect(writes).toEqual([])
  })

  test('insert().select() reads the row back by id and cuts it to its columns', async () => {
    const { from, plans, applied } = makeFake([ROW])
    const { data, count } = await from.insert({ title: 'works on a plane' }, { count: 'exact' }).select('id, title')

    expect(applied).toHaveLength(1)
    expect(plans[0]).toEqual({
      filters: [{ kind: 'eq', column: 'id', value: ROW_ID }],
      orders: [],
      cardinality: 'many',
      includeDeleted: true,
    })
    expect(data).toEqual([{ id: ROW_ID, title: 'works on a plane' }])
    expect(count).toBe(1)
    expect((await from.insert({ title: 'again' }).select().single()).data).toEqual(ROW)
  })

  test('an embed in insert().select() is refused by name; the insert was already issued', () => {
    const { from, applied } = makeFake()

    expect(refusal(() => from.insert({ title: 'x' }).select('author(name)')).message).toContain('without foreign-key joins')
    expect(applied).toHaveLength(1)
  })

  test('stripNulls() drops null-valued keys from the rows a write returns', async () => {
    const { from } = makeFake([ROW])

    expect((await from.delete().eq('id', ROW_ID).select('id, note').stripNulls().maybeSingle()).data).toEqual({ id: ROW_ID })
  })
})

// MARK: - Transforms

describe('stripNulls(), csv(), throwOnError(), retry(), abortSignal()', () => {
  test('stripNulls() drops null-valued keys on every read shape', async () => {
    const { from } = makeFake([ROW])

    expect((await from.select().stripNulls()).data).toEqual([{ id: ROW_ID, title: 'works on a plane', done: false }])
    expect((await from.select().single().stripNulls()).data).toEqual({ id: ROW_ID, title: 'works on a plane', done: false })
    expect((await from.select().stripNulls().maybeSingle()).data).toEqual({ id: ROW_ID, title: 'works on a plane', done: false })
  })

  test('csv() writes the projected columns in order, quoting per RFC 4180', async () => {
    const { from } = makeFake()
    const { data } = await from.select('title, note, id').csv()

    expect(data).toBe(`title,note,id\nworks on a plane,,${ROW_ID}\n"a, ""quoted"" title","line\nbreak",${OTHER_ID}`)
  })

  test('csv() over every column takes the keys in the order they first appear, and objects as JSON', async () => {
    const { from } = makeFake([{ id: 'a', tags: ['x', 'y'] }, { id: 'b', meta: { k: 1 } }] as unknown as TColumnValues[])
    const { data } = await from.select().csv()

    expect(data).toBe('id,tags,meta\na,"[""x"",""y""]",\nb,,"{""k"":1}"')
  })

  test('csv() over no rows is the header, or empty when no column is named', async () => {
    const { from } = makeFake([])

    expect((await from.select('id, title').csv()).data).toBe('id,title')
    expect((await from.select().csv()).data).toBe('')
  })

  test('stripNulls() after csv() is refused', () => {
    refusal(() => makeFake().from.select().csv().stripNulls())
  })

  test('throwOnError() and retry() hand back the same query', () => {
    const { from } = makeFake()
    const builder = from.select()
    const single = builder.single()
    const csv = builder.csv()
    const write = from.update({ done: true })
    const insert = from.insert({ title: 'x' })

    expect(builder.throwOnError()).toBe(builder)
    expect(builder.retry(false)).toBe(builder)
    expect(single.throwOnError()).toBe(single)
    expect(csv.retry(true)).toBe(csv)
    expect(write.throwOnError().retry(false)).toBe(write)
    expect(insert.throwOnError().retry(false)).toBe(insert)
  })

  test('an aborted signal rejects the read with its reason and drops the answer', async () => {
    const { from, answerWith } = makeFake()
    const early = new AbortController()

    early.abort(new Error('left the screen'))
    await expect(Promise.resolve(from.select().abortSignal(early.signal))).rejects.toThrow('left the screen')

    let release = (): void => undefined

    answerWith((plan) => new Promise((resolve) => {
      release = () => resolve(answer(plan, [ROW]))
    }))
    const late = new AbortController()
    const read = Promise.resolve(from.select().abortSignal(late.signal).single())

    late.abort()
    release()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('an abort with no reason is an AbortError DOMException, and a signal that never aborts changes nothing', async () => {
    const { from } = makeFake([ROW])
    const reasonless = { aborted: true, reason: undefined, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as AbortSignal

    const error: unknown = await Promise.resolve(from.select().abortSignal(reasonless)).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('AbortError')
    expect((await from.select().abortSignal(new AbortController().signal).maybeSingle()).data).toEqual(ROW)
  })
})

// MARK: - Refusals

describe('methods and options with no local meaning are refused with their reason', () => {
  const REASONS: Record<string, string> = {
    rangeGt: 'Postgres range types have no local representation',
    rangeGte: 'Postgres range types have no local representation',
    rangeLt: 'Postgres range types have no local representation',
    rangeLte: 'Postgres range types have no local representation',
    rangeAdjacent: 'Postgres range types have no local representation',
    geojson: 'PostGIS output',
    explain: 'server query planner',
    rollback: 'local writes enter the outbox',
    setHeader: 'no HTTP request',
  }

  const call = (target: unknown, method: string): unknown => (target as Record<string, (...args: unknown[]) => unknown>)[method]!()

  test('on the select builder, the write builders, and after select()', () => {
    const { from } = makeFake()

    for (const [method, reason] of Object.entries(REASONS)) {
      for (const target of [from.select(), from.update({ done: true }), from.delete().select()]) {
        expect(refusal(() => call(target, method)).message).toContain(reason)
      }
    }
    expect(refusal(() => call(from.select().single(), 'setHeader')).message).toContain('no HTTP request')
  })

  test('the app client refuses rpc(), schema(), and getOpenApiSpec() with their reason', () => {
    const client = createKizunaSync({ databasePath: null }, { pull: () => Promise.reject(new Error('never')), push: () => Promise.reject(new Error('never')) }, defineConfig({ tables: { todos: { sync: 'read-write' } } }))

    expect(refusal(() => client.rpc('do_thing')).message).toContain('call it through supabase-js when online')
    expect(refusal(() => client.schema('billing')).message).toContain('synced tables are addressed by name')
    expect(refusal(() => client.getOpenApiSpec()).message).toContain('server metadata')
    client.dispose()
  })

  test('rpc() and upsert() name why the local store cannot run them', () => {
    const { from } = makeFake()

    expect(refusal(() => from.rpc('do_thing')).message).toContain('call it through supabase-js when online')
    expect(refusal(() => from.upsert({ id: ROW_ID })).message).toContain('use insert or update')
  })

  test('referencedTable and foreignTable name the missing joins', () => {
    const { from } = makeFake()

    for (const run of [
      () => from.select().order('title', { referencedTable: 'authors' }),
      () => from.select().limit(1, { foreignTable: 'authors' }),
      () => from.select().range(0, 1, { referencedTable: 'authors' }),
      () => from.select().or('done.eq.true', { referencedTable: 'authors' }),
    ]) {
      expect(refusal(run).message).toContain('without foreign-key joins')
    }
  })

  test('insert options that belong to the server or to upsert are refused, and nothing is written', async () => {
    const { from, applied } = makeFake()

    await expect(from.insert({ title: 'x' }, { defaultToNull: true })).rejects.toThrow('the database fills defaults')
    await expect(from.insert({ title: 'x' }, { onConflict: 'id' })).rejects.toThrow('belongs to upsert()')
    await expect(from.insert({ title: 'x' }, { ignoreDuplicates: true })).rejects.toThrow('belongs to upsert()')
    expect(applied).toEqual([])
  })

  test('a transform with no rows to act on is refused on a bare write', () => {
    const write = makeFake().from.update({ done: true })

    expect(refusal(() => write.csv()).message).toContain('formats a read')
    expect(refusal(() => write.stripNulls()).message).toContain('has no rows to strip')
    expect(refusal(() => write.abortSignal(new AbortController().signal)).message).toContain('cannot be aborted')
    expect(refusal(() => makeFake().from.select().maxAffected(1)).message).toContain('caps an update or a delete')
  })
})

// MARK: - Types

interface ITodo {
  id: string
  title: string
  done: boolean
}

/**
 * Compiled by `bun run type-check` and never called. Each `@ts-expect-error`
 * fails the type check when its line compiles, so the row type flows through
 * `returns()`, `overrideTypes()`, `single<T>()`, `maybeSingle<T>()`, a head
 * read, and `csv()` exactly as postgrest-js types them.
 */
async function checkTypes(from: ReturnType<typeof createFromBuilder>): Promise<void> {
  const typed: ILocalSelectBuilder<ITodo> = from.select().returns<ITodo[]>()
  const todos: ITodo[] = (await typed.eq('done', false).order('title')).data
  const one: ITodo = (await typed.single()).data
  const maybe: ITodo | null = (await typed.maybeSingle()).data
  const picked: { id: string } = (await from.select().single<{ id: string }>()).data
  const merged: { id: string; title: 'A' | 'B'; done: boolean } = (await typed.overrideTypes<{ title: 'A' | 'B' }[]>()).data[0]!
  const replaced: { only: number }[] = (await typed.overrideTypes<{ only: number }[], { merge: false }>()).data
  const oneMerged: { id: string; extra: number } = (await typed.maybeSingle().overrideTypes<{ extra: number }>()).data!
  const head: null = (await from.select('*', { head: true, count: 'exact' })).data
  const csv: string = (await from.select().csv()).data
  const counted: number | null = (await from.select('*', { count: 'exact' })).count
  const single: ISelectSingleQuery<ITodo> = typed.single()
  const maybeSingle: ISelectMaybeSingleQuery<ITodo> = typed.maybeSingle()
  const mismatch: ITypeMismatch<string> = typed.returns<ITodo>()
  const rowMismatch: ITypeMismatch<string> = typed.single().returns<ITodo[]>()
  const writeRows: ITodo[] = (await from.update({ done: true }).eq('id', 'a').select().returns<ITodo[]>()).data
  const writeOne: ITodo = (await from.delete().eq('id', 'a').select().single<ITodo>()).data
  const inserted: ITodo | null = (await from.insert({ title: 'x' }).select().maybeSingle<ITodo>()).data
  // @ts-expect-error returns() takes the whole result type, so a row type is a mismatch, not a builder
  const notBuilder: ILocalSelectBuilder<ITodo> = typed.returns<ITodo>()
  // @ts-expect-error a head read has no rows
  const headRows: ITodo[] = (await from.select('*', { head: true }).returns<ITodo[]>()).data
  // @ts-expect-error csv() answers text
  const csvRows: ITodo[] = (await from.select().csv()).data
  // @ts-expect-error a one-row query never yields a list
  const oneAsList: ITodo[] = (await typed.single()).data
  // @ts-expect-error merge: false drops the row's own keys
  const replacedTitle: string = (await typed.overrideTypes<{ only: number }[], { merge: false }>()).data[0]!.title

  void [todos, one, maybe, picked, merged, replaced, oneMerged, head, csv, counted, single, maybeSingle, mismatch, rowMismatch, writeRows, writeOne, inserted, notBuilder, headRows, csvRows, oneAsList, replacedTitle]
}

void checkTypes
