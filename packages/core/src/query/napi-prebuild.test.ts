/// <reference types="bun" />
/**
 * Where the addon is looked for, and in which order. An app has the platform
 * package and nothing else, so it is searched before anything this checkout
 * built: a stale `target/debug` must never shadow what was installed.
 *
 * The prebuild case is also covered end to end: copy the built cdylib into the
 * documented `src/native/<platform>-<arch>/` layout and let `createKizunaSync` run on
 * it, which is the cargo-less path a packaged app takes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '../config/config'
import { createTempDatabase } from '../testing/temp-database'
import { createKizunaSync } from './kizunasync'
import { loadNapiAddon, napiCandidatePaths, napiPlatformArtifact, resetNapiAddonCache, type INapiHost } from './napi-loader'
import type { IProtocolRemote } from '../ports/protocol-remote'

const remote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const here = dirname(fileURLToPath(import.meta.url))

const REPO_ROOT = resolve(here, '../../../..')

/**
 * A host whose platform package resolves to a package this test staged in its own
 * temporary directory.
 *
 * The resolution is injected rather than installed: the loader asks the runtime
 * for `module.createRequire`, so a stub answers with the staged path and the
 * repository's own `node_modules` is never written to, read for this, or removed.
 */
const withStagedPlatformPackage = (
  host: INapiHost,
  run: (packageDir: string) => void,
): void => {
  const artifact = napiPlatformArtifact(host)

  if (artifact === null) {
    throw new Error(`no platform package is published for ${host.platform}-${host.arch}`)
  }
  const root = mkdtempSync(join(tmpdir(), 'kizunasync-napi-stage-'))
  const packageDir = join(root, 'node_modules', artifact.package)

  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: artifact.package, version: '0.0.0-test' }),
  )
  const manifest = `${artifact.package}/package.json`
  const fakeProcess = {
    ...process,
    dlopen: (process as unknown as { dlopen: (module: { exports: unknown }, path: string) => void })
      .dlopen,
    platform: host.platform,
    arch: host.arch,
    getBuiltinModule: (id: string): unknown =>
      id === 'module'
        ? {
            createRequire: () => ({
              resolve: (specifier: string): string => {
                if (specifier !== manifest) {
                  throw new Error(`cannot resolve ${specifier}`)
                }
                return join(packageDir, 'package.json')
              },
            }),
          }
        : process.getBuiltinModule(id as 'module'),
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'process')

  Object.defineProperty(globalThis, 'process', { value: fakeProcess, configurable: true })

  try {
    run(packageDir)
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'process', original)
    }
    rmSync(root, { recursive: true, force: true })
  }
}

describe('napi candidate order', () => {
  afterEach(() => {
    delete process.env.KSYNC_NAPI_PATH
  })

  test('an explicit path, then the override, then the installed package, then a staged prebuild, then cargo', () => {
    withStagedPlatformPackage({ platform: 'linux', arch: 'x64' }, (packageDir) => {
      process.env.KSYNC_NAPI_PATH = '/override/libkizunasync_napi.so'
      const candidates = napiCandidatePaths('/explicit/libkizunasync_napi.so')

      expect(candidates[0]).toBe('/explicit/libkizunasync_napi.so')
      expect(candidates[1]).toBe('/override/libkizunasync_napi.so')
      expect(candidates[2]).toBe(join(packageDir, 'libkizunasync_napi.so'))
      expect(candidates[3]?.includes('/native/linux-x64/libkizunasync_napi.so')).toBe(true)
      expect(candidates[4]?.includes('target/debug')).toBe(true)
      expect(candidates[5]?.includes('target/release')).toBe(true)
    })
  })

  test('the platform table agrees with the one prepare-npm-release.ts publishes from', () => {
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'prepare-npm-release.ts'), 'utf8')
    const rows = [
      ...script.matchAll(
        /triple: '([^']+)',\s*platform: '([^']+)',\s*arch: '([^']+)',\s*napiLibrary: '([^']+)'/g,
      ),
    ]

    expect(rows).toHaveLength(script.split("napiLibrary: '").length - 1)

    for (const [, triple, targetPlatform, targetArch, library] of rows) {
      expect(napiPlatformArtifact({ platform: targetPlatform!, arch: targetArch! })).toEqual({
        package: `@kizunasync/napi-${triple!}`,
        library: library!,
      })
    }
    expect(napiPlatformArtifact({ platform: 'win32', arch: 'arm64' })).toBeNull()
  })
})

describe('napi prebuild layout', () => {
  const previousPath = process.env.KSYNC_NAPI_PATH

  afterEach(() => {
    resetNapiAddonCache()

    if (previousPath === undefined) {
      delete process.env.KSYNC_NAPI_PATH
    } else {
      process.env.KSYNC_NAPI_PATH = previousPath
    }
  })

  test('createKizunaSync loads rust from src/native without a cargo invocation', () => {
    const script = resolve(here, '../../scripts/copy-napi-prebuild.ts')

    execFileSync('bun', [script], { stdio: 'pipe' })
    const name =
      platform() === 'darwin'
        ? 'libkizunasync_napi.dylib'
        : platform() === 'win32'
          ? 'kizunasync_napi.dll'
          : 'libkizunasync_napi.so'
    const dest = resolve(here, `../native/${platform()}-${arch()}/${name}`)

    expect(existsSync(dest)).toBe(true)
    resetNapiAddonCache()
    process.env.KSYNC_NAPI_PATH = dest
    expect(loadNapiAddon()).not.toBeNull()
    const kizunasync = createKizunaSync(
      createTempDatabase().driver,
      remote,
      defineConfig({ tables: { items: { sync: 'read-write' } } }),
    )

    expect(kizunasync.engine).toBe('rust')
    kizunasync.dispose()
  })
})
