/// <reference types="bun" />
/**
 * openExpoDriver's web branch, handing @kizunasync/web the wasm asset resolver
 * itself, so the asset URL is resolved when the worker spawns and a static
 * render with no `location` never reads it. Bun has no Metro platform
 * resolution, so `./wasm-asset` resolves to the native twin here; the `.web.ts`
 * twin that Metro picks under a real web bundle is exercised by the live check
 * instead.
 */
import { describe, expect, mock, test } from 'bun:test'
import type { IStoreLocator } from '@kizunasync/core'

mock.module('react-native', () => ({
  Platform: { OS: 'web' },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => undefined }),
  },
}))

mock.module('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}))

mock.module('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('native store locator must not run on the web platform')
  },
}))

const seen: Array<{ name: string; options: unknown }> = []

/** The web driver as `@kizunasync/web` builds it, reduced to the path and the port it carries. */
const webDriver: IStoreLocator = {
  databasePath: 'todos.db',
  platformPorts: { connectivity: { isOnline: () => true, subscribe: () => () => undefined } },
}

mock.module('@kizunasync/web', () => ({
  createWebWorkerDriver: (name: string, options: unknown) => {
    seen.push({ name, options })

    return webDriver
  },
}))

const { openExpoDriver } = await import('./expo-driver')
const { resolveWasmAssetUrl } = await import('./wasm-asset')

describe('openExpoDriver web branch', () => {
  test('hands createWebWorkerDriver the wasm asset resolver itself, not its answer', () => {
    seen.length = 0
    openExpoDriver('todos.db')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe('todos.db')
    expect((seen[0]?.options as { wasmUrl?: unknown }).wasmUrl).toBe(resolveWasmAssetUrl)
  })

  test('returns the web driver synchronously, with the ports @kizunasync/web gave it', () => {
    const driver = openExpoDriver('todos.db')

    expect(driver).toBe(webDriver)
    expect(driver.platformPorts?.foreground).toBeUndefined()
  })
})
