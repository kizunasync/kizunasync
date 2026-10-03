/// <reference types="bun" />
/**
 * `napiCandidatePaths` triple resolution: the installed `@kizunasync/<triple>`
 * optional dependency, its position (right after KSYNC_NAPI_PATH, before
 * `target/…`), and that an unresolvable or unsupported triple never throws.
 *
 * The host is faked to a platform/arch this repository's real toolchain never
 * probes (`win32-x64-msvc`, `linux-arm64-gnu`, `freebsd`). Assertions then
 * cannot collide with another test file's `require.resolve` cache for the
 * real `darwin-arm64` host triple.
 *
 * Resolution is injected, never installed: the loader asks the runtime for
 * `module.createRequire`. A stub answers for the staged package; the
 * repository's own `node_modules` is never written to or removed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { napiCandidatePaths, napiPlatformArtifact, type INapiHost } from './napi-loader'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * Swaps `globalThis.process` for a clone with a different `platform`/`arch` and
 * the given module resolver, restored after `run`.
 */
const withFakeHost = (
  host: INapiHost,
  resolve: (specifier: string) => string,
  run: () => void,
): void => {
  const fakeProcess = {
    ...process,
    dlopen: (process as unknown as { dlopen: (module: { exports: unknown }, path: string) => void }).dlopen,
    platform: host.platform,
    arch: host.arch,
    getBuiltinModule: (id: string): unknown =>
      id === 'module'
        ? { createRequire: () => ({ resolve }) }
        : process.getBuiltinModule(id as 'module'),
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'process')

  Object.defineProperty(globalThis, 'process', { value: fakeProcess, configurable: true })

  try {
    run()
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'process', original)
    }
  }
}

const rejectEverything = (specifier: string): string => {
  throw new Error(`cannot resolve ${specifier}`)
}

/**
 * Stage the platform package in a temporary directory and answer for its
 * manifest only, so the candidate list carries a path this test owns.
 */
const withStagedPlatformPackage = (host: INapiHost, run: (packageDir: string) => void): void => {
  const artifact = napiPlatformArtifact(host)

  if (artifact === null) {
    throw new Error(`no platform package is published for ${host.platform}-${host.arch}`)
  }
  const root = mkdtempSync(join(tmpdir(), 'kizunasync-napi-loader-'))
  const packageDir = join(root, 'node_modules', artifact.package)

  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: artifact.package, version: '0.0.0-test' }),
  )
  const manifest = `${artifact.package}/package.json`

  try {
    withFakeHost(
      host,
      (specifier) => {
        if (specifier !== manifest) {
          throw new Error(`cannot resolve ${specifier}`)
        }
        return join(packageDir, 'package.json')
      },
      () => {
        run(packageDir)
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('napiCandidatePaths platform package resolution', () => {
  afterEach(() => {
    delete process.env.KSYNC_NAPI_PATH
  })

  test('resolves an installed platform package right after KSYNC_NAPI_PATH', () => {
    withStagedPlatformPackage({ platform: 'win32', arch: 'x64' }, (packageDir) => {
      const withoutEnv = napiCandidatePaths()

      expect(withoutEnv[0]).toBe(join(packageDir, 'kizunasync_napi.dll'))

      process.env.KSYNC_NAPI_PATH = '/explicit/env/path'
      const withEnv = napiCandidatePaths()

      expect(withEnv[0]).toBe('/explicit/env/path')
      expect(withEnv[1]).toBe(join(packageDir, 'kizunasync_napi.dll'))
      expect(withEnv[2]?.includes('/native/win32-x64')).toBe(true)
      expect(withEnv[3]?.includes('target/debug')).toBe(true)
    })
  })

  test('a supported triple with no installed package is skipped without throwing', () => {
    withFakeHost({ platform: 'linux', arch: 'arm64' }, rejectEverything, () => {
      expect(() => napiCandidatePaths()).not.toThrow()
      const candidates = napiCandidatePaths()

      expect(candidates.some((path) => path.includes('@kizunasync/linux-arm64-gnu'))).toBe(false)
    })
  })

  test('an unsupported platform never throws and adds no platform package candidate', () => {
    withFakeHost({ platform: 'freebsd', arch: 'x64' }, rejectEverything, () => {
      expect(() => napiCandidatePaths()).not.toThrow()
      const candidates = napiCandidatePaths()

      expect(candidates.some((path) => /@kizunasync\/[\w-]+\//.test(path))).toBe(false)
    })
  })
})

/** Swaps `globalThis.process` for a clone whose working directory is `cwd`, restored after `run`. */
const withWorkingDirectory = (cwd: string, run: () => void): void => {
  const fakeProcess = {
    ...process,
    dlopen: (process as unknown as { dlopen: (module: { exports: unknown }, path: string) => void }).dlopen,
    cwd: () => cwd,
    getBuiltinModule: process.getBuiltinModule.bind(process),
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'process')

  Object.defineProperty(globalThis, 'process', { value: fakeProcess, configurable: true })

  try {
    run()
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'process', original)
    }
  }
}

describe('napiCandidatePaths development builds', () => {
  test('are looked up relative to the package, never under the working directory', () => {
    withWorkingDirectory('/elsewhere/app', () => {
      const candidates = napiCandidatePaths().map((path) => resolve(path))
      const cargoBuilds = candidates.filter((path) => path.includes('/target/'))

      expect(candidates.some((path) => path.startsWith('/elsewhere'))).toBe(false)
      expect(cargoBuilds.length).toBeGreaterThan(0)
      expect(cargoBuilds.every((path) => path.startsWith(join(REPO_ROOT, 'target')))).toBe(true)
    })
  })
})
