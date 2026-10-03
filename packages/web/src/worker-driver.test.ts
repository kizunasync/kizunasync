/// <reference types="bun" />
/**
 * @kizunasync/web worker driver: the page side, against a worker that answers on cue.
 *
 * These tests cover the transport, not the protocol. Calls wait for the open
 * handshake. An open the worker refuses fails every call with ENGINE_UNAVAILABLE;
 * it does not hang. Close terminates the worker and strands nothing. The driver
 * reports the database path and carries the transport.
 *
 * Bun has no `navigator.locks`. A tab without Web Locks cannot share its database,
 * so the driver keeps it on a private memory store; the tests that need a named
 * database install a lock manager that grants at once, a lone tab in a secure
 * context. Every transport here leads its own worker from the first tick. The
 * election itself, and the follower role it puts a transport in, are
 * leader.test.ts's subject.
 */

import { describe, expect, test } from 'bun:test'
import { EEngineErrorCode, TEngineError } from '@kizunasync/core'
import type { ILogger } from '@kizunasync/core'
import { createEngineTransport, createWebWorkerDriver } from './worker-driver'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

type TResultOutcome = { ok: true; value: string } | { ok: false; error: string }

const CLOSED_MESSAGE = 'the @kizunasync/web engine transport is closed'

class ScriptedWorker {
  static last: ScriptedWorker | undefined
  readonly posted: TWorkerRequest[] = []
  readonly listeners: Record<string, Array<(event: { data: unknown }) => void>> = {
    message: [],
    error: [],
  }
  terminated = false
  constructor(_url: unknown, _options: unknown) {
    ScriptedWorker.last = this
  }
  addEventListener(type: string, callback: (event: { data: unknown }) => void): void {
    ;(this.listeners[type] ??= []).push(callback)
  }
  postMessage(message: TWorkerRequest): void {
    this.posted.push(message)
  }
  terminate(): void {
    this.terminated = true
  }
  emit(type: string, data: unknown): void {
    for (const callback of this.listeners[type] ?? []) {
      callback({ data })
    }
  }

  /**
   * An `error` event carries its text on `message`, not on `data`; the driver
   * reads that field, so the fake has to deliver the real shape.
   */
  crash(message: string): void {
    for (const callback of this.listeners.error ?? []) {
      ;(callback as unknown as (event: { message: string }) => void)({ message })
    }
  }

  /** Answer the request of `type` the page posted, as the worker would. */
  answer(type: TWorkerRequest['type'], outcome: TResultOutcome): void {
    const request = this.posted.find((posted) => posted.type === type)

    if (request === undefined) {
      throw new Error(`the page never posted a ${type}`)
    }
    const response: TWorkerResponse = { type: 'result', id: request.id, ...outcome }

    this.emit('message', response)
  }
}

/** Web Locks for a lone tab: every request is granted in the caller's own tick. */
const grantAtOnce = {
  request: (_name: string, _options: unknown, callback: () => unknown): Promise<unknown> =>
    Promise.resolve(callback()),
}

/** `locks` is what `navigator.locks` holds for the body; `null` leaves the browser without Web Locks. */
const withScriptedWorker = async <T>(body: () => Promise<T>, locks: unknown = grantAtOnce): Promise<T> => {
  const previous = (globalThis as { Worker?: unknown }).Worker

  ;(globalThis as { Worker?: unknown }).Worker = ScriptedWorker as unknown

  if (locks !== null) {
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
  }
  try {
    return await body()
  } finally {
    ;(globalThis as { Worker?: unknown }).Worker = previous
    delete (navigator as { locks?: unknown }).locks
  }
}

type TLogged = [level: string, message: string, meta: unknown]

