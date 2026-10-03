/// <reference types="bun" />
/**
 * What `createKizunaSync` does before its engine opens, and what the open
 * decides. Construction checks the config and stops there: it selects no
 * engine, arms no timer, and subscribes to no port, so an app can build its
 * client at module scope, including in a render pass that never runs it. The
 * first call that needs the engine opens it, once, and starts the automatic
 * loop, which runs one attempt right away; a session token handed earlier is
 * kept and reaches the engine before anything else. A failed open is kept as
 * one typed error: engine calls fail with it, while the subscriptions and the
 * health read report it without throwing. The open also picks the platform
 * ports the loop listens to and carries each table's bucket owner flag into
 * the engine config. A port that throws when the loop subscribes to it loses
 * that trigger and logs one warning; the open still succeeds.
 *
 * A fake driver transport stands in for the engine: the wiring is under test,
 * not the Rust core.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { byColumn, byOwner, defineConfig, type TKizunaSyncConfig } from '../config/config'
import type { ISyncHealth } from '../host/sync-health'
import { WAKE_DEBOUNCE_MS } from '../host/sync-scheduler'
import { alwaysOnline, type IConnectivity } from '../ports/connectivity'
import type { IEngineLeadership, TEngineTransportFactory } from '../ports/engine-transport'
import type { IFileStore } from '../ports/file-store'
import type { IForeground } from '../ports/foreground'
import type { IProtocolRemote } from '../ports/protocol-remote'
import type { IStoreLocator } from '../ports/store-locator'
import type { ITransfer } from '../ports/transfer'
import type { ILogger } from '../util/logger'
import { EEngineErrorCode, TEngineError } from '../wire/types'
import { createKizunaSync, type IKizunaSync, type IKizunaSyncOptions } from './kizunasync'

const NOW = '2024-01-01T00:00:00.000Z'

const MUTATION_ID = '00000000-0000-4000-8000-000000000009'

/** Sentinels: only the decision to build the attachment queue is under test, never a transfer. */
const FAKE_FILE_STORE = {} as unknown as IFileStore
const FAKE_TRANSFER = {} as unknown as ITransfer

const idleRemote: IProtocolRemote = {
  pull: () => Promise.reject(new Error('the fake transport never calls the remote')),
  push: () => Promise.reject(new Error('the fake transport never calls the remote')),
}

const CONFIG = defineConfig({
  tables: { items: { sync: 'read-write', bucket: byOwner('user_id') } },
})

/** What the fake engine answers each method with, shaped like the Rust envelope values. */
const answerOf = (method: string): unknown => {
  switch (method) {
    case 'checkpoint':
      return { cursor: '0', soft_blocked: false, soft_block_reason: null }
    case 'outbox_depth':
      return 0
    case 'rejections':
    case 'overwrites':
    case 'reset':
    case 'query':
      return []
    case 'inspect':
      return { queued: [], depth: 0, last_mutation_id: null, cursor: '0', client_id: '' }
    default:
      return null
  }
}

// MARK: - Harness

/** A port the test counts subscriptions on and rings by hand. */
type TRecordingSignal = {
  subscribe: (listener: () => void) => () => void
  subscriptions: () => number
  ring: () => void
}

