/// <reference types="bun" />
/**
 * @kizunasync/web worker runtime: the worker's half of the protocol.
 *
 * A fake `KizunaSyncWasmEngine` stands in for the wasm bridge, so the message loop is
 * covered without a browser, OPFS or a wasm build: what is asserted here is that
 * every request answers on its own id, that calls reach the engine as they arrive
 * and a local call answers while a network call awaits the remote, that `open` and
 * `close` wait for the requests before them, that a remote round trip settles from
 * a `remote-result`, and that `close` frees the engine.
 *
 * The fake runs its network methods one at a time, as the engine's own gate does,
 * so the contract the page sees through the runtime is the bridge's.
 */

import { describe, expect, test } from 'bun:test'
import { createWorkerRuntime, type IWasmEngine } from './worker-runtime'
import type { TWorkerRequest, TWorkerResponse } from './worker-protocol'

interface IFakeEngine extends IWasmEngine {
  readonly created: string[]

  /** Every method the runtime handed to the engine, in arrival order. */
  readonly calls: string[]

  /** The methods that started running: a network method waits here for the one before it. */
  readonly started: string[]

  readonly maxConcurrentCalls: () => number
  readonly maxConcurrentNetworkCalls: () => number
  freed: number
  emit: (eventJson: string) => void
  pullThrough: (requestJson: string) => Promise<string>
}

/** The methods the engine's gate runs one at a time. */
const GATED_METHODS = new Set(['sync', 'sync_push', 'sync_pull', 'push_once', 'pull_once', 'reset', 'seed_checkpoint'])

const RECOVER = 'attachment_recover'

/** What the engine answers a crash recovery that reset its rows. */
const RECOVERED = '{"ok":true,"value":null}'

/** What the engine answers a crash recovery its store refused, byte for byte the shape of every engine failure. */
const RECOVERY_REFUSED = JSON.stringify({
  ok: false,
  error: { kind: 'store', code: 'STORE', message: 'store: sqlite: disk I/O error', retryable: false },
})

/**
 * `recovery` is what crash recovery answers. The engine answers it at once, in no
 * network turn, so the fake does too, whatever `answer` holds back.
 */
