/// <reference types="bun" />
/**
 * When no Rust engine resolves, the client's first use fails with
 * `ENGINE_UNAVAILABLE`, naming the artifact to install, while building the
 * client throws nothing. Each message has to stand on its own.
 *
 * The runtime is faked, not the loader: a `process` whose `dlopen` always
 * throws is what a machine without the addon looks like here, and the real
 * candidate paths stay in the message so the listing is covered too. A
 * locator's `loadNativeEngine` is written inline, standing in for the
 * `@kizunasync/expo` drivers that fill it through `@kizunasync/rn-uniffi`.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { defineConfig } from '../config/config'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import { createTempDatabase } from '../testing/temp-database'
import { createKizunaSync, type IKizunaSync } from './kizunasync'
import { napiCandidatePaths, napiPlatformPackage, resetNapiAddonCache } from './napi-loader'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { IStoreLocator } from '../ports/store-locator'

const remote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const config = defineConfig({ tables: { items: { sync: 'read-write' } } })

const driverWithPath = (): IStoreLocator => createTempDatabase().driver

/** A runtime whose `dlopen` is `dlopen`, restored after `run`, with the addon cache cleared on both sides. */
const withDlopen = (dlopen: (module: { exports: unknown }, path: string) => void, run: () => void): void => {
  const fakeProcess = {
    ...process,
    dlopen,
    getBuiltinModule: process.getBuiltinModule.bind(process),
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'process')

  Object.defineProperty(globalThis, 'process', { value: fakeProcess, configurable: true })
  resetNapiAddonCache()

  try {
    run()
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'process', original)
    }
    resetNapiAddonCache()
  }
}

/**
 * A runtime that can load nothing: every candidate `dlopen` fails. A missing
 * artifact, a foreign architecture, and a stale ABI all look like that.
 */
const withUnloadableAddon = (run: () => void): void => {
  withDlopen(() => {
    throw new Error('dlopen: no such file')
  }, run)
}

/** React Native's own marker, the one `selectEngine` reads before it names the missing loader. */
const withReactNativeNavigator = (run: () => void): void => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  Object.defineProperty(globalThis, 'navigator', {
    value: { product: 'ReactNative' },
    configurable: true,
  })

  try {
    run()
  } finally {
    if (original === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', original)
    }
  }
}

/**
 * The error the client's first use fails with. The build must not throw, and
 * the first use opens the engine before its promise settles, so the selection
 * runs inside the runtime fake `run` installs.
 */
const firstUseFailure = (build: () => IKizunaSync): Promise<TEngineError> =>
  build()
    .sync()
    .then(
      () => {
        throw new Error('expected the first use to fail')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(TEngineError)

        return error as TEngineError
      },
    )

/** A locator over a fresh temp file whose native loader always fails with `message`. */
const driverWithFailingLoader = (message: string): IStoreLocator => ({
  ...driverWithPath(),
  loadNativeEngine: () => ({ ok: false, message }),
})

/** The first-use failure of a client built over `driver` and first used inside `withRuntime`. */
const failureUnder = (withRuntime: (run: () => void) => void, driver: () => IStoreLocator = driverWithPath): Promise<TEngineError> => {
  let failure: Promise<TEngineError> | null = null

  withRuntime(() => {
    failure = firstUseFailure(() => createKizunaSync(driver(), remote, config))
  })

  return failure ?? Promise.reject(new Error('the runtime fake never ran the build'))
}

describe('engine selection fails loud', () => {
  afterEach(() => {
    resetNapiAddonCache()
  })

  test('a runtime with no loadable addon names the package and every path tried', async () => {
    let expectedPackage: string | null = null
    const error = await failureUnder((run) => {
      withUnloadableAddon(() => {
        expectedPackage = napiPlatformPackage()
        run()
      })
    })

    expect(error.code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect(error.message).toContain('no Rust engine is loadable in this process')
    expect(error.message).toContain(expectedPackage ?? '@kizunasync/napi-')
    expect(error.message).toContain('cargo build -p kizunasync-napi')
    expect(error.message).toContain('tried ')
    expect(error.message).toContain('target/debug')
  })

  test('React Native with a locator that carries no native loader names the @kizunasync/expo drivers instead', async () => {
    const error = await failureUnder((run) => {
      withReactNativeNavigator(() => {
        withUnloadableAddon(run)
      })
    })

    expect(error.code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect(error.message).toContain('@kizunasync/expo')
    expect(error.message).toContain('@kizunasync/rn-uniffi')
    expect(error.message).toContain('a JavaScript reload cannot load a native module')
    // The addon is not this platform's artifact, so naming it would send the reader after something React Native never loads.
    expect(error.message).not.toContain('@kizunasync/napi-')
  })

  test('a locator whose native loader fails reports that message, and no addon stands in for it', async () => {
    const message = "Kizuna's native engine is not in this binary"
    const error = await firstUseFailure(() => createKizunaSync(driverWithFailingLoader(message), remote, config))

    expect(error.code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect(error.message).toBe(message)
  })

  test('on React Native a loader failure reports the loader message, not the missing-loader one', async () => {
    const message = 'loading the generated bindings threw: Requiring unknown module "1234"'
    const error = await failureUnder(
      (run) => {
        withReactNativeNavigator(() => {
          withUnloadableAddon(run)
        })
      },
      () => driverWithFailingLoader(message),
    )

    expect(error.code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect(error.message).toBe(message)
  })

  test('the native loader runs on the first use, once, and every later call keeps its failure', async () => {
    let loads = 0
    const driver: IStoreLocator = {
      ...driverWithPath(),
      loadNativeEngine: () => {
        loads += 1

        return { ok: false, message: 'not linked' }
      },
    }
    const client = createKizunaSync(driver, remote, config)

    expect(loads).toBe(0)

    for (const call of [() => client.sync(), () => client.getOutboxDepth()]) {
      const error = await call().then(
        () => null,
        (reason: unknown) => reason,
      )

      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((error as TEngineError).message).toBe('not linked')
    }
    expect(loads).toBe(1)
    client.dispose()
  })

  test('the message says why each candidate failed to load', async () => {
    let candidates: string[] = []
    const error = await failureUnder((run) => {
      withUnloadableAddon(() => {
        run()
        candidates = napiCandidatePaths()
      })
    })

    expect(candidates.length).toBeGreaterThan(0)

    for (const path of candidates) {
      expect(error.message).toContain(`${path} (dlopen: no such file)`)
    }
  })

  test('a library that loads without the addon surface is named as such', async () => {
    const error = await failureUnder((run) => {
      withDlopen((module) => {
        module.exports = { ping: () => 'pong' }
      }, run)
    })

    expect(error.code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect(error.message).toContain('loaded without the kizunasync-napi surface')
  })
})