const recordingSignal = (): TRecordingSignal => {
  const listeners = new Set<() => void>()
  let subscriptions = 0

  return {
    subscribe: (listener) => {
      subscriptions += 1
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    subscriptions: () => subscriptions,
    ring: () => {
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

type TRecordingConnectivity = IConnectivity & { subscriptions: () => number }

const recordingConnectivity = (): TRecordingConnectivity => {
  let subscriptions = 0

  return {
    isOnline: () => true,
    subscribe: () => {
      subscriptions += 1

      return () => undefined
    },
    subscriptions: () => subscriptions,
  }
}

type THarnessInput = {
  config?: TKizunaSyncConfig
  platformPorts?: IStoreLocator['platformPorts']
  options?: IKizunaSyncOptions

  /** Thrown by the driver transport instead of opening. */
  openFailure?: unknown

  /** Carried by the driver transport, as the web worker driver's tabs carry theirs. */
  leadership?: IEngineLeadership
}

type TOpenHarness = {
  client: IKizunaSync

  /** How many times the driver transport opened an engine. */
  opens: () => number

  /** The engine config JSON of the last open, parsed. */
  openedConfig: () => { tables: Record<string, Record<string, unknown>> }

  /** Every engine method called, in order. */
  calls: string[]

  /** The token of every `set_access_token` call, in order. */
  tokens: () => Array<string | null>

  /** Delays of every timer armed so far, in order. */
  armedDelays: number[]

  /** Run every timer due now, letting the callbacks re-arm as they go. */
  fire: () => Promise<void>
}

const built: IKizunaSync[] = []

afterEach(() => {
  while (built.length > 0) {
    built.pop()?.dispose()
  }
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const openHarness = (input: THarnessInput = {}): TOpenHarness => {
  const configs: string[] = []
  const calls: string[] = []
  const tokens: Array<string | null> = []
  const armedDelays: number[] = []
  const pending = new Map<number, () => void>()
  let nextHandle = 0
  const engineTransport: TEngineTransportFactory = (configJson) => {
    configs.push(configJson)

    if (input.openFailure !== undefined) {
      throw input.openFailure
    }
    return {
      call: async (method, paramsJson) => {
        calls.push(method)

        if (method === 'set_access_token') {
          tokens.push((JSON.parse(paramsJson) as { token: string | null }).token)
        }
        return JSON.stringify({ ok: true, value: answerOf(method) })
      },
      close: () => undefined,
      leadership: input.leadership,
    }
  }
  const driver: IStoreLocator = { databasePath: null, engineTransport, platformPorts: input.platformPorts }
  const client = createKizunaSync(driver, idleRemote, input.config ?? CONFIG, {
    inspector: false,
    now: () => NOW,
    pollIntervalMs: 0,
    setTimer: (callback, delayMs) => {
      armedDelays.push(delayMs)
      nextHandle += 1
      pending.set(nextHandle, callback)

      return nextHandle
    },
    clearTimer: (handle) => {
      pending.delete(handle as number)
    },
    ...input.options,
  })

  built.push(client)

  return {
    client,
    opens: () => configs.length,
    openedConfig: () => JSON.parse(configs.at(-1)!) as { tables: Record<string, Record<string, unknown>> },
    calls,
    tokens: () => tokens,
    armedDelays,
    fire: async () => {
      const due = [...pending.values()]

      pending.clear()

      for (const callback of due) {
        callback()
      }
      await flush()
    },
  }
}

/** Every member that reaches the engine, used the way an app uses it. */
const ENGINE_USES: Array<{ name: string; use: (client: IKizunaSync) => unknown }> = [
  { name: 'a from() read', use: (client) => Promise.resolve(client.from('items').select()) },
  { name: 'a from() insert', use: (client) => client.from('items').insert({ title: 'works on a plane' }) },
  { name: 'on()', use: (client) => client.on(() => undefined) },
  { name: 'setBucket()', use: (client) => client.setBucket({ user_id: 'user-a' }) },
  { name: 'sync()', use: (client) => client.sync() },
  { name: 'pullOnce()', use: (client) => client.pullOnce() },
  { name: 'pushOnce()', use: (client) => client.pushOnce() },
  { name: 'getCheckpoint()', use: (client) => client.getCheckpoint() },
  { name: 'getOutboxDepth()', use: (client) => client.getOutboxDepth() },
  { name: 'getSyncHealth()', use: (client) => client.getSyncHealth() },
  { name: 'onSyncHealth()', use: (client) => client.onSyncHealth(() => undefined) },
  { name: 'rejections()', use: (client) => client.rejections() },
  { name: 'dismissRejection()', use: (client) => client.dismissRejection(MUTATION_ID) },
  { name: 'overwrites()', use: (client) => client.overwrites() },
  { name: 'dismissOverwrite()', use: (client) => client.dismissOverwrite(1) },
  { name: 'reset()', use: (client) => client.reset() },
  { name: 'seedCheckpoint()', use: (client) => client.seedCheckpoint('0') },
  { name: 'the engine kind', use: (client) => client.engine },
]

// MARK: - Before the first use

describe('createKizunaSync construction', () => {
  test('selects no engine, arms no timer and subscribes to no port', () => {
    const connectivity = recordingConnectivity()
    const foreground = recordingSignal()
    const wakeup = recordingSignal()
    const run = openHarness({ options: { connectivity, foreground, wakeup, pollIntervalMs: 1_000 } })

    expect(run.client).toBeDefined()
    expect(run.opens()).toBe(0)
    expect(run.calls).toEqual([])
    expect(run.armedDelays).toEqual([])
    expect(connectivity.subscriptions()).toBe(0)
    expect(foreground.subscriptions()).toBe(0)
    expect(wakeup.subscriptions()).toBe(0)
  })

  test('from() alone and the connectivity port open nothing', () => {
    const run = openHarness()

    run.client.from('items')
    expect(run.client.connectivity).toBeDefined()
    expect(run.opens()).toBe(0)
  })

  test('a config the client refuses still throws at construction', () => {
    const config = { ...CONFIG, pullLimit: 0 }

    expect(() => openHarness({ config })).toThrow(TEngineError)
  })

  test('dispose before the first use opens nothing and arms nothing', () => {
    const run = openHarness({ options: { pollIntervalMs: 1_000 } })

    run.client.dispose()

    expect(run.opens()).toBe(0)
    expect(run.armedDelays).toEqual([])
  })

  test('a client disposed before its first use reports an idle loop, not a failure', () => {
    const run = openHarness()
    const seen: unknown[] = []

    run.client.dispose()
    run.client.onSyncHealth((health) => {
      seen.push(health)
    })

    const idle: ISyncHealth = {
      phase: 'idle',
      consecutiveFailures: 0,
      nextAttemptAt: null,
      attemptStartedAt: null,
      lastSuccessAt: null,
      lastError: null,
      softBlockReason: null,
    }

    expect(run.client.getSyncHealth()).toEqual(idle)
    expect(seen).toEqual([idle])
    expect(() => run.client.on(() => undefined)).not.toThrow()
    expect(run.opens()).toBe(0)
  })

  test('a client disposed before its first use never opens an engine afterwards', async () => {
    const run = openHarness()

    run.client.dispose()

    const error = await run.client.sync().then(
      () => null,
      (failure: unknown) => failure,
    )

    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect((error as TEngineError).message).toContain('disposed')
    await expect(run.client.setRemoteAccessToken('session-jwt')).rejects.toBe(error)
    expect(run.opens()).toBe(0)
    expect(run.armedDelays).toEqual([])
  })

  test('the attachment surface and the inspector open nothing when read', () => {
    const run = openHarness({ options: { inspector: true, fileStore: FAKE_FILE_STORE, transfer: FAKE_TRANSFER } })

    expect(run.client.attachments).not.toBeNull()
    expect(run.client.inspector).not.toBeNull()
    expect(run.opens()).toBe(0)
  })

  test('without the ports the attachment surface is still an object, the inspector reads null, and nothing opens', () => {
    const run = openHarness()

    expect(run.client.attachments).toBeObject()
    expect(run.client.inspector).toBeNull()
    expect(run.opens()).toBe(0)
  })
})

// MARK: - No attachment ports

/** Every promise-returning attachment method, called the way an app calls it. */
const ATTACHMENT_CALLS: Array<{ name: string; call: (client: IKizunaSync) => Promise<unknown> }> = [
  { name: 'fromFile', call: (client) => client.attachments.fromFile({ table: 'items', column: 'image_path', pk: 'a', uri: 'blob:a' }) },
  { name: 'resolveDownload', call: (client) => client.attachments.resolveDownload('u/a/b.jpg') },
  { name: 'vacuum', call: (client) => client.attachments.vacuum() },
  { name: 'getStatus', call: (client) => client.attachments.getStatus('u/a/b.jpg') },
  { name: 'retry', call: (client) => client.attachments.retry('u/a/b.jpg') },
  { name: 'cancel', call: (client) => client.attachments.cancel('u/a/b.jpg') },
  { name: 'remove', call: (client) => client.attachments.remove('u/a/b.jpg') },
]

describe('createKizunaSync without attachment ports', () => {
  test.each(ATTACHMENT_CALLS)('attachments.$name rejects with ATTACHMENT_PORTS_MISSING and opens no engine', async ({ call }) => {
    const run = openHarness()
    const refusal = await call(run.client).then(
      () => expect.unreachable('expected ATTACHMENT_PORTS_MISSING'),
      (error: unknown) => error,
    )

    expect(refusal).toBeInstanceOf(TEngineError)
    expect((refusal as TEngineError).code).toBe(EEngineErrorCode.ATTACHMENT_PORTS_MISSING)
    expect(run.opens()).toBe(0)
  })

  test('attachments.watch returns an unsubscribe that does nothing, and opens no engine', () => {
    const run = openHarness()
    const heard: unknown[] = []
    const stopWatching = run.client.attachments.watch('u/a/b.jpg', (status) => {
      heard.push(status)
    })

    stopWatching()
    expect(heard).toEqual([])
    expect(run.opens()).toBe(0)
  })
})

// MARK: - A token before the open

describe('createKizunaSync session token before the first use', () => {
  test('setRemoteAccessToken keeps the token and opens nothing', async () => {
    const run = openHarness()

    await run.client.setRemoteAccessToken('jwt-1')

    expect(run.opens()).toBe(0)
    expect(run.calls).toEqual([])
  })

  test('the first use opens once and hands the engine the latest token before any other call', async () => {
    const run = openHarness()

    await run.client.setRemoteAccessToken('jwt-1')
    await run.client.setRemoteAccessToken('jwt-2')
    await run.client.getOutboxDepth()

    expect(run.opens()).toBe(1)
    expect(run.calls[0]).toBe('set_access_token')
    expect(run.tokens()).toEqual(['jwt-2'])
  })

  test('a cleared token is handed over as null', async () => {
    const run = openHarness()

    await run.client.setRemoteAccessToken('jwt-1')
    await run.client.setRemoteAccessToken(null)
    await run.client.getOutboxDepth()

    expect(run.calls[0]).toBe('set_access_token')
    expect(run.tokens()).toEqual([null])
  })

  test('with no token handed, the engine receives none at the open', async () => {
    const run = openHarness()

    await run.client.getOutboxDepth()

    expect(run.calls).not.toContain('set_access_token')
  })

  test('once open, a token reaches the engine directly', async () => {
    const run = openHarness()

    await run.client.getOutboxDepth()
    await run.client.setRemoteAccessToken('jwt-3')

    expect(run.tokens()).toEqual(['jwt-3'])
  })
})

// MARK: - The first use

describe('createKizunaSync first use', () => {
  test.each(ENGINE_USES)('$name opens the engine', async ({ use }) => {
    const run = openHarness()

    await use(run.client)

    expect(run.opens()).toBe(1)
  })

  test('concurrent first uses share one open, and later uses reuse it', async () => {
    const run = openHarness()

    await Promise.all([run.client.sync(), run.client.getOutboxDepth(), run.client.rejections()])
    await run.client.getCheckpoint()

    expect(run.opens()).toBe(1)
  })

  test('an inspector method opens the engine', async () => {
    const run = openHarness({ options: { inspector: true } })

    await run.client.inspector?.snapshot()

    expect(run.opens()).toBe(1)
  })

  test('an attachment method opens the engine', async () => {
    const run = openHarness({ options: { fileStore: FAKE_FILE_STORE, transfer: FAKE_TRANSFER } })

    await run.client.attachments.getStatus('todos/a.jpg')

    expect(run.opens()).toBe(1)
  })

  test('the synchronous inspector and attachment members open the engine and delegate', () => {
    const run = openHarness({ options: { inspector: true, fileStore: FAKE_FILE_STORE, transfer: FAKE_TRANSFER } })

    expect(run.client.inspector!.verdicts()).toEqual([])
    expect(run.opens()).toBe(1)

    const stopWatching = run.client.attachments.watch('todos/a.jpg', () => undefined)

    stopWatching()
    expect(run.opens()).toBe(1)
  })
})

// MARK: - A failed open

describe('createKizunaSync open failure', () => {
  const storeBusy = (): TEngineError =>
    new TEngineError(EEngineErrorCode.STORE_BUSY, 'the store is held by another tab')

  test('fails the call that opened and every later engine call with the same error, without opening again', async () => {
    const failure = storeBusy()
    const run = openHarness({ openFailure: failure })

    await expect(run.client.sync()).rejects.toBe(failure)
    await expect(run.client.getOutboxDepth()).rejects.toBe(failure)
    await expect(run.client.rejections()).rejects.toBe(failure)
    await expect(run.client.setRemoteAccessToken('session-jwt')).rejects.toBe(failure)

    expect(run.opens()).toBe(1)
    expect(run.armedDelays).toEqual([])
  })

  test('a from() builder surfaces the failure when it executes, not when it is built', async () => {
    const failure = storeBusy()
    const run = openHarness({ openFailure: failure })
    const select = run.client.from('items').select()

    await expect(Promise.resolve(select)).rejects.toBe(failure)
    await expect(run.client.from('items').insert({ title: 'works on a plane' })).rejects.toBe(failure)
    await expect(Promise.resolve(run.client.from('items').update({ title: 'x' }).eq('id', 'a'))).rejects.toBe(failure)
  })

  test('setBucket and the engine kind throw the same error', () => {
    const failure = storeBusy()
    const run = openHarness({ openFailure: failure })

    expect(() => {
      run.client.setBucket({ user_id: 'user-a' })
    }).toThrow(failure)
    expect(() => run.client.engine).toThrow(failure)
    expect(run.opens()).toBe(1)
  })

  test('on() returns an unsubscribe that does nothing, and never throws', () => {
    const run = openHarness({ openFailure: storeBusy() })
    const unsubscribe = run.client.on(() => undefined)

    expect(() => {
      unsubscribe()
    }).not.toThrow()
    expect(run.opens()).toBe(1)
  })

  test('getSyncHealth() reports the failure as a backoff snapshot', () => {
    const failure = storeBusy()
    const run = openHarness({ openFailure: failure })

    expect(run.client.getSyncHealth()).toEqual({
      phase: 'backoff',
      consecutiveFailures: 1,
      nextAttemptAt: null,
      attemptStartedAt: null,
      lastSuccessAt: null,
      lastError: { code: EEngineErrorCode.STORE_BUSY, message: failure.message, at: Date.parse(NOW) },
      softBlockReason: null,
    })
  })

  test('onSyncHealth() hands the listener that snapshot once and returns an unsubscribe that does nothing', () => {
    const run = openHarness({ openFailure: storeBusy() })
    const seen: unknown[] = []
    const unsubscribe = run.client.onSyncHealth((health) => {
      seen.push(health)
    })

    expect(seen).toEqual([run.client.getSyncHealth()])
    expect(() => {
      unsubscribe()
    }).not.toThrow()
  })

  test('the inspector and attachment subscriptions and synchronous reads stay silent', () => {
    const run = openHarness({ openFailure: storeBusy(), options: { inspector: true, fileStore: FAKE_FILE_STORE, transfer: FAKE_TRANSFER } })
    const stopWatching = run.client.attachments.watch('todos/a.jpg', () => undefined)
    const stopListening = run.client.inspector!.subscribe(() => undefined)

    expect(run.client.inspector!.verdicts()).toEqual([])
    expect(() => {
      run.client.inspector!.clear()
      stopWatching()
      stopListening()
    }).not.toThrow()
    expect(run.opens()).toBe(1)
  })

  test('an inspector or attachment method rejects with the same error', async () => {
    const failure = storeBusy()
    const run = openHarness({ openFailure: failure, options: { inspector: true, fileStore: FAKE_FILE_STORE, transfer: FAKE_TRANSFER } })

    await expect(run.client.inspector!.snapshot()).rejects.toBe(failure)
    await expect(run.client.attachments.getStatus('todos/a.jpg')).rejects.toBe(failure)
  })

  test('dispose after a failed open throws nothing', () => {
    const run = openHarness({ openFailure: storeBusy() })

    expect(() => run.client.engine).toThrow(TEngineError)
    expect(() => run.client.dispose()).not.toThrow()
  })

  test('an N-API `<CODE>: <detail>` constructor error becomes a TEngineError with that catalog code', async () => {
    const run = openHarness({ openFailure: new Error('STORE_BUSY: the store is held by another tab') })
    const error = await run.client.sync().then(
      () => null,
      (failure: unknown) => failure,
    )

    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.STORE_BUSY)
    expect((error as TEngineError).message).toBe('the store is held by another tab')
    expect((error as TEngineError).retryable).toBe(true)
    await expect(run.client.getOutboxDepth()).rejects.toBe(error)
  })

  test('an open error with no catalog code becomes ENGINE_UNAVAILABLE with its message', async () => {
    const run = openHarness({ openFailure: new Error('engine thread died during startup') })
    const error = await run.client.sync().then(
      () => null,
      (failure: unknown) => failure,
    )

    expect(error).toBeInstanceOf(TEngineError)
    expect((error as TEngineError).code).toBe(EEngineErrorCode.ENGINE_UNAVAILABLE)
    expect((error as TEngineError).message).toBe('engine thread died during startup')
  })
})

// MARK: - The first attempt

describe('createKizunaSync start attempt', () => {
  test('the loop runs one attempt right after the open, inside the wake debounce', async () => {
    const run = openHarness()

    await run.client.getOutboxDepth()
    expect(run.armedDelays).toEqual([WAKE_DEBOUNCE_MS])

    await run.fire()
    expect(run.calls.filter((method) => method === 'sync')).toHaveLength(1)
  })

  test('the poll resumes its own interval after the start attempt', async () => {
    const run = openHarness({ options: { pollIntervalMs: 1_000 } })

    await run.client.getOutboxDepth()
    expect(run.armedDelays.at(-1)).toBe(WAKE_DEBOUNCE_MS)

    await run.fire()
    const pollDelay = run.armedDelays.at(-1)!

    expect(run.calls.filter((method) => method === 'sync')).toHaveLength(1)
    expect(pollDelay).toBeGreaterThanOrEqual(500)
    expect(pollDelay).toBeLessThanOrEqual(1_000)
  })

  test('no start attempt while shouldSyncAutomatically answers false', async () => {
    const run = openHarness({ options: { shouldSyncAutomatically: () => false } })

    await run.client.getOutboxDepth()
    await run.fire()

    expect(run.armedDelays).toEqual([])
    expect(run.calls).not.toContain('sync')
  })
})

// MARK: - Platform ports

describe('createKizunaSync platform ports', () => {
  test('an explicit connectivity wins over the driver one', async () => {
    const explicit = recordingConnectivity()
    const fromDriver = recordingConnectivity()
    const run = openHarness({ platformPorts: { connectivity: fromDriver }, options: { connectivity: explicit } })

    expect(run.client.connectivity).toBe(explicit)

    await run.client.getOutboxDepth()
    expect(explicit.subscriptions()).toBe(1)
    expect(fromDriver.subscriptions()).toBe(0)
  })

  test('the driver connectivity is used when no option names one', async () => {
    const fromDriver = recordingConnectivity()
    const run = openHarness({ platformPorts: { connectivity: fromDriver } })

    expect(run.client.connectivity).toBe(fromDriver)

    await run.client.getOutboxDepth()
    expect(fromDriver.subscriptions()).toBe(1)
  })

  test('with neither, the client reports alwaysOnline', () => {
    const run = openHarness()

    expect(run.client.connectivity).toBe(alwaysOnline)
  })

  test('an explicit foreground wins over the driver one', async () => {
    const explicit = recordingSignal()
    const fromDriver = recordingSignal()
    const run = openHarness({ platformPorts: { foreground: fromDriver }, options: { foreground: explicit } })

    await run.client.getOutboxDepth()
    expect(explicit.subscriptions()).toBe(1)
    expect(fromDriver.subscriptions()).toBe(0)
  })

  test('the driver foreground wakes the loop when no option names one', async () => {
    const fromDriver: IForeground & TRecordingSignal = recordingSignal()
    const run = openHarness({ platformPorts: { foreground: fromDriver } })

    await run.client.getOutboxDepth()
    await run.fire()
    expect(fromDriver.subscriptions()).toBe(1)

    fromDriver.ring()
    expect(run.armedDelays.at(-1)).toBe(WAKE_DEBOUNCE_MS)

    await run.fire()
    expect(run.calls.filter((method) => method === 'sync')).toHaveLength(2)
  })
})

// MARK: - A port that throws at subscribe

type TLogLine = { level: 'debug' | 'info' | 'warn' | 'error'; message: string; meta: unknown }

const recordingLogger = (lines: TLogLine[]): ILogger => {
  const at =
    (level: TLogLine['level']) =>
    (message: string, meta?: unknown): void => {
      lines.push({ level, message, meta })
    }
  const logger: ILogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }

  return logger
}

/** Appears only in the thrown message, so a warning that quoted the message would leak a session. */
const TOKEN_IN_MESSAGE = 'eyJhbGciOiJIUzI1NiJ9.session-jwt'

const SUBSCRIBE_REFUSED = 'SUBSCRIBE_REFUSED'

const refuseSubscription = (): never => {
  throw Object.assign(new Error(`subscribe refused for ${TOKEN_IN_MESSAGE}`), { code: SUBSCRIBE_REFUSED })
}

/** Each port the loop subscribes to at the open, set to throw, and a working trigger of another kind for the loop to keep. */
const THROWING_PORTS: Array<{ port: string; refusing: THarnessInput; otherTrigger: 'foreground' | 'wakeup' }> = [
  { port: 'connectivity', refusing: { options: { connectivity: { isOnline: () => true, subscribe: refuseSubscription } } }, otherTrigger: 'foreground' },
  { port: 'wakeup', refusing: { options: { wakeup: { subscribe: refuseSubscription } } }, otherTrigger: 'foreground' },
  { port: 'foreground', refusing: { options: { foreground: { subscribe: refuseSubscription } } }, otherTrigger: 'wakeup' },
  { port: 'leadership', refusing: { leadership: { isLeader: () => true, subscribe: refuseSubscription } }, otherTrigger: 'foreground' },
]

describe('createKizunaSync platform port that throws at subscribe', () => {
  test.each(THROWING_PORTS)('a $port port is skipped with one warning naming it, the code and the error name, and the client reads, writes and syncs', async ({ port, refusing }) => {
    const lines: TLogLine[] = []
    const run = openHarness({ ...refusing, options: { ...refusing.options, logging: { logger: recordingLogger(lines) } } })
    const read = await run.client.from('items').select()
    const write = await run.client.from('items').insert({ title: 'works on a plane' })

    await run.client.sync()

    expect(read.error).toBeNull()
    expect(write.error).toBeNull()
    expect(run.opens()).toBe(1)
    expect(run.calls).toContain('query')
    expect(run.calls).toContain('apply')
    expect(run.calls).toContain('sync')
    expect(run.client.getSyncHealth().lastError).toBeNull()
    expect(lines.filter((line) => line.level === 'warn' || line.level === 'error')).toEqual([
      { level: 'warn', message: 'port.subscribe_failed', meta: { port, code: SUBSCRIBE_REFUSED, name: 'Error' } },
    ])
    expect(JSON.stringify(lines)).not.toContain(TOKEN_IN_MESSAGE)
  })

  test.each(THROWING_PORTS)('the loop keeps its start attempt, its poll and its other triggers when the $port port throws', async ({ refusing, otherTrigger }) => {
    const other = recordingSignal()
    const run = openHarness({ ...refusing, options: { ...refusing.options, pollIntervalMs: 1_000, [otherTrigger]: other } })
    const syncs = (): number => run.calls.filter((method) => method === 'sync').length

    await run.client.getOutboxDepth()
    expect(run.armedDelays.at(-1)).toBe(WAKE_DEBOUNCE_MS)

    await run.fire()
    const pollDelay = run.armedDelays.at(-1)!

    expect(syncs()).toBe(1)
    expect(pollDelay).toBeGreaterThanOrEqual(500)
    expect(pollDelay).toBeLessThanOrEqual(1_000)
    expect(other.subscriptions()).toBe(1)

    other.ring()
    expect(run.armedDelays.at(-1)).toBe(WAKE_DEBOUNCE_MS)

    await run.fire()
    expect(syncs()).toBe(2)
  })

  test('a port that throws an error with no code is logged with a null code and the error name', async () => {
    const lines: TLogLine[] = []
    const run = openHarness({
      options: {
        foreground: {
          subscribe: () => {
            throw new TypeError(`client.channel is not a function (${TOKEN_IN_MESSAGE})`)
          },
        },
        logging: { logger: recordingLogger(lines) },
      },
    })

    await run.client.getOutboxDepth()

    expect(lines.filter((line) => line.level === 'warn')).toEqual([
      { level: 'warn', message: 'port.subscribe_failed', meta: { port: 'foreground', code: null, name: 'TypeError' } },
    ])
    expect(JSON.stringify(lines)).not.toContain(TOKEN_IN_MESSAGE)
  })

  test('a port that throws a value that is not an error is logged with a null code and a null name', async () => {
    const lines: TLogLine[] = []
    const run = openHarness({
      options: {
        foreground: {
          subscribe: () => {
            throw `refused for ${TOKEN_IN_MESSAGE}`
          },
        },
        logging: { logger: recordingLogger(lines) },
      },
    })

    await run.client.getOutboxDepth()

    expect(lines.filter((line) => line.level === 'warn')).toEqual([
      { level: 'warn', message: 'port.subscribe_failed', meta: { port: 'foreground', code: null, name: null } },
    ])
    expect(JSON.stringify(lines)).not.toContain(TOKEN_IN_MESSAGE)
  })
})

// MARK: - Bucket owner

describe('createKizunaSync bucket owner flag', () => {
  test('a byOwner table reaches the engine with bucket_owner true, a byColumn or unbucketed one without the key', async () => {
    const config = defineConfig({
      tables: {
        items: { sync: 'read-write', bucket: byOwner('user_id') },
        teams: { sync: 'read-write', bucket: byColumn('team_id') },
        notes: { sync: 'read-write' },
      },
    })
    const run = openHarness({ config })

    await run.client.getOutboxDepth()
    const { tables } = run.openedConfig()

    expect(tables.items!.bucket_owner).toBe(true)
    expect('bucket_owner' in tables.teams!).toBe(false)
    expect('bucket_owner' in tables.notes!).toBe(false)
  })
})
