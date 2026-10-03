/// <reference types="bun" />
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { defaultShimEntry, kizunasyncBinaryMissingMessage, platformTriple, resolveKizunaSyncBinary } from './resolve-binary'

function touchExecutable(path: string): void {
  writeFileSync(path, '')
  chmodSync(path, 0o755)
}

function cliBinaryName(): string {
  return process.platform === 'win32' ? 'kizunasync.exe' : 'kizunasync'
}

const HOST_TRIPLE = platformTriple(process.platform, process.arch)

describe('resolveKizunaSyncBinary', () => {
  let tempRoot: string

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('KSYNC_BIN wins when executable', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    const bin = join(tempRoot, 'kizunasync-custom')

    touchExecutable(bin)

    expect(
      resolveKizunaSyncBinary({
        env: { KSYNC_BIN: bin },
      }),
    ).toBe(bin)
  })

  test('prefers workspace target/release over target/debug', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    writeFileSync(join(tempRoot, 'Cargo.toml'), 'members = ["crates/kizunasync-cli"]\n')
    mkdirSync(join(tempRoot, 'target', 'release'), { recursive: true })
    mkdirSync(join(tempRoot, 'target', 'debug'), { recursive: true })
    const release = join(tempRoot, 'target', 'release', 'kizunasync')
    const debug = join(tempRoot, 'target', 'debug', 'kizunasync')

    touchExecutable(release)
    touchExecutable(debug)

    expect(
      resolveKizunaSyncBinary({
        env: { KIZUNASYNC_REPO_ROOT: tempRoot },
      }),
    ).toBe(release)
  })

  test('falls back to workspace target/debug', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    writeFileSync(join(tempRoot, 'Cargo.toml'), 'members = ["crates/kizunasync-cli"]\n')
    mkdirSync(join(tempRoot, 'target', 'debug'), { recursive: true })
    const debug = join(tempRoot, 'target', 'debug', 'kizunasync')

    touchExecutable(debug)

    expect(
      resolveKizunaSyncBinary({
        env: { KIZUNASYNC_REPO_ROOT: tempRoot },
      }),
    ).toBe(debug)
  })

  test('skips PATH entry that matches the Node shim', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    const shim = join(tempRoot, 'main.js')

    touchExecutable(shim)

    expect(
      resolveKizunaSyncBinary({
        env: { PATH: tempRoot },
        shimEntry: shim,
      }),
    ).toBeUndefined()
  })

  test('skips a PATH entry that is a symlink to the shim, as npm links .bin/kizunasync', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    const shim = join(tempRoot, 'kizunasync', 'dist', 'main.js')
    const bin = join(tempRoot, '.bin')

    mkdirSync(join(tempRoot, 'kizunasync', 'dist'), { recursive: true })
    mkdirSync(bin)
    touchExecutable(shim)
    symlinkSync(shim, join(bin, cliBinaryName()))

    expect(
      resolveKizunaSyncBinary({
        env: { PATH: bin },
        shimEntry: shim,
      }),
    ).toBeUndefined()
  })

  test('a PATH binary that is not the shim still resolves', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    const shim = join(tempRoot, 'kizunasync', 'dist', 'main.js')
    const bin = join(tempRoot, 'bin')
    const native = join(bin, cliBinaryName())

    mkdirSync(join(tempRoot, 'kizunasync', 'dist'), { recursive: true })
    mkdirSync(bin)
    touchExecutable(shim)
    touchExecutable(native)

    expect(
      resolveKizunaSyncBinary({
        env: { PATH: bin },
        shimEntry: shim,
      }),
    ).toBe(native)
  })

  test('finds the workspace build from the shim location', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    writeFileSync(join(tempRoot, 'Cargo.toml'), 'members = ["crates/kizunasync-cli"]\n')
    mkdirSync(join(tempRoot, 'target', 'debug'), { recursive: true })
    const debug = join(tempRoot, 'target', 'debug', 'kizunasync')

    touchExecutable(debug)

    expect(
      resolveKizunaSyncBinary({
        env: {},
        shimEntry: join(tempRoot, 'packages', 'kizunasync', 'dist', 'main.js'),
      }),
    ).toBe(debug)
  })

  test('never takes a workspace build found from the working directory', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    const project = join(tempRoot, 'app')
    const installed = join(tempRoot, 'elsewhere', 'node_modules', 'kizunasync', 'dist', 'main.js')

    mkdirSync(join(project, 'target', 'debug'), { recursive: true })
    writeFileSync(join(project, 'Cargo.toml'), 'members = ["crates/kizunasync-cli"]\n')
    touchExecutable(join(project, 'target', 'debug', 'kizunasync'))
    const previous = process.cwd()

    process.chdir(project)

    try {
      expect(
        resolveKizunaSyncBinary({
          env: {},
          shimEntry: installed,
        }),
      ).toBeUndefined()
    } finally {
      process.chdir(previous)
    }
  })

  test('returns undefined when nothing resolves', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    expect(
      resolveKizunaSyncBinary({
        env: {},
        shimEntry: join(tempRoot, 'main.js'),
      }),
    ).toBeUndefined()
  })

  test.skipIf(HOST_TRIPLE === null)('resolves the installed @kizunasync/<triple> platform package', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    // `require.resolve` returns the realpath (macOS `/tmp` → `/private/tmp`); expect that form.
    const packageDir = join(realpathSync(tempRoot), 'node_modules', '@kizunasync', `${HOST_TRIPLE}`)

    mkdirSync(join(packageDir, 'bin'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: `@kizunasync/${HOST_TRIPLE}`, version: '0.0.0-test' }))
    const bin = join(packageDir, 'bin', cliBinaryName())

    touchExecutable(bin)

    expect(
      resolveKizunaSyncBinary({
        env: {},
        platformPackageRoot: tempRoot,
      }),
    ).toBe(bin)
  })

  test('falls through workspace candidates when the platform package is absent', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    writeFileSync(join(tempRoot, 'Cargo.toml'), 'members = ["crates/kizunasync-cli"]\n')
    mkdirSync(join(tempRoot, 'target', 'debug'), { recursive: true })
    const debug = join(tempRoot, 'target', 'debug', 'kizunasync')

    touchExecutable(debug)

    expect(
      resolveKizunaSyncBinary({
        env: { KIZUNASYNC_REPO_ROOT: tempRoot },
        platformPackageRoot: tempRoot,
      }),
    ).toBe(debug)
  })

  test.skipIf(HOST_TRIPLE === null)('KSYNC_BIN still wins over an installed platform package', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-resolve-'))
    const packageDir = join(tempRoot, 'node_modules', '@kizunasync', `${HOST_TRIPLE}`)

    mkdirSync(join(packageDir, 'bin'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: `@kizunasync/${HOST_TRIPLE}`, version: '0.0.0-test' }))
    touchExecutable(join(packageDir, 'bin', cliBinaryName()))
    const explicit = join(tempRoot, 'kizunasync-explicit')

    touchExecutable(explicit)

    expect(
      resolveKizunaSyncBinary({
        env: { KSYNC_BIN: explicit },
        platformPackageRoot: tempRoot,
      }),
    ).toBe(explicit)
  })

  test('defaultShimEntry maps resolve-binary to main in source layout', () => {
    const entry = defaultShimEntry()

    expect(entry.endsWith('/main.ts') || entry.endsWith('/main.js')).toBe(true)
    expect(existsSync(entry)).toBe(true)
  })

  test('missing message names cargo build', () => {
    expect(kizunasyncBinaryMissingMessage()).toContain('cargo build -p kizunasync-cli')
  })

  test('platformTriple matches the published PLATFORM_TARGETS and has no win32-arm64 package', () => {
    const script = readFileSync(join(import.meta.dir, '../../../scripts/prepare-npm-release.ts'), 'utf8')
    const rows = [
      ...script.matchAll(/triple: '([^']+)',\s*platform: '([^']+)',\s*arch: '([^']+)'/g),
    ]

    expect(rows.length).toBeGreaterThan(0)

    for (const [, triple, targetPlatform, targetArch] of rows) {
      expect(platformTriple(targetPlatform!, targetArch!)).toBe(triple!)
    }
    expect(platformTriple('win32', 'arm64')).toBeNull()
  })

  test('missing message suggests reinstalling kizunasync before building from source', () => {
    const message = kizunasyncBinaryMissingMessage()

    expect(message).toContain('npm install kizunasync')
    expect(message.indexOf('npm install kizunasync')).toBeLessThan(message.indexOf('cargo build -p kizunasync-cli'))
  })

  test('missing message names the platform package of the triple it is given', () => {
    expect(kizunasyncBinaryMissingMessage('darwin-arm64')).toContain('Reinstall kizunasync so its @kizunasync/darwin-arm64 optional dependency installs')
    expect(kizunasyncBinaryMissingMessage(null)).toContain('Reinstall kizunasync so its platform package installs')
    expect(kizunasyncBinaryMissingMessage(null)).not.toContain('@kizunasync/')
  })

  test.skipIf(HOST_TRIPLE === null)('missing message defaults to this host triple', () => {
    expect(kizunasyncBinaryMissingMessage()).toContain(`@kizunasync/${HOST_TRIPLE} optional dependency`)
  })
})
