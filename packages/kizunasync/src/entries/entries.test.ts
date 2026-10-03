/// <reference types="bun" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

interface IPackageJson {
  exports: Record<string, string>
  publishConfig: { exports: Record<string, unknown> }
}

const PACKAGE_ROOT = join(import.meta.dir, '../..')
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as IPackageJson

/** The private workspace module each public subpath re-exports. */
const FACADE_SPECIFIERS: Record<string, string> = {
  '.': '@kizunasync/core',
  './config': '@kizunasync/core/config',
  './constants': '@kizunasync/core/constants',
  './testing': '@kizunasync/core/testing',
  './supabase': '@kizunasync/supabase',
  './web': '@kizunasync/web',
  './react': '@kizunasync/react',
  './vue': '@kizunasync/vue',
  './expo': '@kizunasync/expo',
  './expo/op-sqlite': '@kizunasync/expo/op-sqlite',
  './expo/file-store': '@kizunasync/expo/file-store',
  './expo/transfer': '@kizunasync/expo/transfer',
}

/** The wasm binary is an asset the release assembler stages; no facade module stands for it. */
const PUBLISHED_ONLY_KEYS = ['./web/wasm/kizunasync_wasm_bg.wasm']

/** Entries whose modules load under Bun without a browser or React Native runtime. */
const BUN_LOADABLE_KEYS = ['.', './config', './constants', './supabase', './react', './vue']

const FACADE_ENTRIES = Object.entries(PACKAGE_JSON.exports).filter(([key]) => key !== './package.json')

const specifierOf = (key: string): string => {
  const specifier = FACADE_SPECIFIERS[key]

  if (specifier === undefined) {
    throw new Error(`no private specifier is listed for ${key}`)
  }

  return specifier
}

const facadePathOf = (key: string): string => {
  const target = PACKAGE_JSON.exports[key]

  if (target === undefined) {
    throw new Error(`exports has no ${key}`)
  }

  return join(PACKAGE_ROOT, target)
}

describe('kizunasync entry facades', () => {
  test('every facade export is listed with its private specifier', () => {
    expect(FACADE_ENTRIES.map(([key]) => key).sort()).toEqual(Object.keys(FACADE_SPECIFIERS).sort())
  })

  test.each(FACADE_ENTRIES)('%s is one export * line of its private module', (key, target) => {
    expect(readFileSync(join(PACKAGE_ROOT, target), 'utf8')).toBe(`export * from '${specifierOf(key)}'\n`)
  })

  test('the dev exports carry every published key except the staged wasm asset', () => {
    const published = Object.keys(PACKAGE_JSON.publishConfig.exports).filter((key) => !PUBLISHED_ONLY_KEYS.includes(key))

    expect(Object.keys(PACKAGE_JSON.exports).sort()).toEqual(published.sort())
  })

  test.each(BUN_LOADABLE_KEYS)('%s exposes the names of its private module', async (key) => {
    const facade: Record<string, unknown> = await import(facadePathOf(key))
    const source: Record<string, unknown> = await import(specifierOf(key))

    expect(Object.keys(facade)).toEqual(Object.keys(source))
  })
})
