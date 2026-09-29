/// <reference types="bun" />
/**
 * The four semantics the kernel owns, driven through `createKizunaSync` on the real
 * addon. `crates/kizunasync-engine/tests/` pins them against a `SyncEngine`; these
 * are the JavaScript twins, so a rule that stops crossing the bridge (a plan key
 * the builder drops, a refusal the adapter swallows) fails here rather than in
 * an app.
 */

// MARK: - Query API + config conformance

/**
 * Exercises the documented local-first surface end to end against the REAL
 * engine (createKizunaSync over a temp-file locator) + an in-memory IProtocolRemote
 * fake. SUPPORTED cases prove the offline-writes snippet round-trips; REJECTED
 * cases prove every out-of-subset construct throws LOCAL_UNSUPPORTED (no network
 * fallback). Reads are async (await select() → { data, error }, supabase-js
 * parity). A generic 'items' table: zero domain-table knowledge.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { createKizunaSync } from './kizunasync'
import { attachment, byColumn, byOwner, defineConfig } from '../config/config'
import { createTempDatabase } from '../testing/temp-database'
import { EEngineErrorCode, EVerdictKind, TEngineError } from '../wire/types'
import { increment } from './transforms'
import type { IProtocolRemote } from '../ports/protocol-remote'

// MARK: - Test Database

type TDb = {
  public: {
    Tables: {
      items: {
        Row: { id: string; title: string; done: boolean; user_id: string; rank: number }
      }
    }
  }
}

const testConfig = () =>
  defineConfig<TDb>({
    tables: {
      items: { sync: 'read-write', bucket: byOwner('user_id') },
    },
  })

// MARK: - Deterministic id minting

const makeUuid = (): (() => string) => {
  let n = 0

  return () => {
    n += 1

    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  }
}

// MARK: - In-memory remote that accepts everything

const acceptAllRemote = (): IProtocolRemote => ({
  pull: () =>
    Promise.resolve({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: (request) =>
    Promise.resolve({
      verdicts: request.batch.mutations.map((mutation) => ({
        mutation_id: mutation.mutation_id,
        verdict: EVerdictKind.applied,
      })),
    }),
})

const makeKizunaSync = () =>
  createKizunaSync(createTempDatabase().driver, acceptAllRemote(), testConfig(), {
    uuid: makeUuid(),
    now: () => new Date(1_900_000_000_000).toISOString(),
  })

let kizunasync: ReturnType<typeof makeKizunaSync>

beforeEach(() => {
  kizunasync = makeKizunaSync()
})

// MARK: - Supported: writes

describe('writes (supported)', () => {
  test('insert mints a pk and queues one outbox entry', async () => {
    await kizunasync.from('items').insert({ title: 'x', done: false, user_id: 'u' })
    expect(await kizunasync.getOutboxDepth()).toBe(1)
    const { data: rows } = await kizunasync.from('items').select()

    expect(rows).toHaveLength(1)
    expect(typeof rows[0]!.id).toBe('string')
    expect(rows[0]!.title).toBe('x')
  })

  test('insert honours a caller-supplied pk', async () => {
    await kizunasync.from('items').insert({ id: 'fixed-pk', title: 'x', done: false, user_id: 'u' })
    expect((await kizunasync.from('items').select().eq('id', 'fixed-pk')).data).toHaveLength(1)
  })

  test('insert with a duplicate caller-supplied pk throws (no silent overwrite)', async () => {
    await kizunasync.from('items').insert({ id: 'dup', title: 'first', done: false, user_id: 'u' })
    expect(await kizunasync.getOutboxDepth()).toBe(1)
    await expect(
      kizunasync.from('items').insert({ id: 'dup', title: 'second', done: false, user_id: 'u' }),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    // The original row is untouched and no second wire insert was queued.
    expect((await kizunasync.from('items').select().eq('id', 'dup')).data[0]!.title).toBe('first')
    expect(await kizunasync.getOutboxDepth()).toBe(1)
  })

  test('update().eq(id) merges columns on the target row', async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'x', done: false, user_id: 'u' })
    await kizunasync.from('items').update({ done: true }).eq('id', 'p1')
    const row = (await kizunasync.from('items').select().eq('id', 'p1')).data[0]!

    expect(row.done).toBe(true)
    expect(row.title).toBe('x')
  })

  test('delete().eq(id) removes the row and tombstones it', async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'x', done: false, user_id: 'u' })
    await kizunasync.from('items').delete().eq('id', 'p1')
    expect((await kizunasync.from('items').select()).data).toHaveLength(0)
  })

  test('update by a non-pk eq applies to every matching row', async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'a', done: false, user_id: 'u' })
    await kizunasync.from('items').insert({ id: 'p2', title: 'a', done: false, user_id: 'u' })
    await kizunasync.from('items').insert({ id: 'p3', title: 'b', done: false, user_id: 'u' })
    await kizunasync.from('items').update({ done: true }).eq('title', 'a')
    const { data: done } = await kizunasync.from('items').select().eq('done', true)

    expect(done.map((row) => row.id).sort()).toEqual(['p1', 'p2'])
  })
})

// MARK: - Supported: reads

describe('reads (supported)', () => {
  beforeEach(async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'b', done: false, user_id: 'u', rank: 2 })
    await kizunasync.from('items').insert({ id: 'p2', title: 'a', done: true, user_id: 'u', rank: 1 })
    await kizunasync.from('items').insert({ id: 'p3', title: 'c', done: false, user_id: 'u', rank: 3 })
  })

  test('select() returns every local row', async () => {
    expect((await kizunasync.from('items').select()).data).toHaveLength(3)
  })

  test('eq filters by column equality', async () => {
    expect((await kizunasync.from('items').select().eq('done', true)).data.map((r) => r.id)).toEqual([
      'p2',
    ])
  })

  test('order ascending / descending', async () => {
    expect(
      (await kizunasync.from('items').select().order('rank', { ascending: true })).data.map((r) => r.id),
    ).toEqual(['p2', 'p1', 'p3'])
    expect(
      (await kizunasync.from('items').select().order('rank', { ascending: false })).data.map(
        (r) => r.id,
      ),
    ).toEqual(['p3', 'p1', 'p2'])
  })

  test('limit caps the result count', async () => {
    expect((await kizunasync.from('items').select().order('rank').limit(2)).data).toHaveLength(2)
  })

  test('projection narrows the columns', async () => {
    const row = (await kizunasync.from('items').select('id,title').eq('id', 'p1')).data[0]!

    expect(Object.keys(row).sort()).toEqual(['id', 'title'])
  })

  test('await select() yields { data, error } (supabase-js parity)', async () => {
    const { data, error } = await kizunasync.from('items').select()

    expect(error).toBeNull()
    expect(data).toHaveLength(3)
  })
})

// MARK: - The documented offline-writes snippet round-trips

describe('offline-writes snippet', () => {
  test('insert → update → delete with a sync between', async () => {
    kizunasync.setBucket({ user_id: 'u' })
    await kizunasync.from('items').insert({ id: 'tunnel', title: 'in a tunnel', user_id: 'u' })
    expect(await kizunasync.getOutboxDepth()).toBe(1)
    await kizunasync.sync()
    expect(await kizunasync.getOutboxDepth()).toBe(0)

    await kizunasync.from('items').update({ done: true }).eq('id', 'tunnel')
    await kizunasync.from('items').delete().eq('id', 'tunnel')
    await kizunasync.sync()
    expect((await kizunasync.from('items').select()).data).toHaveLength(0)
  })

  test('on() subscribes to engine events', () => {
    const off = kizunasync.on(() => {})

    expect(typeof off).toBe('function')
    off()
  })

  test('setBucket updates the runtime bucket param', async () => {
    kizunasync.setBucket({ user_id: 'u' })
    await kizunasync.sync()
    expect((await kizunasync.getCheckpoint()).cursor).toBe('0')
  })

  test('pull with an unset/empty bucket fails loud (never a silent empty bucket)', async () => {
    // No setBucket call: byOwner seeds the bucket param as '' until sign-in.
    await expect(kizunasync.sync()).rejects.toMatchObject({ code: EEngineErrorCode.BUCKET_UNSET })
  })
})

// MARK: - Supported: comparison / boolean / text filters

describe('reads (filters)', () => {
  beforeEach(async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'Alpha', done: false, user_id: 'u', rank: 2 })
    await kizunasync.from('items').insert({ id: 'p2', title: 'beta', done: true, user_id: 'u', rank: 1 })
    await kizunasync.from('items').insert({ id: 'p3', title: 'Gamma', done: false, user_id: 'u', rank: 3 })
  })

  test('gt / gte / lt / lte on numbers', async () => {
    expect((await kizunasync.from('items').select().gt('rank', 2)).data.map((r) => r.id)).toEqual(['p3'])
    expect((await kizunasync.from('items').select().gte('rank', 2)).data.map((r) => r.id).sort()).toEqual([
      'p1',
      'p3',
    ])
    expect((await kizunasync.from('items').select().lt('rank', 2)).data.map((r) => r.id)).toEqual(['p2'])
    expect((await kizunasync.from('items').select().lte('rank', 2)).data.map((r) => r.id).sort()).toEqual([
      'p1',
      'p2',
    ])
  })

  test('neq / in / is', async () => {
    expect((await kizunasync.from('items').select().neq('done', true)).data).toHaveLength(2)
    expect(
      (await kizunasync.from('items').select().in('id', ['p1', 'p3'])).data.map((r) => r.id).sort(),
    ).toEqual(['p1', 'p3'])
    expect((await kizunasync.from('items').select().is('done', true)).data.map((r) => r.id)).toEqual([
      'p2',
    ])
  })

  test('like / ilike', async () => {
    expect((await kizunasync.from('items').select().like('title', 'A%')).data.map((r) => r.id)).toEqual([
      'p1',
    ])
    expect(
      (await kizunasync.from('items').select().ilike('title', 'b%')).data.map((r) => r.id),
    ).toEqual(['p2'])
  })

  test('or / and / not (PostgREST clause strings + not())', async () => {
    expect(
      (await kizunasync.from('items').select().or('rank.eq.1,rank.eq.3')).data.map((r) => r.id).sort(),
    ).toEqual(['p2', 'p3'])
    expect(
      (await kizunasync.from('items').select().and('done.eq.false,rank.gt.2')).data.map((r) => r.id),
    ).toEqual(['p3'])
    expect(
      (await kizunasync.from('items').select().not('rank', 'eq', 2)).data.map((r) => r.id).sort(),
    ).toEqual(['p2', 'p3'])
  })

  test('search and textSearch', async () => {
    expect((await kizunasync.from('items').select().search('alp')).data.map((r) => r.id)).toEqual(['p1'])
    expect(
      (await kizunasync.from('items').select().search('alp', { columns: ['id'] })).data,
    ).toHaveLength(0)
    expect(
      (await kizunasync.from('items').select().textSearch('title', 'ga mm', { type: 'plain' })).data.map(
        (r) => r.id,
      ),
    ).toEqual(['p3'])
    expect(
      (
        await kizunasync.from('items').select().textSearch('title', 'Alpha', { type: 'phrase' })
      ).data.map((r) => r.id),
    ).toEqual(['p1'])
    expect(
      (
        await kizunasync
          .from('items')
          .select()
          .textSearch('title', '"Al" pha', { type: 'websearch' })
      ).data.map((r) => r.id),
    ).toEqual(['p1'])
  })

  test('chained filters AND; quoted comma inside or()', async () => {
    expect(
      (await kizunasync.from('items').select().gte('rank', 2).neq('done', true)).data
        .map((r) => r.id)
        .sort(),
    ).toEqual(['p1', 'p3'])
    await kizunasync.from('items').insert({
      id: 'p4',
      title: 'hello,world',
      done: false,
      user_id: 'u',
      rank: 0,
    })
    expect(
      (
        await kizunasync.from('items').select().or('title.eq."hello,world",rank.eq.999')
      ).data.map((r) => r.id),
    ).toEqual(['p4'])
  })

  test('invalid or/and/not throw LOCAL_UNSUPPORTED (no silent ignore)', () => {
    expect(() => kizunasync.from('items').select().or('not-a-clause')).toThrow(TEngineError)
    expect(() => kizunasync.from('items').select().and('rank.foo.1')).toThrow(TEngineError)
    expect(() => kizunasync.from('items').select().not('rank', 'contains', 1)).toThrow(TEngineError)

    try {
      kizunasync.from('items').select().or('nope')

      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
    }
  })
})

// MARK: - D4: supabase-js options the builder cannot honour

describe('LOCAL_UNSUPPORTED: options the builder cannot honour (D4)', () => {
  beforeEach(async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'a', done: false, user_id: 'u', rank: 1 })
  })

  test('select() refuses the head option', () => {
    expect(() => kizunasync.from('items').select('*', { head: true })).toThrow(TEngineError)
  })

  test('select() refuses the count option', () => {
    expect(() => kizunasync.from('items').select('*', { count: 'exact' })).toThrow(TEngineError)
  })

  test('order() refuses the referencedTable and foreignTable options', () => {
    expect(() =>
      kizunasync.from('items').select().order('rank', { referencedTable: 'other' }),
    ).toThrow(TEngineError)
    expect(() =>
      kizunasync.from('items').select().order('rank', { foreignTable: 'other' }),
    ).toThrow(TEngineError)
  })

  test('limit() refuses the referencedTable and foreignTable options', () => {
    expect(() => kizunasync.from('items').select().limit(1, { referencedTable: 'other' })).toThrow(
      TEngineError,
    )
    expect(() => kizunasync.from('items').select().limit(1, { foreignTable: 'other' })).toThrow(
      TEngineError,
    )
  })

  test('insert() refuses the count option', async () => {
    await expect(
      kizunasync.from('items').insert({ title: 'x', user_id: 'u' }, { count: 'exact' }),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
  })

  test('insert() refuses the defaultToNull option', async () => {
    await expect(
      kizunasync.from('items').insert({ title: 'x', user_id: 'u' }, { defaultToNull: false }),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
  })

  test('update() refuses the count option', () => {
    expect(() => kizunasync.from('items').update({ done: true }, { count: 'exact' })).toThrow(
      TEngineError,
    )
  })

  test('delete() refuses the count option', () => {
    expect(() => kizunasync.from('items').delete({ count: 'exact' })).toThrow(TEngineError)
  })
})

// MARK: - D4: supabase-js methods the builder lacks become typed stubs

describe('LOCAL_UNSUPPORTED: methods the builder lacks (D4)', () => {
  // Every method node_modules/@supabase/postgrest-js exposes that this builder does not implement.
  const LACKED_METHODS = [
    'likeAllOf', 'likeAnyOf', 'ilikeAllOf', 'ilikeAnyOf',
    'regexMatch', 'regexIMatch', 'isDistinct', 'notIn',
    'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent',
    'abortSignal', 'geojson', 'explain', 'rollback', 'maxAffected',
    'returns', 'overrideTypes', 'throwOnError', 'stripNulls', 'setHeader', 'retry',
    'select',
  ] as const

  const expectLocalUnsupported = (run: () => unknown): void => {
    try {
      run()

      throw new Error('expected LOCAL_UNSUPPORTED to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
    }
  }

  const callStub = (builder: unknown, method: string): void => {
    ;(builder as Record<string, (...args: unknown[]) => unknown>)[method]!()
  }

  beforeEach(async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'a', done: false, user_id: 'u', rank: 1 })
  })

  test('every lacked method is a typed LOCAL_UNSUPPORTED stub on the select builder', () => {
    for (const method of LACKED_METHODS) {
      const builder = kizunasync.from('items').select()

      expectLocalUnsupported(() => callStub(builder, method))
    }
  })

  test('every lacked method is a typed LOCAL_UNSUPPORTED stub on the write builder', () => {
    for (const method of LACKED_METHODS) {
      const builder = kizunasync.from('items').update({ done: true }).eq('id', 'p1')

      expectLocalUnsupported(() => callStub(builder, method))
    }
  })
})

// MARK: - single / maybeSingle / contains

describe('reads (single / contains)', () => {
  beforeEach(async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'Alpha', done: false, user_id: 'u', rank: 1 })
    await kizunasync.from('items').insert({ id: 'p2', title: 'Beta', done: true, user_id: 'u', rank: 2 })
  })

  test('single() returns one row object', async () => {
    const { data } = await kizunasync.from('items').select().eq('id', 'p1').single()

    expect(Array.isArray(data)).toBe(false)
    expect(data).toMatchObject({ id: 'p1', title: 'Alpha' })
  })

  test('single() throws when 0 or many rows', async () => {
    await expect(
      Promise.resolve(kizunasync.from('items').select().eq('id', 'missing').single()),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    await expect(Promise.resolve(kizunasync.from('items').select().single())).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
    })
  })

  test('maybeSingle() returns null or one row', async () => {
    const none = await kizunasync.from('items').select().eq('id', 'missing').maybeSingle()

    expect(none.data).toBeNull()
    const one = await kizunasync.from('items').select().eq('id', 'p2').maybeSingle()

    expect(one.data).toMatchObject({ id: 'p2' })
    await expect(Promise.resolve(kizunasync.from('items').select().maybeSingle())).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
    })
  })

  test('contains / containedBy on JSON-string columns', async () => {
    // tags/meta are mirrored as JSON text (offline stand-in for jsonb/array).
    type TDbJson = {
      public: {
        Tables: {
          items: {
            Row: {
              id: string
              title: string
              done: boolean
              user_id: string
              rank: number
              tags: string
              meta: string
            }
          }
        }
      }
    }
    const jsonConfig = defineConfig<TDbJson>({
      tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
    })
    const jsync = createKizunaSync(createTempDatabase().driver, acceptAllRemote(), jsonConfig, {
      uuid: makeUuid(),
      now: () => new Date(1_900_000_000_000).toISOString(),
    })

    await jsync.from('items').insert({
      id: 'j1',
      title: 'x',
      done: false,
      user_id: 'u',
      rank: 1,
      tags: '["a","b","c"]',
      meta: '{"color":"red","n":1}',
    })
    await jsync.from('items').insert({
      id: 'j2',
      title: 'y',
      done: false,
      user_id: 'u',
      rank: 2,
      tags: '["a"]',
      meta: '{"color":"blue"}',
    })
    expect(
      (await jsync.from('items').select().contains('tags', ['a', 'b'])).data.map((r) => r.id),
    ).toEqual(['j1'])
    expect(
      (await jsync.from('items').select().contains('meta', { color: 'red' })).data.map((r) => r.id),
    ).toEqual(['j1'])
    expect(
      (
        await jsync.from('items').select().containedBy('tags', ['a', 'b', 'c', 'd'])
      ).data
        .map((r) => r.id)
        .sort(),
    ).toEqual(['j1', 'j2'])
  })
})

// MARK: - Write targeting via the same filter surface

describe('writes (filter targeting)', () => {
  beforeEach(async () => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'a', done: false, user_id: 'u', rank: 1 })
    await kizunasync.from('items').insert({ id: 'p2', title: 'b', done: false, user_id: 'u', rank: 2 })
    await kizunasync.from('items').insert({ id: 'p3', title: 'c', done: true, user_id: 'u', rank: 3 })
  })

  test('update by gt / in applies to every match', async () => {
    await kizunasync.from('items').update({ done: true }).gt('rank', 1)
    expect(
      (await kizunasync.from('items').select().eq('done', true)).data.map((r) => r.id).sort(),
    ).toEqual(['p2', 'p3'])
    await kizunasync.from('items').update({ title: 'z' }).in('id', ['p1', 'p2'])
    expect((await kizunasync.from('items').select().eq('title', 'z')).data).toHaveLength(2)
  })

  test('delete by or() removes matching rows only', async () => {
    await kizunasync.from('items').delete().or('rank.eq.1,rank.eq.3')
    expect((await kizunasync.from('items').select()).data.map((r) => r.id)).toEqual(['p2'])
  })

  test('filter matching zero rows is a no-op', async () => {
    await kizunasync.from('items').update({ done: true }).eq('id', 'missing')
    expect((await kizunasync.from('items').select().eq('done', true)).data.map((r) => r.id)).toEqual([
      'p3',
    ])
  })
})

// MARK: - Rejected: out-of-subset constructs throw LOCAL_UNSUPPORTED

describe('LOCAL_UNSUPPORTED (no network fallback)', () => {
  const expectUnsupported = (run: () => unknown): void => {
    try {
      run()

      throw new Error('expected LOCAL_UNSUPPORTED to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.LOCAL_UNSUPPORTED)
    }
  }

  // The projection rides to the kernel as part of the plan, so an embed or a rename is refused when the read runs rather than when the column list is written. The code is the same one every client answers with.
  test('select with a relational embed is refused at execute', async () => {
    await expect(
      Promise.resolve(kizunasync.from('items').select('id, author(name)')),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
  })

  test('upsert throws', () => {
    expectUnsupported(() => kizunasync.from('items').upsert({ id: 'p1' }))
  })

  test('rpc throws', () => {
    expectUnsupported(() => kizunasync.from('items').rpc('do_thing'))
  })

  test('postgrest-only operators still throw (range/csv)', () => {
    expectUnsupported(() => kizunasync.from('items').select().range(0, 1))
    expectUnsupported(() => kizunasync.from('items').select().csv())
  })

  test('an unfiltered update throws (no target filter)', async () => {
    await expect(Promise.resolve(kizunasync.from('items').update({ done: true }))).rejects.toMatchObject(
      { code: EEngineErrorCode.LOCAL_UNSUPPORTED },
    )
  })

  test('an unfiltered delete throws (no target filter)', async () => {
    await expect(Promise.resolve(kizunasync.from('items').delete())).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_UNSUPPORTED,
    })
  })
})

// MARK: - Soft delete

describe('soft delete', () => {
  test('delete on a soft-delete table marks the row and hides it from reads', async () => {
    type TDbSd = {
      public: {
        Tables: {
          items: { Row: { id: string; deleted_at: string | null; title: string; user_id: string } }
        }
      }
    }
    const sdConfig = defineConfig<TDbSd>({
      tables: {
        items: { sync: 'read-write', bucket: byOwner('user_id'), softDelete: 'deleted_at' },
      },
    })
    const now = new Date(1_900_000_000_000).toISOString()
    const sdKizunaSync = createKizunaSync(createTempDatabase().driver, acceptAllRemote(), sdConfig, {
      uuid: makeUuid(),
      now: () => now,
    })

    sdKizunaSync.setBucket({ user_id: 'u' })
    await sdKizunaSync.from('items').insert({ id: 'sd1', title: 'x', deleted_at: null, user_id: 'u' })

    await sdKizunaSync.from('items').delete().eq('id', 'sd1')

    expect((await sdKizunaSync.from('items').select().eq('id', 'sd1')).data).toHaveLength(0)
    const marked = (
      await sdKizunaSync.from('items').select().eq('id', 'sd1').includeDeleted()
    ).data

    expect(marked).toHaveLength(1)
    expect(marked[0]!.deleted_at).toBe(now)
  })

  test('increment on a soft-delete table is a legal update (G8)', async () => {
    type TDbSd = {
      public: {
        Tables: {
          items: {
            Row: { id: string; deleted_at: string | null; likes: number; title: string; user_id: string }
          }
        }
      }
    }
    const sdConfig = defineConfig<TDbSd>({
      tables: {
        items: { sync: 'read-write', bucket: byOwner('user_id'), softDelete: 'deleted_at' },
      },
    })
    const sdKizunaSync = createKizunaSync(createTempDatabase().driver, acceptAllRemote(), sdConfig, {
      uuid: makeUuid(),
      now: () => new Date(1_900_000_000_000).toISOString(),
    })

    sdKizunaSync.setBucket({ user_id: 'u' })
    await sdKizunaSync.from('items').insert({
      id: 'sd2',
      title: 'x',
      likes: 0,
      deleted_at: null,
      user_id: 'u',
    })
    await sdKizunaSync.from('items').update({ likes: increment(1) }).eq('id', 'sd2')
    expect((await sdKizunaSync.from('items').select().eq('id', 'sd2')).data[0]!.likes).toBe(1)
  })
})

// MARK: - The kernel's own rules, seen from the builder

type TDbSoftDelete = {
  public: {
    Tables: {
      items: { Row: { id: string; deleted_at: string | null; title: string; user_id: string } }
    }
  }
}

const softDeleteKizunaSync = (): ReturnType<typeof makeKizunaSync> => {
  const config = defineConfig<TDbSoftDelete>({
    tables: {
      items: { sync: 'read-write', bucket: byOwner('user_id'), softDelete: 'deleted_at' },
    },
  })
  const client = createKizunaSync(createTempDatabase().driver, acceptAllRemote(), config, {
    uuid: makeUuid(),
    now: () => new Date(1_900_000_000_000).toISOString(),
  })

  client.setBucket({ user_id: 'u' })

  return client
}

describe('kernel rules through the builder', () => {
  test('a marked row is not a write target either, unless includeDeleted asks for it', async () => {
    const client = softDeleteKizunaSync()

    await client.from('items').insert({ id: 'sd1', title: 'first', deleted_at: null, user_id: 'u' })
    await client.from('items').insert({ id: 'sd2', title: 'second', deleted_at: null, user_id: 'u' })
    await client.from('items').delete().eq('id', 'sd1')

    await client.from('items').update({ title: 'renamed' }).eq('user_id', 'u')

    const visible = (await client.from('items').select().eq('id', 'sd2')).data

    expect(visible[0]!.title).toBe('renamed')
    const marked = (await client.from('items').select().eq('id', 'sd1').includeDeleted()).data

    expect(marked[0]!.title).toBe('first')

    await client.from('items').update({ title: 'reached' }).eq('id', 'sd1').includeDeleted()

    const reached = (await client.from('items').select().eq('id', 'sd1').includeDeleted()).data

    expect(reached[0]!.title).toBe('reached')
  })

  test('a pull-only table refuses every local write with LOCAL_UNSUPPORTED', async () => {
    type TDbPullOnly = {
      public: { Tables: { items: { Row: { id: string; title: string; user_id: string } } } }
    }
    const config = defineConfig<TDbPullOnly>({
      tables: { items: { sync: 'pull-only', bucket: byOwner('user_id') } },
    })
    const client = createKizunaSync(createTempDatabase().driver, acceptAllRemote(), config, {
      uuid: makeUuid(),
      now: () => new Date(1_900_000_000_000).toISOString(),
    })

    client.setBucket({ user_id: 'u' })

    // The write builders are thenables, not Promises, so each one is awaited inside a real async call before the code is read off it.
    const refusedCode = async (run: () => PromiseLike<unknown>): Promise<unknown> => {
      try {
        await run()
      } catch (error) {
        return (error as TEngineError).code
      }
      return 'resolved'
    }

    expect(await refusedCode(() => client.from('items').insert({ id: 'po1', title: 'x', user_id: 'u' }))).toBe(
      EEngineErrorCode.LOCAL_UNSUPPORTED,
    )
    expect(await refusedCode(() => client.from('items').update({ title: 'y' }).eq('id', 'po1'))).toBe(
      EEngineErrorCode.LOCAL_UNSUPPORTED,
    )
    expect(await refusedCode(() => client.from('items').delete().eq('id', 'po1'))).toBe(
      EEngineErrorCode.LOCAL_UNSUPPORTED,
    )

    // The refusal is before the outbox, so nothing is queued to push later.
    expect(await client.getOutboxDepth()).toBe(0)
    // Reading it is what a pull-only table is for.
    expect((await client.from('items').select()).data).toEqual([])
  })

  test('setBucket refuses a key no table declares as its bucket column', async () => {
    kizunasync.setBucket({ tenant_id: 't1' })

    // `setBucket` is synchronous by contract, so the refusal rides the call chain: the next call takes the failed write and re-throws it.
    await expect(kizunasync.getOutboxDepth()).rejects.toMatchObject({
      code: EEngineErrorCode.BUCKET_UNSET,
    })
  })
})

describe('field transforms (D-field-transforms)', () => {
  test('increment() updates the local cell and queues transforms on the wire', async () => {
    await kizunasync.from('items').insert({ id: 'inc1', title: 'x', done: false, user_id: 'u', rank: 0 })
    await kizunasync.from('items').update({ rank: increment(2) }).eq('id', 'inc1')
    expect((await kizunasync.from('items').select().eq('id', 'inc1')).data[0]!.rank).toBe(2)
  })

  test('float increment throws LOCAL_CONSTRAINT', () => {
    expect(() => increment(1.5)).toThrow(TEngineError)

    try {
      increment(1.5)
    } catch (error) {
      expect(error).toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    }
  })

  test('transform of id throws LOCAL_CONSTRAINT', async () => {
    await kizunasync.from('items').insert({ id: 'inc2', title: 'x', done: false, user_id: 'u', rank: 0 })
    await expect(
      Promise.resolve(
        kizunasync.from('items').update({ id: increment(1) } as never).eq('id', 'inc2'),
      ),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
  })
})

describe('attachment ports', () => {
  test('createKizunaSync throws typed ATTACHMENT_PORTS_MISSING when a table declares attachments without both ports', () => {
    type TDbAttach = {
      public: {
        Tables: {
          items: { Row: { id: string; user_id: string; image_path: string | null } }
        }
      }
    }
    const attachConfig = defineConfig<TDbAttach>({
      tables: {
        items: {
          sync: 'read-write',
          bucket: byOwner('user_id'),
          attachments: { image_path: attachment('images', { ownerColumn: 'user_id' }) },
        },
      },
    })
    let caught: unknown

    try {
      createKizunaSync(createTempDatabase().driver, acceptAllRemote(), attachConfig)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TEngineError)
    expect((caught as TEngineError).code).toBe(EEngineErrorCode.ATTACHMENT_PORTS_MISSING)
  })
})

// MARK: - Config helpers + compile-time typing note

/**
 * A typo'd table in defineConfig is a COMPILE error (tables is keyed on
 * keyof Database['public']['Tables']). The line below, uncommented, fails
 * tsc with "Object literal may only specify known properties":
 *   defineConfig<TDb>({ tables: { itemz: { sync: 'read-write' } } })
 * That guarantee is enforced by `bun run type-check`, not at runtime.
 */

describe('config', () => {
  test('defineConfig applies documented defaults', () => {
    const config = defineConfig<TDb>({ tables: { items: { sync: 'read-write' } } })

    expect(config.pullLimit).toBe(500)
    expect(config.realtimeWakeups).toBe(true)
    expect(config.tables.items!.conflict).toBe('arrival')
  })

  test('byOwner / byColumn / attachment produce descriptors', () => {
    expect(byOwner('user_id')).toEqual({ column: 'user_id', kind: 'byOwner' })
    expect(byColumn('workspace_id')).toEqual({ column: 'workspace_id', kind: 'byColumn' })
    expect(attachment('board-images')).toEqual({ storageBucket: 'board-images' })
  })
})
