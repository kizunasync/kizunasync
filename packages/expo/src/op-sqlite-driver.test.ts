/// <reference types="bun" />
/**
 * The op-sqlite locator, against an in-memory fake module rather than the native
 * peer. The device gate itself is `verifyOpSqliteDriver()` run on a physical
 * device with the peer installed. The locator's device ports reach NetInfo and
 * AppState, so both are mocked; bun cannot load either. Its native engine
 * loader delegates to `@kizunasync/rn-uniffi`, mocked as well.
 */

import { describe, expect, mock, test } from 'bun:test'
import type { TKizunaSyncNativeEngine, TUniffiLoadFailure, TUniffiLoadResult } from '@kizunasync/rn-uniffi'
import type { IOpSqliteDb, IOpSqliteModule, IOpSqliteResult } from './op-sqlite-driver'

let netInfoSubscriptions = 0
let appStateSubscriptions = 0

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: () => {
      appStateSubscriptions += 1

      return { remove: () => undefined }
    },
  },
}))

mock.module('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => {
      netInfoSubscriptions += 1

      return () => undefined
    },
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}))

/** What the mocked `tryLoadUniffiNativeEngine` answers, swapped per test, and how often it ran. */
let uniffiLoad: TUniffiLoadResult = { ok: false, reason: 'not_linked' }
let uniffiLoads = 0

mock.module('@kizunasync/rn-uniffi', () => ({
  tryLoadUniffiNativeEngine: () => {
    uniffiLoads += 1

    return uniffiLoad
  },
  describeUniffiLoadFailure: (failure: TUniffiLoadFailure) => `described ${JSON.stringify(failure)}`,
}))

const { openOpSqliteDriver, probeHandle, verifyOpSqliteDriver } = await import('./op-sqlite-driver')

/** An engine with the six members a linked module exposes, none of which these tests call. */
const nativeEngine = (): TKizunaSyncNativeEngine => ({
  create: () => undefined,
  call: () => '{"ok":true,"value":null}',
  callAsync: async () => '{"ok":true,"value":null}',
  subscribe: () => 1n,
  unsubscribe: () => undefined,
  shutdown: () => undefined,
})

/**
 * The `open` options every call received, so a test can read the `location`
 * op-sqlite was handed.
 */
type TFakeModule = IOpSqliteModule & { opens: Array<{ name: string; location?: string }> }

const createFakeModule = (): TFakeModule => {
  const opens: Array<{ name: string; location?: string }> = []
  const tables = new Map<string, Map<string, number>>()
  const db: IOpSqliteDb = {
    executeSync(sql: string, params: unknown[] = []): IOpSqliteResult {
      const s = sql.trim().toUpperCase()

      if (s.startsWith('CREATE TABLE')) {
        tables.set('_kizunasync_verify', tables.get('_kizunasync_verify') ?? new Map())

        return { rows: [] }
      }
      if (s.startsWith('INSERT')) {
        const id = String(params[0])
        const v = Number(params[1])
        const t = tables.get('_kizunasync_verify') ?? new Map()

        t.set(id, v)
        tables.set('_kizunasync_verify', t)

        return { rows: [], rowsAffected: 1 }
      }
      if (s.startsWith('SELECT')) {
        const id = String(params[0])
        const t = tables.get('_kizunasync_verify') ?? new Map()
        const v = t.get(id)

        return v === undefined ? { rows: [] } : { rows: [{ id, v }] }
      }
      if (s.startsWith('DELETE')) {
        const id = String(params[0])

        tables.get('_kizunasync_verify')?.delete(id)

        return { rows: [], rowsAffected: 1 }
      }
      return { rows: [] }
    },
  }

  return {
    opens,
    open: (options) => {
      opens.push(options)

      return db
    },
  }
}

/**
 * A module whose `select` answers a row the gate does not expect, so
 * `verifyOpSqliteDriver` records a failed check rather than throwing.
 */
const createWrongSelectModule = (): IOpSqliteModule => ({
  open: () => ({
    executeSync: (sql: string): IOpSqliteResult =>
      sql.trim().toUpperCase().startsWith('SELECT') ? { rows: [{ id: 'one', v: 99 }] } : { rows: [] },
  }),
})

