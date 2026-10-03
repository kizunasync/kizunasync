/// <reference types="bun" />
// MARK: - Local query builder guards

/**
 * The local pk is the row's identity: an insert must not silently swap a caller's
 * id for a random uuid, and an update must not change the pk, which would re-key
 * the stored row while it stays under the old one. Both fail loud (@../../../../CONVENTIONS.md).
 *
 * Everything here runs on the real client, because the refusals are the kernel's:
 * a projection it cannot answer, a row cap below zero and a write with no target
 * filter all reach it as a plan or a request and come back as a catalog code.
 *
 * Skipped wholesale when the addon is not built (`cargo build -p kizunasync-napi`):
 * without it `createKizunaSync` has no engine to run.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { createKizunaSync } from './kizunasync'
import { byOwner, defineConfig } from '../config/config'
import { createTempDatabase } from '../testing/temp-database'
import { loadNapiAddon } from './napi-loader'
import { EEngineErrorCode, EVerdictKind } from '../wire/types'
import type { IProtocolRemote } from '../ports/protocol-remote'

const hasAddon = loadNapiAddon() !== null

type TDb = { public: { Tables: { items: { Row: { id: string; title: string; done: boolean; user_id: string } } } } }

const acceptAll: IProtocolRemote = {
  pull: () => Promise.resolve({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: (request) =>
    Promise.resolve({
      verdicts: request.batch.mutations.map((m) => ({ mutation_id: m.mutation_id, verdict: EVerdictKind.applied })),
    }),
}

const makeUuid = (): (() => string) => {
  let n = 0

  return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`
}

const makeKizunaSync = () =>
  createKizunaSync(
    createTempDatabase().driver,
    acceptAll,
    defineConfig<TDb>({ tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } } }),
    {
      uuid: makeUuid(),
      now: () => new Date(1_900_000_000_000).toISOString(),
      pollIntervalMs: 0,
      inspector: true,
    },
  )

let kizunasync: ReturnType<typeof makeKizunaSync>

describe.skipIf(!hasAddon)('local query builder id integrity', () => {
  beforeEach(() => {
    kizunasync = makeKizunaSync()
  })

  test.each([1.5, true, null])('insert rejects an id of %p instead of minting a different one', async (id) => {
    await expect(
      kizunasync.from('items').insert({ id: id as unknown as string, title: 'x', user_id: 'u1' }),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    expect((await kizunasync.from('items').select()).data).toEqual([])
  })

  test('insert without an id still mints a uuid (unchanged happy path)', async () => {
    const result = await kizunasync.from('items').insert({ title: 'x', user_id: 'u1' })

    expect(result.error).toBeNull()
    expect((await kizunasync.from('items').select()).data).toHaveLength(1)
  })

  test('from() on a table absent from config throws UNKNOWN_TABLE', () => {
    expect(() => kizunasync.from('ghosts')).toThrow()
    expect(() => kizunasync.from('items')).not.toThrow() // configured table is fine
  })

  test('update cannot change the id (the primary key is immutable)', async () => {
    const id = '00000000-0000-4000-8000-0000000000aa'

    await kizunasync.from('items').insert({ id, title: 'a', user_id: 'u1' })
    // The write builder is a thenable (not a Promise), so wrap it before awaiting.
    await expect(
      Promise.resolve(
        kizunasync.from('items').update({ id: '00000000-0000-4000-8000-0000000000bb' }).eq('id', id),
      ),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_CONSTRAINT })
    // The original row is untouched and still keyed by its own id.
    const rows = await kizunasync.from('items').select()

    expect(rows.data.map((r) => r.id)).toEqual([id])
  })
})

// MARK: - Refusals the kernel owns

describe.skipIf(!hasAddon)('local query builder refusals', () => {
  beforeEach(() => {
    kizunasync = makeKizunaSync()
  })

  test('a negative limit is refused with LOCAL_UNSUPPORTED at execute', async () => {
    await kizunasync.from('items').insert({ id: '00000000-0000-4000-8000-0000000000a1', title: 'a', user_id: 'u1' })
    await expect(
      Promise.resolve(kizunasync.from('items').select().limit(-1)),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
  })

  test('a fractional limit is refused before a plan is built', () => {
    expect(() => kizunasync.from('items').select().limit(1.5)).toThrow()
  })

  test('a relational embed is refused with LOCAL_UNSUPPORTED at execute', async () => {
    await expect(
      Promise.resolve(kizunasync.from('items').select('id, author(name)')),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
  })

  test('an unfiltered update or delete is refused with LOCAL_UNSUPPORTED', async () => {
    await expect(Promise.resolve(kizunasync.from('items').update({ done: true }))).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_UNSUPPORTED,
    })
    await expect(Promise.resolve(kizunasync.from('items').delete())).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_UNSUPPORTED,
    })
  })

  test('a throwing on() listener does not reject an already-committed write', async () => {
    kizunasync.on(() => {
      throw new Error('boom')
    })
    const res = await kizunasync.from('items').insert({ id: '00000000-0000-4000-8000-0000000000a3', title: 'c', user_id: 'u1' })

    expect(res.error).toBeNull()
  })
})

// MARK: - A table the server owns

describe.skipIf(!hasAddon)('pull-only tables', () => {
  const makePullOnlyKizunaSync = () =>
    createKizunaSync(
      createTempDatabase().driver,
      acceptAll,
      defineConfig<TDb>({ tables: { items: { sync: 'pull-only', bucket: byOwner('user_id') } } }),
      {
        uuid: makeUuid(),
        now: () => new Date(1_900_000_000_000).toISOString(),
        pollIntervalMs: 0,
        inspector: true,
      },
    )

  test('insert is refused with LOCAL_UNSUPPORTED and queues nothing', async () => {
    const pullOnly = makePullOnlyKizunaSync()

    await expect(
      pullOnly.from('items').insert({ title: 'x', user_id: 'u1' }),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
    expect((await pullOnly.inspector!.snapshot()).queued).toEqual([])
    pullOnly.dispose()
  })

  test('update and delete are refused the same way, and a read still answers', async () => {
    const pullOnly = makePullOnlyKizunaSync()

    await expect(
      Promise.resolve(pullOnly.from('items').update({ done: true }).eq('id', 'p1')),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
    await expect(
      Promise.resolve(pullOnly.from('items').delete().eq('id', 'p1')),
    ).rejects.toMatchObject({ code: EEngineErrorCode.LOCAL_UNSUPPORTED })
    expect((await pullOnly.from('items').select()).data).toEqual([])
    pullOnly.dispose()
  })
})

// MARK: - Write options

describe.skipIf(!hasAddon)('local query builder write options (precondition)', () => {
  beforeEach(() => {
    kizunasync = makeKizunaSync()
  })

  // The queued entry is the mutation the push will carry, so reading it back proves what the write request put on the wire.
  const queued = async (): Promise<Awaited<ReturnType<NonNullable<typeof kizunasync.inspector>['snapshot']>>['queued']> =>
    (await kizunasync.inspector!.snapshot()).queued

  const seed = async (): Promise<void> => {
    await kizunasync.from('items').insert({ id: 'p1', title: 'a', done: false, user_id: 'u1' })
  }

  test('update() with a precondition puts it on the outbox mutation', async () => {
    await seed()
    await kizunasync.from('items').update({ done: true }, { precondition: { done: false } }).eq('id', 'p1')
    const entries = await queued()

    expect(entries).toHaveLength(2)
    expect(entries[1]?.precondition).toEqual({ done: false })
  })

  test('delete() with a precondition puts it on the outbox mutation', async () => {
    await seed()
    await kizunasync.from('items').delete({ precondition: { done: false } }).eq('id', 'p1')
    const entries = await queued()

    expect(entries).toHaveLength(2)
    expect(entries[1]?.precondition).toEqual({ done: false })
  })

  test('update() without options carries no precondition', async () => {
    await seed()
    await kizunasync.from('items').update({ done: true }).eq('id', 'p1')
    const entries = await queued()

    expect(entries[1]?.precondition).toBeNull()
  })

  test('delete() without options carries no precondition', async () => {
    await seed()
    await kizunasync.from('items').delete().eq('id', 'p1')
    const entries = await queued()

    expect(entries[1]?.precondition).toBeNull()
  })
})