const recordingLogger = (logged: TLogged[]): ILogger => {
  const logger: ILogger = {
    debug: (message, meta) => logged.push(['debug', message, meta]),
    info: (message, meta) => logged.push(['info', message, meta]),
    warn: (message, meta) => logged.push(['warn', message, meta]),
    error: (message, meta) => logged.push(['error', message, meta]),
    child: () => logger,
  }

  return logger
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const noRemote = async (): Promise<string> => '{"ok":true,"data":{}}'

const openTransport = (name = 'todos.db') => {
  const driver = createWebWorkerDriver(name)
  const transport = driver.engineTransport('{"client_id":"c1"}', name, noRemote, noRemote, () => {})
  const worker = ScriptedWorker.last

  if (worker === undefined) {
    throw new Error('no worker was spawned')
  }
  return { driver, transport, worker }
}

const openReportingTransport = (name: string, logged: TLogged[]) => {
  const driver = createWebWorkerDriver(name, { logger: recordingLogger(logged) })

  driver.engineTransport('{"client_id":"c1"}', driver.databasePath, noRemote, noRemote, () => {})
  const worker = ScriptedWorker.last

  if (worker === undefined) {
    throw new Error('no worker was spawned')
  }
  return { driver, worker }
}

/** Opens the store and answers the `store_kind` call the transport posts after it, as the worker would. */
const answerStoreKind = async (worker: ScriptedWorker, storeKind: { kind: string; durability: string }): Promise<void> => {
  worker.answer('open', { ok: true, value: '' })
  await flush()
  worker.answer('call', { ok: true, value: JSON.stringify({ ok: true, value: storeKind }) })
  await flush()
}

describe('web worker driver', () => {
  test('spawns the worker and posts open as soon as the transport is built', async () => {
    await withScriptedWorker(async () => {
      const { worker } = openTransport()

      expect(worker.posted).toEqual([
        {
          type: 'open',
          id: 1,
          configJson: '{"client_id":"c1","database_path":"todos.db"}',
        },
      ])
    })
  })

  test('a call waits for the open handshake before it is posted', async () => {
    await withScriptedWorker(async () => {
      const { transport, worker } = openTransport()

      const answered = transport.call('sync', '{}')

      await flush()
      expect(worker.posted.some((message) => message.type === 'call')).toBe(false)

      worker.answer('open', { ok: true, value: '' })
      await flush()
      const call = worker.posted.find((message) => message.type === 'call')

      expect(call).toBeDefined()

      worker.emit('message', { type: 'result', id: call?.id, ok: true, value: '{"ok":true,"value":0}' })
      expect(await answered).toBe('{"ok":true,"value":0}')
    })
  })

  test('a refused open fails pending and later calls with ENGINE_UNAVAILABLE', async () => {
    await withScriptedWorker(async () => {
      const { transport, worker } = openTransport()

      const pendingCall = transport.call('sync', '{}')

      worker.answer('open', { ok: false, error: 'no persistent VFS is available' })

      for (const attempt of [pendingCall, transport.call('outbox_depth', '{}')]) {
        const error = await attempt.then(
          () => null,
          (reason: unknown) => reason,
        )

        expect(error).toBeInstanceOf(TEngineError)
        expect((error as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
        expect((error as TEngineError).message).toBe('no persistent VFS is available')
      }
    })
  })

  test('an open refused with a failure envelope keeps the store code it carries', async () => {
    await withScriptedWorker(async () => {
      const { transport, worker } = openTransport()

      const pendingCall = transport.call('sync', '{}')

      worker.answer('open', {
        ok: false,
        error: JSON.stringify({
          ok: false,
          error: {
            kind: 'store_busy',
            code: 'STORE_BUSY',
            name: 'todos.db',
            message: 'store: wasm store: OPFS store for "todos.db" is held by another browser context',
            retryable: true,
          },
        }),
      })

      const error = await pendingCall.then(
        () => null,
        (reason: unknown) => reason,
      )

      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.STORE_BUSY)
      expect((error as TEngineError).message).toContain('is held by another browser context')
      expect((error as { retryable?: boolean }).retryable).toBe(true)
    })
  })

  test('a worker that crashes fails the open instead of hanging it', async () => {
    await withScriptedWorker(async () => {
      const { transport, worker } = openTransport()

      const answered = transport.call('sync', '{}')

      worker.crash('the wasm module failed to load')

      await expect(answered).rejects.toThrow('the wasm module failed to load')
    })
  })

  test('a crash after the open resolved fails later calls instead of hanging them', async () => {
    await withScriptedWorker(async () => {
      const { transport, worker } = openTransport()

      worker.answer('open', { ok: true, value: '' })
      await flush()
      const postedBefore = worker.posted.length

      worker.crash('the worker was killed')
      // The open is already fulfilled, so only a latched failure can stop this call from posting to a dead worker and never settling.
      const later = transport.call('sync', '{}')
      const settled = await Promise.race([
        later.then(
          () => null,
          (reason: unknown) => reason,
        ),
        flush().then(() => 'STILL PENDING' as const),
      ])

      expect(settled).toBeInstanceOf(TEngineError)
      expect((settled as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
      expect((settled as TEngineError).message).toBe('the worker was killed')
      expect(worker.posted.length).toBe(postedBefore)
    })
  })

  test('close terminates the worker even when the close is never answered', async () => {
    await withScriptedWorker(async () => {
      // A 10 ms budget stands in for CLOSE_TIMEOUT_MS so the bounded wait is observable; the shipped default is 5 s.
      const transport = createEngineTransport({
        name: 'todos.db',
        onDurability: () => {},
        closeTimeoutMs: 10,
      })('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})
      const worker = ScriptedWorker.last

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      worker.answer('open', { ok: true, value: '' })
      await flush()

      const stranded = transport.call('sync', '{}')

      await flush()
      const settled = stranded.then(
        () => null,
        (reason: unknown) => reason,
      )

      transport.close() // the scripted worker never answers it

      expect(worker.terminated).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(worker.terminated).toBe(true)
      expect((await settled) as Error).toHaveProperty('message', CLOSED_MESSAGE)
    })
  })

  test('close terminates the worker and rejects a call left in flight', async () => {
    await withScriptedWorker(async () => {
      const { transport, worker } = openTransport()

      worker.answer('open', { ok: true, value: '' })
      await flush()

      const stranded = transport.call('sync', '{}')

      await flush()
      // Settled before close(), so the rejection close() causes is observed the moment it happens, not reported as unhandled.
      const settled = stranded.then(
        () => null,
        (reason: unknown) => reason,
      )

      transport.close()
      worker.answer('close', { ok: true, value: '' })
      await flush()

      expect(worker.terminated).toBe(true)
      expect((await settled) as Error).toHaveProperty('message', CLOSED_MESSAGE)
      await expect(transport.call('sync', '{}')).rejects.toThrow(CLOSED_MESSAGE)
    })
  })

  test('without Web Locks the driver keeps the tab on a private memory store and logs why', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const driver = createWebWorkerDriver('todos.db', { logger: recordingLogger(logged) })

      expect(driver.databasePath).toBeNull()
      expect(driver.durability).toBe('none')
      expect(logged).toEqual([
        [
          'warn',
          'driver.memory_store',
          { database: 'todos.db', reason: 'navigator.locks is unavailable: Web Locks need a secure context' },
        ],
      ])

      driver.engineTransport('{"client_id":"c1"}', driver.databasePath, noRemote, noRemote, () => {})

      expect(ScriptedWorker.last?.posted[0]).toEqual({
        type: 'open',
        id: 1,
        configJson: '{"client_id":"c1","database_path":null}',
      })
    }, null)
  })

  test('without Web Locks a driver asked for :memory: has nothing to report', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const driver = createWebWorkerDriver(':memory:', { logger: recordingLogger(logged) })

      expect(driver.databasePath).toBeNull()
      expect(driver.durability).toBe('none')
      expect(logged).toEqual([])
    }, null)
  })

  test('with Web Locks the driver names the database and logs nothing', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const driver = createWebWorkerDriver('todos.db', { logger: recordingLogger(logged) })

      expect(driver.databasePath).toBe('todos.db')
      expect(driver.durability).toBeUndefined()
      expect(logged).toEqual([])
    })
  })

  test('with Web Locks a store the engine reports as memory is logged as refused OPFS storage', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const { driver, worker } = openReportingTransport('todos.db', logged)

      await answerStoreKind(worker, { kind: 'memory', durability: 'none' })

      expect(driver.durability).toBe('none')
      expect(logged).toEqual([
        [
          'warn',
          'driver.memory_store',
          {
            database: 'todos.db',
            reason: 'the browser refused OPFS storage (private browsing), so the tab keeps a memory store',
          },
        ],
      ])
    })
  })

  test('with Web Locks the refused OPFS storage warning is logged once per driver', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const { driver, worker } = openReportingTransport('todos.db', logged)

      await answerStoreKind(worker, { kind: 'memory', durability: 'none' })
      driver.engineTransport('{"client_id":"c1"}', driver.databasePath, noRemote, noRemote, () => {})
      const reopened = ScriptedWorker.last

      if (reopened === undefined || reopened === worker) {
        throw new Error('the second transport spawned no worker')
      }
      await answerStoreKind(reopened, { kind: 'memory', durability: 'none' })

      expect(driver.durability).toBe('none')
      expect(logged).toHaveLength(1)
    })
  })

  test('with Web Locks a persistent store the engine reports logs nothing', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const { driver, worker } = openReportingTransport('todos.db', logged)

      await answerStoreKind(worker, { kind: 'opfs-sahpool', durability: 'full' })

      expect(driver.durability).toBe('full')
      expect(logged).toEqual([])
    })
  })

  test('with Web Locks a driver asked for :memory: logs nothing when the engine reports memory', async () => {
    await withScriptedWorker(async () => {
      const logged: TLogged[] = []
      const { driver, worker } = openReportingTransport(':memory:', logged)

      await answerStoreKind(worker, { kind: 'memory', durability: 'none' })

      expect(driver.durability).toBe('none')
      expect(logged).toEqual([])
    })
  })

  test('the driver names the database and carries the transport', async () => {
    await withScriptedWorker(async () => {
      const driver = createWebWorkerDriver('todos.db')

      expect(driver.databasePath).toBe('todos.db')
      expect(typeof driver.engineTransport).toBe('function')
    })
  })

  test('building the driver spawns no worker, requests no lock and opens no channel', async () => {
    const requested: string[] = []
    const countingLocks = {
      request: (name: string, options: unknown, callback: () => unknown): Promise<unknown> => {
        requested.push(name)

        return grantAtOnce.request(name, options, callback)
      },
    }
    const channels: string[] = []
    const scope = globalThis as { BroadcastChannel?: unknown }
    const previousChannel = scope.BroadcastChannel

    scope.BroadcastChannel = class {
      constructor(name: string) {
        channels.push(name)
      }
    }

    try {
      await withScriptedWorker(async () => {
        ScriptedWorker.last = undefined
        createWebWorkerDriver('todos.db')
        await flush()

        expect(ScriptedWorker.last).toBeUndefined()
        expect(requested).toEqual([])
        expect(channels).toEqual([])
      }, countingLocks)
    } finally {
      scope.BroadcastChannel = previousChannel
    }
  })

  test('the driver is built synchronously', async () => {
    await withScriptedWorker(async () => {
      const driver = createWebWorkerDriver('todos.db')

      expect(driver).not.toBeInstanceOf(Promise)
      expect(driver.databasePath).toBe('todos.db')
    })
  })

  test('the driver carries the browser connectivity and leaves the foreground to the app client', async () => {
    await withScriptedWorker(async () => {
      const driver = createWebWorkerDriver('todos.db')

      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

      try {
        expect(driver.platformPorts?.connectivity?.isOnline()).toBe(false)
        expect(driver.platformPorts?.foreground).toBeUndefined()
      } finally {
        delete (navigator as { onLine?: unknown }).onLine
      }
    })
  })

  test('a wasmUrl passed as a URL is posted with the open request as its href', async () => {
    await withScriptedWorker(async () => {
      const driver = createWebWorkerDriver('todos.db', {
        wasmUrl: new URL('https://example.test/engine.wasm'),
      })

      driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})
      const worker = ScriptedWorker.last

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      expect(worker.posted).toEqual([
        {
          type: 'open',
          id: 1,
          configJson: '{"client_id":"c1","database_path":"todos.db"}',
          wasmUrl: 'https://example.test/engine.wasm',
        },
      ])
    })
  })
})

