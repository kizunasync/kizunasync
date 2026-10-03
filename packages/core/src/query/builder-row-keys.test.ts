/// <reference types="bun" />
/**
 * A table syncs by its own key (D-row-key). The app client carries each
 * table's `key` to the kernel only when it is not `['id']`, mints a uuid only
 * for an `id` key whose row names no `id`, leaves every other pk to the kernel,
 * reads an inserted row back by its key columns, and refuses a transform on a
 * key column. The first half drives a fake driver transport, so the wiring is
 * under test; the second half runs the Rust core through the NAPI addon.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { makeReferenceServer } from '@kizunasync/protocol/executor/reference'
import { EFencing } from '@kizunasync/protocol/executor/server-contract'
import { defineConfig, type TKizunaSyncConfig } from '../config/config'
import type { TEngineTransportFactory } from '../ports/engine-transport'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { IStoreLocator } from '../ports/store-locator'
import type { TLocalMutation, TRowKey } from '../index'
import { EEngineErrorCode, type TPushRequest, type TPushResponse } from '../wire/types'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { loadNapiAddon } from './napi-loader'
import { increment } from './transforms'

const hasAddon = loadNapiAddon() !== null

const MINTED = '00000000-0000-4000-8000-00000000c0de'

const idleRemote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const CONFIG = defineConfig({
  tables: {
    seats: { sync: 'read-write', key: ['hall', 'seat'] },
    slugs: { sync: 'read-write', key: 'slug' },
    notices: { sync: 'read-write', key: 'id' },
    labels: { sync: 'read-write', key: ['id'] },
    items: { sync: 'read-write' },
  },
})

const built: IKizunaSync[] = []

afterEach(() => {
  while (built.length > 0) {
    built.pop()?.dispose()
  }
})

// MARK: - Wiring

type TCall = { method: string; params: Record<string, unknown> }

type TWiring = { client: IKizunaSync; configs: string[]; calls: TCall[] }

const openWiring = (config: TKizunaSyncConfig = CONFIG): TWiring => {
  const configs: string[] = []
  const calls: TCall[] = []
  const engineTransport: TEngineTransportFactory = (configJson) => {
    configs.push(configJson)

    return {
      call: async (method, paramsJson) => {
        calls.push({ method, params: JSON.parse(paramsJson) as Record<string, unknown> })

        return JSON.stringify({ ok: true, value: method === 'query' || method === 'apply_where' ? [] : null })
      },
      close: () => undefined,
    }
  }
  const driver: IStoreLocator = { databasePath: null, engineTransport }
  const client = createKizunaSync(driver, idleRemote, config, { inspector: false, pollIntervalMs: 0, uuid: () => MINTED })

  built.push(client)

  return { client, configs, calls }
}

const callsOf = (wiring: TWiring, method: string): Array<Record<string, unknown>> =>
  wiring.calls.filter((call) => call.method === method).map((call) => call.params)

describe('the table key in the app client', () => {
  test('a wire pk is a row key, the text of any key the table has', () => {
    const pk: TRowKey = '["1", "12"]'
    const mutation: TLocalMutation = { table: 'seats', pk, op: 'insert', columns: { hall: 1, seat: 12 } }

    expect(mutation.pk).toBe(pk)
  })

  test('defineConfig normalizes key to a list of columns', () => {
    expect(CONFIG.tables.seats?.key).toEqual(['hall', 'seat'])
    expect(CONFIG.tables.slugs?.key).toEqual(['slug'])
    expect(CONFIG.tables.notices?.key).toEqual(['id'])
    expect(CONFIG.tables.items?.key).toBeUndefined()
  })

  test('key names the columns of the generated Database row', () => {
    type TSeatsDb = { public: { Tables: { seats: { Row: { hall: number; seat: number; holder: string } } } } }

    const typed = defineConfig<TSeatsDb>({ tables: { seats: { sync: 'read-write', key: ['hall', 'seat'] } } })

    // @ts-expect-error `row` is not a column of seats
    defineConfig<TSeatsDb>({ tables: { seats: { sync: 'read-write', key: ['hall', 'row'] } } })
    expect(typed.tables.seats?.key).toEqual(['hall', 'seat'])
  })

  test('the engine config carries a key only when it is not id', async () => {
    const wiring = openWiring()

    await wiring.client.getOutboxDepth()
    const tables = (JSON.parse(wiring.configs[0]!) as { tables: Record<string, Record<string, unknown>> }).tables

    expect(tables.seats?.key).toEqual(['hall', 'seat'])
    expect(tables.slugs?.key).toEqual(['slug'])
    expect('key' in tables.notices!).toBe(false)
    expect('key' in tables.labels!).toBe(false)
    expect('key' in tables.items!).toBe(false)
  })

  test('only an id key row without an id gets a minted pk', async () => {
    const wiring = openWiring()

    await wiring.client.from('items').insert({ title: 'works on a plane' })
    await wiring.client.from('items').insert({ id: 42, title: 'an integer id' })
    await wiring.client.from('seats').insert({ hall: 1, seat: 12 })
    await wiring.client.from('slugs').insert({ slug: 'hello' })

    expect(callsOf(wiring, 'apply').map((params) => params.pk)).toEqual([MINTED, '', '', ''])
    expect(callsOf(wiring, 'apply')[1]?.columns).toEqual({ id: 42, title: 'an integer id' })
  })

  test('an inserted row reads back by its key columns', async () => {
    const wiring = openWiring()

    await wiring.client.from('seats').insert({ hall: 1, seat: 12, holder: 'ada' }).select()
    await wiring.client.from('items').insert({ title: 'minted' }).select()
    await wiring.client.from('notices').insert({ id: 7, body: 'doors at ten' }).select()

    const filters = callsOf(wiring, 'query').map((params) => (params.plan as { filters: unknown }).filters)

    expect(filters).toEqual([
      [
        { kind: 'eq', column: 'hall', value: 1 },
        { kind: 'eq', column: 'seat', value: 12 },
      ],
      [{ kind: 'eq', column: 'id', value: MINTED }],
      [{ kind: 'eq', column: 'id', value: 7 }],
    ])
  })

  test('a transform on a key column is refused, and on another column goes through', async () => {
    const wiring = openWiring()

    await expect(Promise.resolve(wiring.client.from('seats').update({ seat: increment(1) }).eq('hall', 1))).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
    })
    await wiring.client.from('seats').update({ id: increment(1) }).eq('hall', 1)

    expect(callsOf(wiring, 'apply_where').map((params) => params.transforms)).toEqual([{ id: { op: 'increment', by: 1 } }])
  })
})

// MARK: - The Rust core

const openClient = (): IKizunaSync => {
  let minted = 0
  const client = createKizunaSync({ databasePath: null }, idleRemote, CONFIG, {
    inspector: false,
    pollIntervalMs: 0,
    uuid: () => `00000000-0000-4000-8000-${String((minted += 1)).padStart(12, '0')}`,
  })

  built.push(client)

  return client
}

describe.skipIf(!hasAddon)('the table key through the Rust core', () => {
  test('a composite key row is written and read back by its key columns', async () => {
    const client = openClient()
    const { data } = await client.from('seats').insert({ hall: 1, seat: 12, holder: 'ada' }).select().single()

    expect(data).toEqual({ hall: 1, seat: 12, holder: 'ada' })
    expect((await client.from('seats').select().eq('seat', 12)).data).toEqual([{ hall: 1, seat: 12, holder: 'ada' }])
  })

  test('an integer id reads back as the integer it was written as', async () => {
    const client = openClient()
    const { data } = await client.from('notices').insert({ id: 42, body: 'doors at ten' }).select().single()

    expect(data).toEqual({ id: 42, body: 'doors at ten' })
    expect((await client.from('notices').select().in('id', [42])).data).toEqual([{ id: 42, body: 'doors at ten' }])
  })

  test('a row missing a key column is refused naming it', async () => {
    const client = openClient()

    await expect(client.from('seats').insert({ hall: 1, holder: 'ada' })).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
      message: expect.stringContaining('"seat"'),
    })
    expect((await client.from('seats').select()).data).toEqual([])
  })

  test('an update naming a key column is refused', async () => {
    const client = openClient()

    await client.from('seats').insert({ hall: 1, seat: 12, holder: 'ada' })
    await expect(Promise.resolve(client.from('seats').update({ seat: 13 }).eq('hall', 1))).rejects.toMatchObject({
      code: EEngineErrorCode.LOCAL_CONSTRAINT,
    })
    expect(await client.getOutboxDepth()).toBe(1)
  })
})

// MARK: - Uuid keys against the reference server

const CLIENT_ID = '00000000-0000-4000-8000-c10000000001'
const OWNER = '00000000-0000-4000-8000-a10000000001'
const UPPER_UUID = '5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F'
const LOWER_UUID = '5f0c1c2e-8f3a-4b6d-9c1e-2a7b3c4d5e6f'

describe.skipIf(!hasAddon)('an uppercase uuid key', () => {
  test('minted by an injected uuid source is stored and read back lowercase', async () => {
    const client = createKizunaSync({ databasePath: null }, idleRemote, CONFIG, { inspector: false, pollIntervalMs: 0, uuid: () => UPPER_UUID })

    built.push(client)
    const { data } = await client.from('items').insert({ title: 'minted upper' }).select().single()

    expect(data).toEqual({ id: LOWER_UUID, title: 'minted upper' })
    expect((await client.from('items').select().eq('id', LOWER_UUID)).data).toHaveLength(1)
  })

  test('is matched by an eq, neq or in filter in any case, and a column outside the key is not', async () => {
    const client = createKizunaSync({ databasePath: null }, idleRemote, CONFIG, { inspector: false, pollIntervalMs: 0 })

    built.push(client)
    await client.from('items').insert({ id: LOWER_UUID, title: UPPER_UUID })
    await client.from('items').insert({ title: 'another' })

    expect((await client.from('items').select().eq('id', UPPER_UUID)).data).toEqual([{ id: LOWER_UUID, title: UPPER_UUID }])
    expect((await client.from('items').select().in('id', [UPPER_UUID])).data).toHaveLength(1)
    expect((await client.from('items').select().neq('id', UPPER_UUID)).data?.map((row) => row.title)).toEqual(['another'])
    expect((await client.from('items').select().eq('title', LOWER_UUID)).data).toEqual([])
    await client.from('items').update({ done: true }).eq('id', UPPER_UUID)
    expect((await client.from('items').select().eq('id', LOWER_UUID).single()).data).toMatchObject({ done: true })
  })

  test('is stored and pushed lowercase, and the reference server applies the push', async () => {
    const server = makeReferenceServer()

    server.seed({
      client_id: CLIENT_ID,
      user_id: OWNER,
      min_schema_version: 1,
      tables: {
        todos: { bucket_column: 'owner_id' },
        grants: { bucket_column: 'owner_id', key_columns: ['tenant', 'slug'] },
      },
      tombstone_ttl_days: 30,
      fencing: EFencing.shared,
      next_seq: '1',
      history: [],
    })
    const exchanges: Array<{ request: TPushRequest; response: TPushResponse }> = []
    const remote: IProtocolRemote = {
      pull: idleRemote.pull,
      push: async (request) => {
        const response = server.push(request)

        exchanges.push({ request, response })

        return response
      },
    }
    const config = defineConfig({
      tables: { todos: { sync: 'read-write' }, grants: { sync: 'read-write', key: ['tenant', 'slug'] } },
    })
    const client = createKizunaSync({ databasePath: null }, remote, config, { inspector: false, pollIntervalMs: 0, clientId: CLIENT_ID })

    built.push(client)
    await client.from('todos').insert({ id: UPPER_UUID, owner_id: OWNER, title: 'works on a plane' })
    await client.from('grants').insert({ tenant: UPPER_UUID, slug: 'Mixed-Case', owner_id: OWNER })
    await client.pushOnce()

    const [exchange] = exchanges
    const grantPk = `["${LOWER_UUID}", "Mixed-Case"]`

    expect(exchange?.request.batch.mutations.map((mutation) => [mutation.pk, mutation.columns.id ?? mutation.columns.tenant])).toEqual([
      [LOWER_UUID, LOWER_UUID],
      [grantPk, LOWER_UUID],
    ])
    const response = exchange?.response

    expect(response !== undefined && 'verdicts' in response ? response.verdicts.map((verdict) => verdict.verdict) : []).toEqual(['applied', 'applied'])
    expect(await client.getOutboxDepth()).toBe(0)
    expect((await client.from('todos').select().eq('id', LOWER_UUID)).data).toEqual([{ id: LOWER_UUID, owner_id: OWNER, title: 'works on a plane' }])
    expect((await client.from('grants').select().eq('slug', 'Mixed-Case')).data).toEqual([{ tenant: LOWER_UUID, slug: 'Mixed-Case', owner_id: OWNER }])
  })
})
