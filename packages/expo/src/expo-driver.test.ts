/// <reference types="bun" />
/**
 * Native openExpoDriver: built synchronously, it opens expo-sqlite only when the
 * engine first reads the path, names that file and closes the handle so the
 * kernel is the only connection. A path it cannot read fails the app client's
 * first engine call, and every later one, with ENGINE_UNAVAILABLE. The locator
 * carries the device's NetInfo and AppState ports, and a native engine loader
 * that delegates to a mocked `@kizunasync/rn-uniffi`. Web is `@kizunasync/web`
 * and is not exercised here.
 */
import { describe, expect, mock, test } from 'bun:test'
import { createKizunaSync, defineConfig, EEngineErrorCode, TEngineError } from '@kizunasync/core'
import type { TKizunaSyncNativeEngine, TUniffiLoadFailure, TUniffiLoadResult } from '@kizunasync/rn-uniffi'

let opened = 0
let closed = 0
let netInfoSubscriptions = 0
let appStateSubscriptions = 0

/**
 * The handle `openDatabaseSync` answers with, swapped per test so one mocked
 * module covers the reported path, a missing path and a failing close.
 */
let handle: { databasePath?: string; closeSync(): void } = {
  databasePath: '/tmp/expo/todos.db',
  closeSync: () => {
    closed += 1
  },
}

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

mock.module('expo-sqlite', () => ({
  openDatabaseSync: (name: string) => {
    opened += 1

    if (handle.databasePath === undefined) {
      return handle
    }
    return { ...handle, databasePath: `/tmp/expo/${name}` }
  },
}))

mock.module('@kizunasync/web', () => ({
  createWebWorkerDriver: () => {
    throw new Error('web driver must not run on the native locator path')
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

const { openExpoDriver } = await import('./expo-driver')

const unusedRemote = {
  pull: () => Promise.reject(new Error('a client whose open failed never reaches the remote')),
  push: () => Promise.reject(new Error('a client whose open failed never reaches the remote')),
}

const todosConfig = defineConfig({ tables: { todos: { sync: 'read-write' } } })

/** What a promise settles with, a rejection included, so a test can assert on the error itself. */
const settle = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (reason: unknown) => reason)

const countingHandle = (databasePath?: string): typeof handle => ({
  databasePath,
  closeSync: () => {
    closed += 1
  },
})

/** An engine with the six members a linked module exposes, none of which these tests call. */
const nativeEngine = (): TKizunaSyncNativeEngine => ({
  create: () => undefined,
  call: () => '{"ok":true,"value":null}',
  callAsync: async () => '{"ok":true,"value":null}',
  subscribe: () => 1n,
  unsubscribe: () => undefined,
  shutdown: () => undefined,
})

const resetCounts = (): void => {
  opened = 0
  closed = 0
  netInfoSubscriptions = 0
  appStateSubscriptions = 0
}

describe('openExpoDriver native store locator', () => {
  test('is built synchronously and opens no expo-sqlite handle', () => {
    resetCounts()
    handle = countingHandle('/tmp/expo/todos.db')
    const driver = openExpoDriver('todos.db')

    expect(driver).not.toBeInstanceOf(Promise)
    expect(opened).toBe(0)
    expect(closed).toBe(0)
  })

  test('names the expo-sqlite file when the path is first read, and closes the handle once', () => {
    resetCounts()
    handle = countingHandle('/tmp/expo/todos.db')
    const driver = openExpoDriver('todos.db')

    expect(driver.databasePath).toBe('/tmp/expo/todos.db')
    expect(driver.databasePath).toBe('/tmp/expo/todos.db')
    expect(opened).toBe(1)
    expect(closed).toBe(1)
  })

  test('fails loud when expo-sqlite reports no databasePath', () => {
    resetCounts()
    handle = countingHandle()
    const driver = openExpoDriver('todos.db')

    expect(() => driver.databasePath).toThrow(/did not report a databasePath for "todos\.db"/)
    expect(closed).toBe(1)
  })

  test('a closeSync that throws fails the path read instead of naming the file', () => {
    handle = {
      databasePath: '/tmp/expo/todos.db',
      closeSync: () => {
        throw new Error('expo-sqlite: close failed')
      },
    }
    const driver = openExpoDriver('todos.db')

    expect(() => driver.databasePath).toThrow(/close failed/)
  })

  test('carries NetInfo connectivity and AppState foreground, subscribed only when the app client asks', () => {
    resetCounts()
    handle = countingHandle('/tmp/expo/todos.db')
    const driver = openExpoDriver('todos.db')

    expect(netInfoSubscriptions).toBe(0)
    expect(appStateSubscriptions).toBe(0)

    const stopConnectivity = driver.platformPorts?.connectivity?.subscribe(() => {})
    const stopForeground = driver.platformPorts?.foreground?.subscribe(() => {})

    expect(netInfoSubscriptions).toBe(1)
    expect(appStateSubscriptions).toBe(1)
    stopConnectivity?.()
    stopForeground?.()
  })

  test('builds without loading the native engine', () => {
    uniffiLoads = 0
    openExpoDriver('todos.db')

    expect(uniffiLoads).toBe(0)
  })

  test('loadNativeEngine hands back the engine the kizunasync React Native module loaded', () => {
    const engine = nativeEngine()

    uniffiLoads = 0
    uniffiLoad = { ok: true, engine }
    const loaded = openExpoDriver('todos.db').loadNativeEngine?.()

    expect(loaded).toEqual({ ok: true, handle: engine })
    expect(loaded?.ok === true ? loaded.handle : null).toBe(engine)
    expect(uniffiLoads).toBe(1)
  })

  test.each<TUniffiLoadFailure>([
    { ok: false, reason: 'not_linked' },
    { ok: false, reason: 'invalid_module' },
    { ok: false, reason: 'install_failed', cause: 'Requiring unknown module "1234"' },
  ])('loadNativeEngine reports $reason with the message the kizunasync React Native module gives for it', (failure) => {
    uniffiLoad = failure

    expect(openExpoDriver('todos.db').loadNativeEngine?.()).toEqual({ ok: false, message: `described ${JSON.stringify(failure)}` })
  })

  test.each([
    ['reports no databasePath', () => countingHandle(), /did not report a databasePath for "todos\.db"/],
    [
      'throws from closeSync',
      () => ({
        databasePath: '/tmp/expo/todos.db',
        closeSync: () => {
          throw new Error('expo-sqlite: close failed')
        },
      }),
      /close failed/,
    ],
  ])('an expo-sqlite that %s fails the first engine call and every later one with ENGINE_UNAVAILABLE', async (_case, makeHandle, message) => {
    resetCounts()
    handle = makeHandle()
    const client = createKizunaSync(openExpoDriver('todos.db'), unusedRemote, todosConfig, { inspector: false })

    expect(opened).toBe(0)

    for (const failure of [await settle(client.sync()), await settle(client.getOutboxDepth())]) {
      expect(failure).toBeInstanceOf(TEngineError)
      expect((failure as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((failure as Error).message).toMatch(message)
    }
    expect(opened).toBe(1)
    client.dispose()
  })
})