describe('op-sqlite driver', () => {
  test('probeHandle round-trips insert/select on fake db', () => {
    const mod = createFakeModule()
    const sync = probeHandle(mod.open({ name: 't' }))

    sync.execSync('CREATE TABLE IF NOT EXISTS _kizunasync_verify (id TEXT PRIMARY KEY, v INTEGER)')
    sync.runSync('INSERT OR REPLACE INTO _kizunasync_verify(id, v) VALUES (?, ?)', ['a', 2])
    const rows = sync.getAllSync<{ id: string; v: number }>(
      'SELECT id, v FROM _kizunasync_verify WHERE id = ?',
      ['a'],
    )

    expect(rows).toEqual([{ id: 'a', v: 2 }])
  })

  test('verifyOpSqliteDriver pass with injected module', async () => {
    const mod = createFakeModule()
    const result = await verifyOpSqliteDriver('unit-verify', { module: mod })

    expect(result.ok).toBe(true)
    expect(result.checks.every((c) => c.ok)).toBe(true)
  })

  test('openOpSqliteDriver names the file under location', () => {
    const driver = openOpSqliteDriver('unit.sqlite', { location: '/tmp/kizunasync-dbs' })

    expect(driver.databasePath).toBe('/tmp/kizunasync-dbs/unit.sqlite')
  })

  test('openOpSqliteDriver builds without loading the native engine', () => {
    uniffiLoads = 0
    openOpSqliteDriver('unit.sqlite', { location: '/tmp' })

    expect(uniffiLoads).toBe(0)
  })

  test('openOpSqliteDriver loadNativeEngine hands back the engine the kizunasync React Native module loaded', () => {
    const engine = nativeEngine()

    uniffiLoads = 0
    uniffiLoad = { ok: true, engine }
    const loaded = openOpSqliteDriver('unit.sqlite', { location: '/tmp' }).loadNativeEngine?.()

    expect(loaded).toEqual({ ok: true, handle: engine })
    expect(loaded?.ok === true ? loaded.handle : null).toBe(engine)
    expect(uniffiLoads).toBe(1)
  })

  test.each<TUniffiLoadFailure>([
    { ok: false, reason: 'not_linked' },
    { ok: false, reason: 'invalid_module' },
    { ok: false, reason: 'install_failed', cause: 'Requiring unknown module "1234"' },
  ])('openOpSqliteDriver loadNativeEngine reports $reason with the message the kizunasync React Native module gives for it', (failure) => {
    uniffiLoad = failure

    expect(openOpSqliteDriver('unit.sqlite', { location: '/tmp' }).loadNativeEngine?.()).toEqual({ ok: false, message: `described ${JSON.stringify(failure)}` })
  })

  test('openOpSqliteDriver fails loud without location', () => {
    expect(() => openOpSqliteDriver('no-path')).toThrow(/location/)
  })

  test('openOpSqliteDriver drops a trailing slash from location', () => {
    const driver = openOpSqliteDriver('unit.sqlite', { location: '/tmp/kizunasync-dbs/' })

    expect(driver.databasePath).toBe('/tmp/kizunasync-dbs/unit.sqlite')
  })

  test('a file:// location becomes a plain path for the locator and for op-sqlite', async () => {
    const mod = createFakeModule()
    const driver = openOpSqliteDriver('unit.sqlite', { location: 'file:///var/mobile/Documents/' })

    expect(driver.databasePath).toBe('/var/mobile/Documents/unit.sqlite')

    await verifyOpSqliteDriver('unit-verify', {
      module: mod,
      location: 'file:///var/mobile/Documents/',
    })
    expect(mod.opens).toEqual([{ name: 'unit-verify', location: '/var/mobile/Documents' }])
  })

  test('a plain path location reaches op-sqlite unchanged', async () => {
    const mod = createFakeModule()
    const driver = openOpSqliteDriver('unit.sqlite', { location: '/var/mobile/Documents' })

    expect(driver.databasePath).toBe('/var/mobile/Documents/unit.sqlite')

    await verifyOpSqliteDriver('unit-verify', { module: mod, location: '/var/mobile/Documents' })
    expect(mod.opens).toEqual([{ name: 'unit-verify', location: '/var/mobile/Documents' }])
  })

  test('openOpSqliteDriver is synchronous and names the file without loading the op-sqlite peer', () => {
    const driver = openOpSqliteDriver('no-peer', { location: '/tmp' })

    expect(driver).not.toBeInstanceOf(Promise)
    expect(driver.databasePath).toBe('/tmp/no-peer')
  })

  test('openOpSqliteDriver carries NetInfo connectivity and AppState foreground, subscribed only when the app client asks', () => {
    netInfoSubscriptions = 0
    appStateSubscriptions = 0
    const driver = openOpSqliteDriver('unit.sqlite', { location: '/tmp' })

    expect(netInfoSubscriptions).toBe(0)
    expect(appStateSubscriptions).toBe(0)

    const stopConnectivity = driver.platformPorts?.connectivity?.subscribe(() => {})
    const stopForeground = driver.platformPorts?.foreground?.subscribe(() => {})

    expect(netInfoSubscriptions).toBe(1)
    expect(appStateSubscriptions).toBe(1)
    stopConnectivity?.()
    stopForeground?.()
  })

  test('verifyOpSqliteDriver reports the failing check instead of throwing', async () => {
    const result = await verifyOpSqliteDriver('unit-verify', { module: createWrongSelectModule() })

    expect(result.ok).toBe(false)
    const select = result.checks.find((check) => check.name === 'select')

    expect(select?.ok).toBe(false)
    expect(select?.detail).toMatch(/unexpected rows/)
    expect(result.checks.map((check) => check.name)).toEqual([
      'open',
      'create_table',
      'insert',
      'select',
      'delete',
    ])
  })

  test('verifyOpSqliteDriver records the load failure as an error check', async () => {
    const result = await verifyOpSqliteDriver('unit-verify')

    expect(result.ok).toBe(false)
    expect(result.checks).toEqual([
      { name: 'error', ok: false, detail: expect.stringContaining('@op-engineering/op-sqlite') },
    ])
  })
})
