/// <reference types="bun" />
/**
 * Drives the shipped `createKizunaSync` → `selectEngine` path. The fake handle must
 * receive `create` and `set_access_token`: `engine === 'rust'` alone is not
 * enough, because NAPI also reports rust in this process.
 */
import { describe, expect, test } from 'bun:test'
import { defineConfig } from '../config/config'
import { createTempDatabase } from '../testing/temp-database'
import { createKizunaSync } from './kizunasync'
import { EEngineErrorCode } from '../wire/types'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { IStoreLocator } from '../ports/store-locator'
import type { TUniffiHandle } from './rust-uniffi-engine'

const remote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const config = defineConfig({
  tables: { items: { sync: 'read-write' } },
})

type TRecordedHandle = TUniffiHandle & {
  creates: string[]
  calls: Array<{ method: string; params: string }>
}

const recordingHandle = (): TRecordedHandle => {
  const creates: string[] = []
  const calls: Array<{ method: string; params: string }> = []

  return {
    creates,
    calls,
    create(configJson) {
      creates.push(configJson)
    },
    call(method) {
      throw new Error(`the adapter called the blocking call(${method})`)
    },
    async callAsync(method, paramsJson) {
      calls.push({ method, params: paramsJson })

      if (method === 'checkpoint') {
        return JSON.stringify({ ok: true, value: { cursor: '0', soft_blocked: false } })
      }
      if (method === 'outbox_depth' || method === 'inspect') {
        return JSON.stringify({
          ok: true,
          value:
            method === 'outbox_depth'
              ? 0
              : { queued: [], depth: 0, last_mutation_id: null, cursor: '0' },
        })
      }
      return JSON.stringify({ ok: true, value: null })
    },
    subscribe: () => 1n,
    unsubscribe: () => undefined,
    shutdown: () => undefined,
  }
}

describe('createKizunaSync UniFFI selection', () => {
  test('forwards nativeHttpRemote into UniFFI create and set_access_token', async () => {
    const handle = recordingHandle()
    const store = createTempDatabase('kizunasync-select')
    const kizunasync = createKizunaSync(store.driver, remote, config, {
      uniffiHandle: handle,
      nativeHttpRemote: { url: 'https://example.supabase.co', anonKey: 'pub' },
      pollIntervalMs: 0,
      inspector: false,
    })

    expect(kizunasync.engine).toBe('rust')
    expect(handle.creates).toHaveLength(1)
    const created = JSON.parse(handle.creates[0]!) as {
      database_path: string
      remote: { url: string; publishable_key: string }
    }

    expect(created.database_path).toBe(store.path)
    expect(created.remote.url).toBe('https://example.supabase.co')
    expect(created.remote.publishable_key).toBe('pub')
    await kizunasync.setRemoteAccessToken('session-jwt')
    const tokenCall = handle.calls.find((entry) => entry.method === 'set_access_token')

    expect(tokenCall).toBeDefined()
    expect((JSON.parse(tokenCall!.params) as { token: string }).token).toBe('session-jwt')
    kizunasync.dispose()
  })

  // The handle wins over an addon this process may also have: a linked UniFFI engine is the React Native path, and it is checked first.
  test('a linked handle is chosen even where the addon would also load', () => {
    const handle = recordingHandle()
    const store = createTempDatabase('kizunasync-select')
    const kizunasync = createKizunaSync(store.driver, remote, config, {
      uniffiHandle: handle,
      nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      pollIntervalMs: 0,
      inspector: false,
    })

    expect(kizunasync.engine).toBe('rust')
    expect(handle.creates).toHaveLength(1)
    kizunasync.dispose()
  })

  test('a linked handle without nativeHttpRemote is CONFIG_INVALID on the first use', async () => {
    const handle = recordingHandle()
    const store = createTempDatabase('kizunasync-select')
    const kizunasync = createKizunaSync(store.driver, remote, config, {
      uniffiHandle: handle,
      pollIntervalMs: 0,
      inspector: false,
    })

    await expect(kizunasync.sync()).rejects.toThrow(/nativeHttpRemote/)
    await expect(kizunasync.sync()).rejects.toMatchObject({ code: EEngineErrorCode.CONFIG_INVALID })
    expect(handle.creates).toHaveLength(0)
  })
})

describe('createKizunaSync over a locator that loads its native engine', () => {
  test('the handle the locator loads backs the client, loaded on the first use', () => {
    const handle = recordingHandle()
    const store = createTempDatabase('kizunasync-select')
    let loads = 0
    const driver: IStoreLocator = {
      databasePath: store.path,
      loadNativeEngine: () => {
        loads += 1

        return { ok: true, handle }
      },
    }
    const kizunasync = createKizunaSync(driver, remote, config, {
      nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      pollIntervalMs: 0,
      inspector: false,
    })

    expect(loads).toBe(0)
    expect(kizunasync.engine).toBe('rust')
    expect(loads).toBe(1)
    expect(handle.creates).toHaveLength(1)
    expect((JSON.parse(handle.creates[0]!) as { database_path: string }).database_path).toBe(store.path)
    kizunasync.dispose()
  })

  test('an injected uniffiHandle wins, and the locator loader never runs', () => {
    const handle = recordingHandle()
    const store = createTempDatabase('kizunasync-select')
    let loads = 0
    const driver: IStoreLocator = {
      databasePath: store.path,
      loadNativeEngine: () => {
        loads += 1

        return { ok: false, message: 'the locator loader must not run when a handle is injected' }
      },
    }
    const kizunasync = createKizunaSync(driver, remote, config, {
      uniffiHandle: handle,
      nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      pollIntervalMs: 0,
      inspector: false,
    })

    expect(kizunasync.engine).toBe('rust')
    expect(handle.creates).toHaveLength(1)
    expect(loads).toBe(0)
    kizunasync.dispose()
  })
})
