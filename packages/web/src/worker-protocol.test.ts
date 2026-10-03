/// <reference types="bun" />
/**
 * @kizunasync/web worker protocol: the two halves against each other.
 *
 * The fake Worker is a pipe: what the page posts goes straight into the real
 * worker runtime, and what the runtime posts comes back as a `message` event. A
 * fake `KizunaSyncWasmEngine` closes the loop. The whole framing is exercised:
 * request ids answered by their own results, a remote round trip that leaves the
 * page and comes back, and an engine event fanned out to `onEvent`, without a
 * browser or a wasm build.
 */

import { describe, expect, test } from 'bun:test'
import { createWebWorkerDriver } from './worker-driver'
import { createWorkerRuntime, type IWasmEngine, type TWasmEngineFactory } from './worker-runtime'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

interface IScriptedEngine extends IWasmEngine {
  readonly created: string[]
  readonly calls: Array<{ method: string; paramsJson: string }>
  freed: number
  emit: (eventJson: string) => void
  pullThrough: (requestJson: string) => Promise<string>
}

const STORE_KIND = '{"ok":true,"value":{"kind":"opfs-sahpool","durability":"full"}}'

const createScriptedEngine = (): IScriptedEngine => {
  const created: string[] = []
  const calls: Array<{ method: string; paramsJson: string }> = []
  let listener: ((eventJson: string) => void) | undefined
  let pull: ((requestJson: string) => Promise<string>) | undefined

  return {
    created,
    calls,
    freed: 0,
    create: async (configJson, pullPort) => {
      created.push(configJson)
      pull = pullPort
    },
    call: async (method, paramsJson) => {
      calls.push({ method, paramsJson })

      return method === 'store_kind' ? STORE_KIND : `{"ok":true,"value":"${method}"}`
    },
    subscribe: (callback) => {
      listener = callback

      return 1
    },
    free() {
      this.freed += 1
    },
    emit: (eventJson) => listener?.(eventJson),
    pullThrough: (requestJson) => pull?.(requestJson) ?? Promise.reject(new Error('not created')),
  }
}

class PipedWorker {
  static factory: TWasmEngineFactory
  static last: PipedWorker | undefined
  readonly posted: TWorkerRequest[] = []
  readonly listeners: Record<string, Array<(event: { data: unknown }) => void>> = {
    message: [],
    error: [],
  }
  terminated = false
  private readonly handle: (request: TWorkerRequest) => void
  constructor(_url: unknown, _options: unknown) {
    PipedWorker.last = this
    this.handle = createWorkerRuntime(PipedWorker.factory, (message: TWorkerResponse) => {
      this.emit('message', message)
    })
  }
  addEventListener(type: string, callback: (event: { data: unknown }) => void): void {
    ;(this.listeners[type] ??= []).push(callback)
  }
  postMessage(message: TWorkerRequest): void {
    this.posted.push(message)
    this.handle(message)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(type: string, data: unknown): void {
    for (const callback of this.listeners[type] ?? []) {
      callback({ data })
    }
  }
}

/** Web Locks for a lone tab: every request is granted in the caller's own tick. */
const grantAtOnce = {
  request: (_name: string, _options: unknown, callback: () => unknown): Promise<unknown> =>
    Promise.resolve(callback()),
}

/** The tab has Web Locks, so the driver opens the named database rather than a private memory store. */
const withPipedWorker = async <T>(factory: TWasmEngineFactory, body: () => Promise<T>): Promise<T> => {
  const previous = (globalThis as { Worker?: unknown }).Worker

  PipedWorker.factory = factory
  ;(globalThis as { Worker?: unknown }).Worker = PipedWorker as unknown
  Object.defineProperty(navigator, 'locks', { value: grantAtOnce, configurable: true })

  try {
    return await body()
  } finally {
    ;(globalThis as { Worker?: unknown }).Worker = previous
    delete (navigator as { locks?: unknown }).locks
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const noRemote = async (): Promise<string> => '{"ok":true,"data":{}}'

describe('web worker protocol', () => {
  test('a call resolves with the envelope the engine returned, on its own id', async () => {
    const engine = createScriptedEngine()

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})

      expect(await transport.call('sync', '{"now":"2026-01-01T00:00:00.000Z"}')).toBe('{"ok":true,"value":"sync"}')
      const worker = PipedWorker.last
      const calls = worker?.posted.filter((message) => message.type === 'call') ?? []
      const results = calls.map((message) => message.id)

      expect(new Set(results).size).toBe(results.length)
      expect(engine.calls.map((call) => call.method)).toContain('sync')
    })
  })

