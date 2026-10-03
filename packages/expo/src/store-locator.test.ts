/// <reference types="bun" />
/** The device locator's ports reach NetInfo and AppState, so both are mocked; bun cannot load either. */
import { describe, expect, mock, test } from 'bun:test'

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
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

const { createStoreLocator } = await import('./store-locator')

describe('createStoreLocator', () => {
  test('reports the file path the kernel opens', () => {
    expect(createStoreLocator('/tmp/todos.db').databasePath).toBe('/tmp/todos.db')
  })

  test('carries the device connectivity and foreground ports', () => {
    const { platformPorts } = createStoreLocator('/tmp/todos.db')

    expect(platformPorts?.connectivity?.isOnline()).toBe(true)
    expect(typeof platformPorts?.foreground?.subscribe).toBe('function')
  })
})
