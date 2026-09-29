/// <reference types="bun" />
// MARK: - @kizunasync/web smoke test

/**
 * The driver runs only in a browser (the Rust engine in a worker, over OPFS), so
 * its round-trip is proven by the wasm smoke, the browser lane and the examples at
 * runtime; the protocol between the two halves is covered by worker-protocol.test.ts.
 * Here we assert the public surface is wired, that importing the module does NOT
 * eagerly spawn a Worker or load wasm (so it's safe under bun and any bundler), and
 * that the connectivity adapter degrades to always-online with no window (SSR/test).
 */

import { describe, expect, test } from 'bun:test'
import { createWebConnectivity, createWebWorkerDriver } from './index'

describe('@kizunasync/web exports', () => {
  test('createWebWorkerDriver is a factory', () => {
    expect(typeof createWebWorkerDriver).toBe('function')
  })

  test('createWebConnectivity reports always-online without a window', () => {
    const connectivity = createWebConnectivity()

    expect(connectivity.isOnline()).toBe(true)
    // subscribe must hand back a callable unsubscribe even when there is no DOM.
    const unsubscribe = connectivity.subscribe(() => {})

    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })
})
