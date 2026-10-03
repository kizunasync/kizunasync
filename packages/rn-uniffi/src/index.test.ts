/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test'
import { describeUniffiLoadFailure, isUniffiHandle, isUniffiNativeAvailable, requireUniffiNativeEngine, tryLoadUniffiNativeEngine } from './index'

/** The six members a linked module has to expose, as functions. */
const fullHandle = (): Record<string, unknown> => ({
  create: (_configJson: string) => undefined,
  call: (_method: string, _paramsJson: string) => '{"ok":true,"value":null}',
  callAsync: async (_method: string, _paramsJson: string) => '{"ok":true,"value":null}',
  subscribe: (_observer: unknown) => 1n,
  unsubscribe: (_id: bigint) => undefined,
  shutdown: () => undefined,
})

/** A `react-native` whose Turbo Module registry reports `RnUniffi` as linked. */
const mockRegisteredTurboModule = (): void => {
  mock.module('react-native', () => ({
    TurboModuleRegistry: { get: (name: string) => (name === 'RnUniffi' ? {} : null) },
  }))
}

describe('@kizunasync/rn-uniffi loader', () => {
  test('reports not_linked in Bun (no Turbo Module host)', () => {
    const result = tryLoadUniffiNativeEngine()

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.reason).toBe('not_linked')
    }
    expect(isUniffiNativeAvailable()).toBe(false)
  })

  test('requireUniffiNativeEngine fails loud and names the development build', () => {
    expect(() => requireUniffiNativeEngine()).toThrow(/native engine is not in this binary/)
    expect(() => requireUniffiNativeEngine()).toThrow(/development client/)
  })

  test('the invalid_module message names every member the handle needs', () => {
    const message = describeUniffiLoadFailure({ ok: false, reason: 'invalid_module' })

    for (const member of ['create', 'call', 'callAsync', 'subscribe', 'unsubscribe', 'shutdown']) {
      expect(message).toContain(member)
    }
  })

  test('isUniffiHandle requires the whole JSON-RPC and event surface', () => {
    expect(isUniffiHandle(null)).toBe(false)
    expect(isUniffiHandle({ create: () => undefined })).toBe(false)
    expect(
      isUniffiHandle({
        apply: () => undefined,
        query: () => '[]',
        sync: () => undefined,
        outboxDepth: () => 0,
      }),
    ).toBe(false)
    expect(isUniffiHandle(fullHandle())).toBe(true)

    for (const member of ['create', 'call', 'callAsync', 'subscribe', 'unsubscribe', 'shutdown']) {
      const partial = fullHandle()

      delete partial[member]
      expect(isUniffiHandle(partial)).toBe(false)
    }
  })
})

describe('@kizunasync/rn-uniffi loader against an unregistered Turbo Module', () => {
  test('a null registry entry is not_linked and never evaluates the generated module', async () => {
    mock.module('react-native', () => ({
      TurboModuleRegistry: { get: () => null },
    }))
    mock.module('./generated/index', () => {
      throw new Error('the generated module must not load when RnUniffi is unregistered')
    })
    const { tryLoadUniffiNativeEngine: tryLoad } = await import('./spec')
    const result = tryLoad()

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.reason).toBe('not_linked')
    }
  })
})

describe('@kizunasync/rn-uniffi loader against a linked module', () => {
  test('a generated module that throws after registration is install_failed and keeps the error message', async () => {
    const mockThrowingGeneratedModule = (): void => {
      mock.module('./generated/index', () => {
        throw new Error('Requiring unknown module "1234"')
      })
    }

    mockRegisteredTurboModule()
    mockThrowingGeneratedModule()
    const { describeUniffiLoadFailure: describeFailure, requireUniffiNativeEngine: requireEngine, tryLoadUniffiNativeEngine: tryLoad } = await import('./spec')
    const result = tryLoad()

    expect(result).toEqual({ ok: false, reason: 'install_failed', cause: 'Requiring unknown module "1234"' })

    if (!result.ok) {
      expect(describeFailure(result)).toContain('Requiring unknown module "1234"')
    }
    // Bun answers a second require of a mock whose factory threw with an empty module, so the throwing mock goes back in before the second load.
    mockThrowingGeneratedModule()
    expect(() => requireEngine()).toThrow('Requiring unknown module "1234"')
  })

  test('a module without a KizunaSyncEngine constructor is invalid_module', async () => {
    mockRegisteredTurboModule()
    mock.module('./generated/index', () => ({ uniffiInitAsync: async () => undefined }))
    const { tryLoadUniffiNativeEngine: tryLoad } = await import('./spec')
    const result = tryLoad()

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.reason).toBe('invalid_module')
    }
  })

  test('a KizunaSyncEngine missing an engine member is invalid_module', async () => {
    mockRegisteredTurboModule()
    mock.module('./generated/index', () => ({
      KizunaSyncEngine: class {
        create(): void {}
        call(): string {
          return '{"ok":true,"value":null}'
        }
      },
    }))
    const { tryLoadUniffiNativeEngine: tryLoad } = await import('./spec')
    const result = tryLoad()

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.reason).toBe('invalid_module')
    }
  })

  test('a KizunaSyncEngine without callAsync is invalid_module', async () => {
    mockRegisteredTurboModule()
    mock.module('./generated/index', () => ({
      KizunaSyncEngine: class {
        create(): void {}
        call(): string {
          return '{"ok":true,"value":null}'
        }
        subscribe(): bigint {
          return 7n
        }
        unsubscribe(): void {}
        shutdown(): void {}
      },
    }))
    const { tryLoadUniffiNativeEngine: tryLoad } = await import('./spec')
    const result = tryLoad()

    expect(result.ok).toBe(false)

    if (!result.ok) {
      expect(result.reason).toBe('invalid_module')
    }
  })

  test('a complete KizunaSyncEngine loads (the registered-registry path)', async () => {
    mockRegisteredTurboModule()
    mock.module('./generated/index', () => ({
      KizunaSyncEngine: class {
        create(): void {}
        call(): string {
          return '{"ok":true,"value":null}'
        }
        async callAsync(): Promise<string> {
          return '{"ok":true,"value":null}'
        }
        subscribe(): bigint {
          return 7n
        }
        unsubscribe(): void {}
        shutdown(): void {}
      },
    }))
    const { tryLoadUniffiNativeEngine: tryLoad, isUniffiNativeAvailable: isAvailable } =
      await import('./spec')
    const result = tryLoad()

    expect(result.ok).toBe(true)

    if (result.ok) {
      expect(result.engine.subscribe({ onEvent: () => undefined })).toBe(7n)
      expect(await result.engine.callAsync('outbox_depth', '{}')).toBe('{"ok":true,"value":null}')
    }
    expect(isAvailable()).toBe(true)
  })
})