describe('a wasmUrl resolved when the worker spawns', () => {
  test('a wasmUrl function is not called while the driver is built', async () => {
    let resolved = 0

    await withScriptedWorker(async () => {
      createWebWorkerDriver('todos.db', {
        wasmUrl: () => {
          resolved += 1

          return 'https://example.test/engine.wasm'
        },
      })
      await flush()

      expect(resolved).toBe(0)
    })
  })

  test.each([
    { returned: 'https://example.test/engine.wasm', posted: 'https://example.test/engine.wasm' },
    { returned: new URL('https://example.test/engine.wasm'), posted: 'https://example.test/engine.wasm' },
  ])('a wasmUrl function is called once, when the worker spawns, and its answer is posted with the open', async ({ returned, posted }) => {
    let resolved = 0

    await withScriptedWorker(async () => {
      const driver = createWebWorkerDriver('todos.db', {
        wasmUrl: () => {
          resolved += 1

          return returned
        },
      })

      driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})
      const worker = ScriptedWorker.last

      if (worker === undefined) {
        throw new Error('no worker was spawned')
      }
      expect(resolved).toBe(1)
      expect(worker.posted).toEqual([
        { type: 'open', id: 1, configJson: '{"client_id":"c1","database_path":"todos.db"}', wasmUrl: posted },
      ])
    })
  })

  test('a wasmUrl function that answers undefined leaves the worker on its bundled binary', async () => {
    await withScriptedWorker(async () => {
      const driver = createWebWorkerDriver('todos.db', { wasmUrl: () => undefined })

      driver.engineTransport('{"client_id":"c1"}', 'todos.db', noRemote, noRemote, () => {})

      expect(ScriptedWorker.last?.posted).toEqual([
        { type: 'open', id: 1, configJson: '{"client_id":"c1","database_path":"todos.db"}' },
      ])
    })
  })
})

