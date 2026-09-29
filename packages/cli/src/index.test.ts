/// <reference types="bun" />
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { main } from './main'

describe('kizunasync cli shim', () => {
  let tempRoot: string

  afterEach(() => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('exits 2 with build hint when binary is missing', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-shim-'))
    const code = main([], {
      env: {},
      cwd: tempRoot,
      shimEntry: join(tempRoot, 'main.js'),
      exec: () => {
        throw new Error('must not exec')
      },
    })

    expect(code).toBe(2)
  })

  test('forwards argv to the resolved binary and returns its exit code', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-shim-'))
    const bin = join(tempRoot, 'kizunasync')

    touch(bin)

    let seenBinary = ''
    let seenArgv: string[] = []
    const code = main(['--help'], {
      env: { KSYNC_BIN: bin },
      cwd: tempRoot,
      exec: (binary, argv) => {
        seenBinary = binary
        seenArgv = [...argv]

        return { status: 7, signal: null }
      },
    })

    expect(code).toBe(7)
    expect(seenBinary).toBe(bin)
    expect(seenArgv).toEqual(['--help'])
  })

  test('hands the binary the pack this package ships when KSYNC_PACK_DIR is unset', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-shim-'))
    const bin = join(tempRoot, 'kizunasync')

    touch(bin)

    const shipped = fileURLToPath(new URL('../pack', import.meta.url))

    expect(packDirSeen({ KSYNC_BIN: bin })).toBe(shipped)
    expect(packDirSeen({ KSYNC_BIN: bin, KSYNC_PACK_DIR: '' })).toBe(shipped)
  })

  test('keeps a KSYNC_PACK_DIR the user set', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-shim-'))
    const bin = join(tempRoot, 'kizunasync')

    touch(bin)

    expect(packDirSeen({ KSYNC_BIN: bin, KSYNC_PACK_DIR: '/opt/kizunasync/pack' })).toBe('/opt/kizunasync/pack')
  })

  test('marks the child so a shim it starts refuses instead of starting another', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-shim-'))
    const bin = join(tempRoot, 'kizunasync')

    touch(bin)

    let childEnv: NodeJS.ProcessEnv = {}

    main([], {
      env: { KSYNC_BIN: bin },
      packDir: tempRoot,
      exec: (_binary, _argv, options) => {
        childEnv = options.env

        return { status: 0, signal: null }
      },
    })

    const code = main([], {
      env: childEnv,
      exec: () => {
        throw new Error('must not exec')
      },
    })

    expect(childEnv.KSYNC_SHIM_ACTIVE).toBe('1')
    expect(code).toBe(2)
  })

  test('maps SIGINT to exit 130', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kizunasync-shim-'))
    const bin = join(tempRoot, 'kizunasync')

    touch(bin)

    const code = main([], {
      env: { KSYNC_BIN: bin },
      cwd: tempRoot,
      exec: () => ({ status: null, signal: 'SIGINT' }),
    })

    expect(code).toBe(130)
  })
})

function touch(path: string): void {
  writeFileSync(path, '')
  chmodSync(path, 0o755)
}

/** The `KSYNC_PACK_DIR` the binary is started with, for a shim run over `env`. */
function packDirSeen(env: NodeJS.ProcessEnv): string | undefined {
  let seen: string | undefined

  main([], {
    env,
    exec: (_binary, _argv, options) => {
      seen = options.env.KSYNC_PACK_DIR

      return { status: 0, signal: null }
    },
  })

  return seen
}
