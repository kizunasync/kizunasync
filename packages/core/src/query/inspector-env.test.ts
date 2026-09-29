/// <reference types="bun" />
/**
 * The inspector is on by default only in a development or test build. Bundlers
 * replace the literal `process.env.NODE_ENV` at build time, so the client has
 * to read exactly that expression for a production bundle to turn the
 * inspector off, and a runtime with no `process` at all reads no value.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { defineConfig } from '../config/config'
import { createKizunaSync, type IKizunaSyncOptions } from './kizunasync'
import { loadNapiAddon } from './napi-loader'
import type { IProtocolRemote } from '../ports/protocol-remote'

const hasAddon = loadNapiAddon() !== null

const remote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const config = defineConfig({ tables: { items: { sync: 'read-write' } } })

/** Whether a client built with `options` under the current NODE_ENV carries an inspector. */
const hasInspector = (options: IKizunaSyncOptions = {}): boolean => {
  const client = createKizunaSync({ databasePath: null }, remote, config, { pollIntervalMs: 0, ...options })

  try {
    return client.inspector !== null && client.inspector !== undefined
  } finally {
    client.dispose()
  }
}

describe('inspector default', () => {
  const previous = process.env.NODE_ENV

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previous
    }
  })

  test('a bundler define of process.env.NODE_ENV replaces every read of it', () => {
    const source = readFileSync(new URL('./kizunasync.ts', import.meta.url), 'utf8')
    const bundled = new Bun.Transpiler({
      loader: 'ts',
      define: { 'process.env.NODE_ENV': '"production"' },
    }).transformSync(source)

    expect(bundled).not.toContain('NODE_ENV')
  })

  test.skipIf(!hasAddon)('NODE_ENV production leaves the inspector off', () => {
    process.env.NODE_ENV = 'production'

    expect(hasInspector()).toBe(false)
  })

  test.skipIf(!hasAddon)('NODE_ENV development turns the inspector on', () => {
    process.env.NODE_ENV = 'development'

    expect(hasInspector()).toBe(true)
  })

  test.skipIf(!hasAddon)('NODE_ENV test turns the inspector on', () => {
    process.env.NODE_ENV = 'test'

    expect(hasInspector()).toBe(true)
  })

  test.skipIf(!hasAddon)('an unset NODE_ENV leaves the inspector off', () => {
    delete process.env.NODE_ENV

    expect(hasInspector()).toBe(false)
  })

  test.skipIf(!hasAddon)('a runtime without process leaves the inspector off', () => {
    const runtime = globalThis as { process?: unknown }
    const saved = runtime.process
    let isOn: boolean

    process.env.NODE_ENV = 'development'
    delete runtime.process

    try {
      isOn = hasInspector()
    } finally {
      runtime.process = saved
    }
    expect(isOn).toBe(false)
  })

  test.skipIf(!hasAddon)('the inspector option wins over NODE_ENV', () => {
    process.env.NODE_ENV = 'production'

    expect(hasInspector({ inspector: true })).toBe(true)
    process.env.NODE_ENV = 'development'

    expect(hasInspector({ inspector: false })).toBe(false)
  })
})
