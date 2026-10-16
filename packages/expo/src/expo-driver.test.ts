/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test'
import { createKizunaSync, defineConfig, EEngineErrorCode, TEngineError } from '@kizunasync/core'
import type { IKizunaExpoModule } from './native-module.types'

let paths = 0
let nativeLoads = 0
let path: string | Error = '/tmp/expo/todos.db'
let available = true
let netInfoSubscriptions = 0
let appStateSubscriptions = 0
const native: IKizunaExpoModule = {
  newEngineId: () => crypto.randomUUID(),
  databasePath: () => {
    paths += 1

    if (path instanceof Error) throw path

    return path
  },
  createEngine: async () => undefined,
  call: () => '{"ok":true,"value":null}',
  callAsync: async () => '{"ok":true,"value":null}',
  closeEngine: async () => undefined,
  addListener: () => ({ remove: () => undefined }),
}

mock.module('./native-module', () => ({ getNativeModule: () => { nativeLoads += 1;

 return available ? native : null } }))
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: () => { appStateSubscriptions += 1;

 return { remove: () => undefined } },
  },
}))
mock.module('@react-native-community/netinfo', () => ({ default: {
  addEventListener: () => { netInfoSubscriptions += 1;

 return () => undefined },
  fetch: async () => ({ isConnected: true, isInternetReachable: true }),
} }))
mock.module('@kizunasync/web', () => ({ createWebWorkerDriver: () => { throw new Error('unexpected browser driver') } }))
const { openExpoDriver } = await import('./expo-driver')

const remote = {
  pull: () => Promise.reject(new Error('failed open must not use the remote')),
  push: () => Promise.reject(new Error('failed open must not use the remote')),
}
const config = defineConfig({ tables: { todos: { sync: 'read-write' } } })

describe('Expo Modules API 2.0 store locator', () => {
  test('builds synchronously, resolves the legacy path lazily, and caches it', () => {
    paths = 0
    nativeLoads = 0
    path = '/tmp/expo/todos.db'
    const driver = openExpoDriver('todos.db')

    expect(driver).not.toBeInstanceOf(Promise)
    expect(nativeLoads).toBe(0)
    expect(paths).toBe(0)
    expect(driver.databasePath).toBe('/tmp/expo/todos.db')
    expect(driver.databasePath).toBe('/tmp/expo/todos.db')
    expect(paths).toBe(1)
  })

  test('carries lazy native connectivity and foreground subscriptions', () => {
    netInfoSubscriptions = 0
    appStateSubscriptions = 0
    const driver = openExpoDriver('todos.db')

    expect(netInfoSubscriptions + appStateSubscriptions).toBe(0)
    const stopNetwork = driver.platformPorts?.connectivity?.subscribe(() => {})
    const stopForeground = driver.platformPorts?.foreground?.subscribe(() => {})

    expect(netInfoSubscriptions).toBe(1)
    expect(appStateSubscriptions).toBe(1)
    stopNetwork?.()
    stopForeground?.()
  })

  test('loads the Expo module and reports a missing native rebuild clearly', () => {
    expect(openExpoDriver('todos.db').loadNativeEngine?.()?.ok).toBe(true)
    available = false

    try {
      expect(openExpoDriver('todos.db').loadNativeEngine?.()).toMatchObject({ ok: false, message: expect.stringContaining('Rebuild the native app with Expo SDK 58') })
    } finally { available = true }
  })

  test.each(['', new Error('documents directory unavailable')])('refuses an invalid native path and preserves the failure on later calls: %s', async (failure) => {
    path = failure
    const client = createKizunaSync(openExpoDriver('todos.db'), remote, config, { inspector: false })

    try {
      for (const operation of [() => client.sync(), () => client.getOutboxDepth()]) {
        const error = await operation().then(() => null, (error: unknown) => error)

        expect(error).toBeInstanceOf(TEngineError)
        expect((error as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      }
    } finally {
      client.dispose()
      path = '/tmp/expo/todos.db'
    }
  })
})