describe('the open config boundary', () => {
  const transportFor = (configJson: string) => {
    const driver = createWebWorkerDriver('todos.db')
    const transport = driver.engineTransport(configJson, 'todos.db', noRemote, noRemote, () => {})
    const worker = ScriptedWorker.last

    if (worker === undefined) {
      throw new Error('no worker was spawned')
    }
    return { transport, worker }
  }

  test.each(['null', '[]', 'not json'])('a config of %p posts no open and fails every call with the JSON engine error', async (configJson) => {
    await withScriptedWorker(async () => {
      const { transport, worker } = transportFor(configJson)
      const error = await transport.call('sync', '{}').then(
        () => null,
        (reason: unknown) => reason,
      )

      expect(error).toBeInstanceOf(TEngineError)
      expect((error as TEngineError).code).toBe(EEngineErrorCode.JSON)
      expect(worker.posted).toEqual([])
    })
  })

  test.each([
    ['{}', '{"database_path":"todos.db"}'],
    ['{"ok":false}', '{"ok":false,"database_path":"todos.db"}'],
    ['{"client_id":"c1"}', '{"client_id":"c1","database_path":"todos.db"}'],
  ])('a config of %p is posted with the database path merged in', async (configJson, posted) => {
    await withScriptedWorker(async () => {
      const { worker } = transportFor(configJson)

      expect(worker.posted).toEqual([{ type: 'open', id: 1, configJson: posted }])
    })
  })
})