const createFakeEngine = (
  answer: (method: string) => Promise<string> = async () => '{}',
  recovery: string = RECOVERED,
): IFakeEngine => {
  const created: string[] = []
  const calls: string[] = []
  const started: string[] = []
  let inFlight = 0
  let peak = 0
  let networkInFlight = 0
  let networkPeak = 0
  let networkPending = 0
  let gate: Promise<void> = Promise.resolve()
  let listener: ((eventJson: string) => void) | undefined
  let pull: ((requestJson: string) => Promise<string>) | undefined

  const run = (method: string): Promise<string> => {
    started.push(method)

    return answer(method)
  }

  const admit = (method: string): Promise<string> => {
    networkInFlight += 1
    networkPeak = Math.max(networkPeak, networkInFlight)

    return run(method)
  }

  const leave = (): void => {
    networkInFlight -= 1
    networkPending -= 1
  }

  // Like the engine's gate, an idle one admits the call at once; a busy one queues it behind the call it holds.
  const runGated = (method: string): Promise<string> => {
    const turn = networkPending === 0 ? admit(method) : gate.then(() => admit(method))

    networkPending += 1
    gate = turn.then(leave, leave)

    return turn
  }

  return {
    created,
    calls,
    started,
    maxConcurrentCalls: () => peak,
    maxConcurrentNetworkCalls: () => networkPeak,
    freed: 0,
    create: async (configJson, pullPort) => {
      created.push(configJson)
      pull = pullPort
    },
    call: async (method) => {
      calls.push(method)

      if (method === RECOVER) {
        return recovery
      }
      inFlight += 1
      peak = Math.max(peak, inFlight)

      try {
        return await (GATED_METHODS.has(method) ? runGated(method) : run(method))
      } finally {
        inFlight -= 1
      }
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

/**
 * A macrotask turn drains every microtask the runtime's promise chain queues,
 * including the ones queued while draining.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const resultIds = (posted: TWorkerResponse[]): number[] =>
  posted.filter((message) => message.type === 'result').map((message) => message.id)

/** An answer the test settles by hand, keyed by method. */
const heldAnswers = (release: Map<string, () => void>) => (method: string): Promise<string> =>
  new Promise<string>((resolve) => {
    release.set(method, () => resolve(`{"ok":true,"value":"${method}"}`))
  })

describe('worker runtime', () => {
  test('answers open, call and close on their own ids and frees the engine', async () => {
    const engine = createFakeEngine(async () => '{"ok":true,"value":7}')
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{"client_id":"c1","database_path":"todos.db"}' })
    handle({ type: 'call', id: 2, method: 'outbox_depth', paramsJson: '{}' })
    handle({ type: 'close', id: 3 })
    await flush()

    expect(posted).toEqual([
      { type: 'result', id: 1, ok: true, value: '' },
      { type: 'result', id: 2, ok: true, value: '{"ok":true,"value":7}' },
      { type: 'result', id: 3, ok: true, value: '' },
    ])
    expect(engine.created).toEqual(['{"client_id":"c1","database_path":"todos.db"}'])
    expect(engine.freed).toBe(1)
  })

  test('open recovers crashed attachment claims once, before any call reaches the engine', async () => {
    const engine = createFakeEngine()
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    handle({ type: 'call', id: 2, method: 'attachment_claim', paramsJson: '{}' })
    handle({ type: 'call', id: 3, method: 'query', paramsJson: '{}' })
    await flush()

    expect(engine.calls).toEqual([RECOVER, 'attachment_claim', 'query'])
    expect(resultIds(posted)).toEqual([1, 2, 3])
  })

  test('a recovery the store refuses fails the open with the engine envelope and frees the engine', async () => {
    const engine = createFakeEngine(async () => '{}', RECOVERY_REFUSED)
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()

    expect(posted).toEqual([{ type: 'result', id: 1, ok: false, error: RECOVERY_REFUSED }])
    expect(engine.freed).toBe(1)
  })

  test('a local call answers while a network call awaits the remote, and network calls still run one at a time', async () => {
    const release = new Map<string, () => void>()
    const held = heldAnswers(release)
    const engine = createFakeEngine((method) => (method === 'query' ? Promise.resolve('{"ok":true,"value":[]}') : held(method)))
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    handle({ type: 'call', id: 2, method: 'sync', paramsJson: '{}' })
    handle({ type: 'call', id: 3, method: 'query', paramsJson: '{}' })
    handle({ type: 'call', id: 4, method: 'push_once', paramsJson: '{}' })
    await flush()

    expect(engine.calls).toEqual([RECOVER, 'sync', 'query', 'push_once'])
    expect(engine.started).toEqual(['sync', 'query'])
    expect(resultIds(posted)).toEqual([1, 3])
    expect(posted).toContainEqual({ type: 'result', id: 3, ok: true, value: '{"ok":true,"value":[]}' })

    release.get('sync')?.()
    await flush()
    expect(engine.started).toEqual(['sync', 'query', 'push_once'])
    expect(resultIds(posted)).toEqual([1, 3, 2])
    release.get('push_once')?.()
    await flush()

    expect(resultIds(posted)).toEqual([1, 3, 2, 4])
    expect(engine.maxConcurrentNetworkCalls()).toBe(1)
    expect(engine.maxConcurrentCalls()).toBe(3)
  })

  test('close waits for the calls in flight before it frees the engine', async () => {
    const release = new Map<string, () => void>()
    const engine = createFakeEngine(heldAnswers(release))
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    handle({ type: 'call', id: 2, method: 'sync', paramsJson: '{}' })
    handle({ type: 'close', id: 3 })
    handle({ type: 'call', id: 4, method: 'outbox_depth', paramsJson: '{}' })
    await flush()

    expect(engine.freed).toBe(0)
    expect(resultIds(posted)).toEqual([1])

    release.get('sync')?.()
    await flush()

    expect(engine.freed).toBe(1)
    expect(engine.calls).toEqual([RECOVER, 'sync'])
    expect(posted.filter((message) => message.type === 'result').map((message) => [message.id, message.ok])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ])
  })

  test('calls wait for the open before them, and a reopen waits for the calls before it', async () => {
    const release = new Map<string, () => void>()
    const engines = [createFakeEngine(heldAnswers(release)), createFakeEngine()]
    let releaseLoad: () => void = () => undefined
    const loaded = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    let loads = 0
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(
      async () => {
        await loaded
        const engine = engines[loads]

        loads += 1

        if (engine === undefined) {
          throw new Error('no engine left to load')
        }
        return engine
      },
      (message) => posted.push(message),
    )

    handle({ type: 'open', id: 1, configJson: '{}' })
    handle({ type: 'call', id: 2, method: 'sync', paramsJson: '{}' })
    handle({ type: 'open', id: 3, configJson: '{}' })
    handle({ type: 'call', id: 4, method: 'outbox_depth', paramsJson: '{}' })
    await flush()

    expect(engines[0]?.calls).toEqual([])
    expect(resultIds(posted)).toEqual([])

    releaseLoad()
    await flush()

    expect(engines[0]?.calls).toEqual([RECOVER, 'sync'])
    expect(loads).toBe(1)
    expect(resultIds(posted)).toEqual([1])

    release.get('sync')?.()
    await flush()

    expect(loads).toBe(2)
    expect(engines[0]?.freed).toBe(1)
    expect(engines[1]?.calls).toEqual([RECOVER, 'outbox_depth'])
    expect(resultIds(posted)).toEqual([1, 2, 3, 4])
  })

  test('a call before open fails on its own id instead of throwing', async () => {
    const engine = createFakeEngine()
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'call', id: 1, method: 'sync', paramsJson: '{}' })
    await flush()

    expect(posted).toEqual([
      {
        type: 'result',
        id: 1,
        ok: false,
        error: 'the @kizunasync/web worker received a call before the engine was opened',
      },
    ])
  })

  test('a failed open answers the open id with its message', async () => {
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(
      async () => {
        throw new Error('no persistent VFS is available')
      },
      (message) => posted.push(message),
    )

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()

    expect(posted).toEqual([
      { type: 'result', id: 1, ok: false, error: 'no persistent VFS is available' },
    ])
  })

  test('a create the store refuses forwards the engine failure envelope verbatim', async () => {
    // The wasm bridge rejects with a string, not an `Error`, and that string is the whole envelope: forwarding it unchanged is what lets the page rebuild the engine's own typed failure.
    const envelope = JSON.stringify({
      ok: false,
      error: {
        kind: 'store_busy',
        code: 'STORE_BUSY',
        name: 'todos.db',
        message: 'store: wasm store: OPFS store for "todos.db" is held by another browser context',
        retryable: true,
      },
    })
    const posted: TWorkerResponse[] = []
    let freed = 0
    const handle = createWorkerRuntime(
      async () => ({
        create: () => Promise.reject(envelope),
        call: async () => '{}',
        subscribe: () => 1,
        free: () => {
          freed += 1
        },
      }),
      (message) => posted.push(message),
    )

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()

    expect(posted).toEqual([{ type: 'result', id: 1, ok: false, error: envelope }])
    expect(freed).toBe(1)
  })

  test('a pull round trip posts remote and settles from remote-result', async () => {
    const engine = createFakeEngine()
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()

    const answered = engine.pullThrough('{"bucket":"b"}')

    await flush()
    const remote = posted.find((message) => message.type === 'remote')

    expect(remote).toEqual({ type: 'remote', id: 1, kind: 'pull', requestJson: '{"bucket":"b"}' })

    handle({ type: 'remote-result', id: 1, ok: true, value: '{"ok":true,"data":{}}' })
    expect(await answered).toBe('{"ok":true,"data":{}}')
  })

  test('a remote-result settles even while a call is in flight', async () => {
    let releaseCall: (() => void) | undefined
    const engine = createFakeEngine(
      () =>
        new Promise<string>((resolve) => {
          releaseCall = () => resolve('{"ok":true,"value":null}')
        }),
    )
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()
    handle({ type: 'call', id: 2, method: 'sync', paramsJson: '{}' })
    await flush()

    const answered = engine.pullThrough('{}')

    await flush()
    handle({ type: 'remote-result', id: 1, ok: false, error: 'offline' })

    await expect(answered).rejects.toThrow('offline')
    releaseCall?.()
    await flush()
    expect(posted.at(-1)).toEqual({ type: 'result', id: 2, ok: true, value: '{"ok":true,"value":null}' })
  })

  test('engine events are forwarded to the page', async () => {
    const engine = createFakeEngine()
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()
    engine.emit('{"type":"LOCAL_CHANGED"}')

    expect(posted).toContainEqual({ type: 'event', eventJson: '{"type":"LOCAL_CHANGED"}' })
  })

  test('an open carrying wasmUrl passes it to the engine factory', async () => {
    const engine = createFakeEngine()
    const seen: Array<string | undefined> = []
    const handle = createWorkerRuntime(
      async (wasmUrl) => {
        seen.push(wasmUrl)

        return engine
      },
      () => undefined,
    )

    handle({ type: 'open', id: 1, configJson: '{}', wasmUrl: 'https://example.test/engine.wasm' })
    await flush()

    expect(seen).toEqual(['https://example.test/engine.wasm'])
  })

  test('an open without wasmUrl calls the engine factory with undefined', async () => {
    const engine = createFakeEngine()
    const seen: Array<string | undefined> = []
    const handle = createWorkerRuntime(
      async (wasmUrl) => {
        seen.push(wasmUrl)

        return engine
      },
      () => undefined,
    )

    handle({ type: 'open', id: 1, configJson: '{}' })
    await flush()

    expect(seen).toEqual([undefined])
  })

  test('every request type answers on the id it was given', async () => {
    const engine = createFakeEngine(async () => '{"ok":true,"value":null}')
    const posted: TWorkerResponse[] = []
    const handle = createWorkerRuntime(async () => engine, (message) => posted.push(message))

    const requests: TWorkerRequest[] = [
      { type: 'open', id: 10, configJson: '{}' },
      { type: 'call', id: 11, method: 'sync', paramsJson: '{}' },
      { type: 'call', id: 12, method: 'outbox_depth', paramsJson: '{}' },
      { type: 'close', id: 13 },
    ]

    for (const request of requests) {
      handle(request)
    }
    await flush()

    expect(posted.filter((message) => message.type === 'result').map((message) => message.id)).toEqual([
      10, 11, 12, 13,
    ])
  })
})