  test('open carries the database path merged into the config the engine is created with', async () => {
    const engine = createScriptedEngine()

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const config = '{"client_id":"c1","tables":{}}'
      const transport = driver.engineTransport(config, 'todos.db', noRemote, noRemote, () => {})

      await transport.call('outbox_depth', '{}')

      expect(JSON.parse(engine.created[0] ?? '{}')).toEqual({
        client_id: 'c1',
        tables: {},
        database_path: 'todos.db',
      })
    })
  })

  test('the store_kind probe fills the driver durability', async () => {
    const engine = createScriptedEngine()

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')

      expect(driver.durability).toBeUndefined()
      expect(driver.databasePath).toBe('todos.db')

      driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})
      await flush()

      expect(driver.durability).toBe('full')
    })
  })

  test('a pull the engine starts reaches the page and its answer reaches the engine', async () => {
    const engine = createScriptedEngine()
    const seen: string[] = []

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport(
        '{"client_id":"c1"}',
        'todos.db',
        async (requestJson) => {
          seen.push(requestJson)

          return '{"ok":true,"data":{"changes":[]}}'
        },
        noRemote,
        () => {},
      )

      await transport.call('outbox_depth', '{}')

      expect(await engine.pullThrough('{"bucket":"b"}')).toBe('{"ok":true,"data":{"changes":[]}}')
      expect(seen).toEqual(['{"bucket":"b"}'])
    })
  })

  test('a failed remote reaches the engine as an envelope that keeps its code and retry class', async () => {
    const engine = createScriptedEngine()
    const failures: unknown[] = [
      Object.assign(new Error('the session could not be read in time'), {
        retryable: true,
        code: 'AUTH_SESSION_TIMEOUT',
      }),
      Object.assign(new Error('the batch is refused for good'), { retryable: false }),
      'the page transport is gone',
    ]

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport(
        '{"client_id":"c1"}',
        'todos.db',
        async () => {
          throw failures.shift()
        },
        noRemote,
        () => {},
      )

      await transport.call('outbox_depth', '{}')

      // The envelope `remote_envelope::parse` reads: a retryable failure stays queued under its own code, and only an explicit `retryable: false` is permanent.
      expect(JSON.parse(await engine.pullThrough('{}'))).toEqual({
        ok: false,
        message: 'the session could not be read in time',
        retryable: true,
        code: 'AUTH_SESSION_TIMEOUT',
      })
      expect(JSON.parse(await engine.pullThrough('{}'))).toEqual({
        ok: false,
        message: 'the batch is refused for good',
        retryable: false,
      })
      expect(JSON.parse(await engine.pullThrough('{}'))).toEqual({
        ok: false,
        message: 'the page transport is gone',
        retryable: true,
      })
    })
  })

  test('crash recovery runs once, in the worker as it opens the store, never on a page request', async () => {
    const engine = createScriptedEngine()

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})

      expect(await transport.call('attachment_recover', '{}')).toBe('{"ok":true,"value":null}')
      await transport.call('outbox_depth', '{}')

      expect(engine.calls.filter((call) => call.method === 'attachment_recover')).toEqual([
        { method: 'attachment_recover', paramsJson: '{}' },
      ])
      expect(engine.calls[0]?.method).toBe('attachment_recover')
    })
  })

  test('an engine event reaches the onEvent the transport was built with', async () => {
    const engine = createScriptedEngine()
    const events: string[] = []

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, (eventJson) => {
        events.push(eventJson)
      })

      await transport.call('outbox_depth', '{}')

      engine.emit('{"type":"LOCAL_CHANGED"}')
      engine.emit('{"type":"QUEUE_DEPTH","depth":2}')

      expect(events).toEqual(['{"type":"LOCAL_CHANGED"}', '{"type":"QUEUE_DEPTH","depth":2}'])
    })
  })

  test('close frees the engine and terminates the worker', async () => {
    const engine = createScriptedEngine()

    await withPipedWorker(async () => engine, async () => {
      const driver = createWebWorkerDriver('todos.db')
      const transport = driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})

      await transport.call('outbox_depth', '{}')

      transport.close()
      await flush()

      expect(engine.freed).toBe(1)
      expect(PipedWorker.last?.terminated).toBe(true)
    })
  })
})
