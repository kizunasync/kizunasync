/// <reference types="bun" />
/**
 * What `createKizunaSync` refuses before it picks an engine. The config mapping
 * reads a table's `sync` and `conflict` by equality with one value, so a
 * misspelling would silently become the other mode; the numbers reach the
 * kernel or the poll timer as they are. Each is refused with `CONFIG_INVALID`.
 */

import { describe, expect, test } from 'bun:test'
import { attachment, byColumn, byOwner, defineConfig, type TKizunaSyncConfig } from '../config/config'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import { createKizunaSync, type IKizunaSync, type IKizunaSyncOptions } from './kizunasync'
import { loadNapiAddon } from './napi-loader'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { IStoreLocator } from '../ports/store-locator'

const hasAddon = loadNapiAddon() !== null

const remote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const IN_MEMORY: IStoreLocator = { databasePath: null }

const BASE = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

/** The base config with one top-level key replaced by a value its type does not allow. */
const withConfig = (override: Record<string, unknown>): TKizunaSyncConfig =>
  ({ ...BASE, ...override }) as unknown as TKizunaSyncConfig

/** The base config with one `items` table key replaced. */
const withTable = (override: Record<string, unknown>): TKizunaSyncConfig =>
  ({ ...BASE, tables: { items: { ...BASE.tables.items, ...override } } }) as unknown as TKizunaSyncConfig

const build = (config: TKizunaSyncConfig, options: IKizunaSyncOptions = {}): IKizunaSync =>
  createKizunaSync(IN_MEMORY, remote, config, { pollIntervalMs: 0, inspector: false, ...options })

/** The error a refused build throws; a build that goes through is released and fails the test. */
const refusalOf = (run: () => IKizunaSync): TEngineError => {
  let client: IKizunaSync | undefined

  try {
    client = run()
  } catch (error) {
    expect(error).toBeInstanceOf(TEngineError)

    return error as TEngineError
  }
  client.dispose()

  throw new Error('expected createKizunaSync to refuse the config')
}

describe('createKizunaSync config refusals', () => {
  test.each(['pull_only', 'PULL-ONLY', 'readwrite', undefined])('a table sync of %p is refused', (sync) => {
    const error = refusalOf(() => build(withTable({ sync })))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('tables.items.sync')
  })

  test.each(['HLC', 'lww', undefined])('a table conflict of %p is refused', (conflict) => {
    const error = refusalOf(() => build(withTable({ conflict })))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('tables.items.conflict')
  })

  test.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '500'])('a pullLimit of %p is refused', (pullLimit) => {
    const error = refusalOf(() => build(withConfig({ pullLimit })))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('pullLimit')
  })

  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, '2'])('a config schemaVersion of %p is refused', (schemaVersion) => {
    const error = refusalOf(() => build(withConfig({ schemaVersion })))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('schemaVersion')
  })

  test('an option schemaVersion that is not an integer is refused', () => {
    const error = refusalOf(() => build(BASE, { schemaVersion: 2.5 }))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('schemaVersion')
  })

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '15000'])('a config pollIntervalMs of %p is refused', (pollIntervalMs) => {
    const error = refusalOf(() => build(withConfig({ pollIntervalMs })))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('pollIntervalMs')
  })

  test('an option pollIntervalMs below 0 is refused', () => {
    const error = refusalOf(() =>
      createKizunaSync(IN_MEMORY, remote, BASE, { inspector: false, pollIntervalMs: -1 }),
    )

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('pollIntervalMs')
  })

  test('an attachment column with no owner column is refused with CONFIG_INVALID', () => {
    const config = defineConfig({
      tables: {
        items: {
          sync: 'read-write',
          bucket: byColumn('team_id'),
          attachments: { image_path: attachment('images') },
        },
      },
    })
    const error = refusalOf(() => build(config))

    expect(error.code).toBe(EEngineErrorCode.CONFIG_INVALID)
    expect(error.message).toContain('needs ownerColumn')
  })
})

describe.skipIf(!hasAddon)('createKizunaSync config boundaries', () => {
  test('a pullLimit of 1, a schemaVersion of 0 and a pollIntervalMs of 0 build a client', () => {
    const client = createKizunaSync(IN_MEMORY, remote, withConfig({ pullLimit: 1, schemaVersion: 0 }), {
      inspector: false,
      pollIntervalMs: 0,
    })

    expect(client.engine).toBe('rust')
    client.dispose()
  })
})
