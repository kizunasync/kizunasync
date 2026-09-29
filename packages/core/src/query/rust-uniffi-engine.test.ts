/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createRustUniffiEngine, EUniffiEngineEventTag, toCreateJson, type TUniffiEngineEvent, type TUniffiEventObserver, type TUniffiHandle } from './rust-uniffi-engine'
import { probeUniffiHandle } from './uniffi-probe'
import { alwaysOnline } from '../ports/connectivity'
import { defineConfig } from '../config/config'
import { createKizunaSync } from './kizunasync'
import type { IProtocolRemote } from '../ports/protocol-remote'
import { EConflictMode, EEngineErrorCode, EEngineEventType, ERejectReason, ESoftBlockReason, TEngineError, type TEngineEvent } from '../wire/types'
import { noopLogger, type ILogger } from '../util/logger'

const remote: IProtocolRemote = {
  pull: async () => ({ cursor: '0', has_more: false, rows: [], signal: null, tombstones: [] }),
  push: async () => ({ verdicts: [] }),
}

const SUBSCRIPTION_ID = 42n

/** The envelope a fresh engine answers `method` with. */
const envelopeFor = (method: string): string => {
  if (method === 'outbox_depth') {
    return JSON.stringify({ ok: true, value: 0 })
  }
  if (method === 'checkpoint') {
    return JSON.stringify({ ok: true, value: { cursor: '0', soft_blocked: false } })
  }
  return JSON.stringify({ ok: true, value: null })
}

/** The blocking `call` a fake exposes: the adapter must never reach it, because it would hold the JavaScript thread for the whole engine call. */
const refuseBlockingCall = (method: string): string => {
  throw new Error(`the adapter called the blocking call(${method})`)
}

type TObservableHandle = {
  handle: TUniffiHandle
  emit(event: TUniffiEngineEvent): void
  shutdowns: () => number
  unsubscribed: () => readonly bigint[]
}

/**
 * A handle that answers every call with an empty envelope and keeps the
 * observer the adapter registered, so a test can emit an engine event.
 */
const observableHandle = (): TObservableHandle => {
  let observer: TUniffiEventObserver | null = null
  let shutdowns = 0
  const unsubscribed: bigint[] = []
  const handle: TUniffiHandle = {
    create: () => undefined,
    call: refuseBlockingCall,
    callAsync: async (method) => envelopeFor(method),
    subscribe: (registered) => {
      observer = registered

      return SUBSCRIPTION_ID
    },
    unsubscribe: (subscriptionId) => {
      unsubscribed.push(subscriptionId)
    },
    shutdown: () => {
      shutdowns += 1
    },
  }

  return {
    handle,
    emit: (event) => {
      if (observer === null) {
        throw new Error('the adapter registered no observer')
      }
      observer.onEvent(event)
    },
    shutdowns: () => shutdowns,
    unsubscribed: () => unsubscribed,
  }
}

describe('uniffi probe', () => {
  test('is inert outside React Native', () => {
    expect(probeUniffiHandle()).toBeNull()
  })
})

describe('createRustUniffiEngine', () => {
  test('create JSON includes database_path and remote when provided', async () => {
    const payloads: string[] = []
    const handle: TUniffiHandle = {
      create(configJson) {
        payloads.push(configJson)
      },
      call: refuseBlockingCall,
      callAsync: async (method) => envelopeFor(method),
      subscribe: () => 1n,
      unsubscribe: () => undefined,
      shutdown: () => undefined,
    }
    const engine = createRustUniffiEngine({
      handle,
      databasePath: '/tmp/kizunasync.sqlite',
      remote,
      config: {
        tables: { todos: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } },
        schemaVersion: 1,
      },
      clientId: 'c1',
      now: () => 't0',
      uuid: () => 'id',
      logger: noopLogger,
      deps: {
        connectivity: alwaysOnline,
        nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      },
    })

    expect(payloads).toHaveLength(1)
    const created = JSON.parse(payloads[0]!) as {
      database_path: string
      remote: { url: string; publishable_key: string }
      attachment_root?: string
    }

    expect(created.database_path).toBe('/tmp/kizunasync.sqlite')
    expect(created.remote.url).toBe('https://example.supabase.co')
    expect(created.remote.publishable_key).toBe('pub')
    expect('attachment_root' in created).toBe(false)
    expect(created.attachment_root).toBeUndefined()
    const methods: string[] = []

    handle.callAsync = async (method, paramsJson) => {
      methods.push(method)

      if (method === 'set_access_token') {
        expect((JSON.parse(paramsJson) as { token: string }).token).toBe('next-jwt')
      }
      return JSON.stringify({ ok: true, value: null })
    }
    await engine.setRemoteAccessToken?.('next-jwt')
    expect(methods).toContain('set_access_token')
    engine.dispose?.()
  })
})

describe('the UniFFI engine calls', () => {
  test('every engine call awaits callAsync and none blocks on call', async () => {
    const blocking: string[] = []
    const awaited: string[] = []
    const handle: TUniffiHandle = {
      create: () => undefined,
      call: (method) => {
        blocking.push(method)

        return envelopeFor(method)
      },
      callAsync: async (method) => {
        awaited.push(method)

        return envelopeFor(method)
      },
      subscribe: () => 1n,
      unsubscribe: () => undefined,
      shutdown: () => undefined,
    }
    const engine = createRustUniffiEngine({
      handle,
      databasePath: '/tmp/kizunasync-uniffi-async.sqlite',
      remote,
      config: { tables: { todos: { bucketColumn: 'user_id', bucketParams: { user_id: 'u1' } } }, schemaVersion: 1 },
      clientId: 'c1',
      now: () => 't0',
      uuid: () => 'id',
      logger: noopLogger,
      deps: {
        connectivity: alwaysOnline,
        nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      },
    })

    await engine.setRemoteAccessToken?.('session-jwt')

    expect(awaited).toContain('set_access_token')
    expect(blocking).toEqual([])
    engine.dispose?.()
  })
})

describe('the UniFFI observer', () => {
  const config = defineConfig({ tables: { todos: { sync: 'read-write' } } })

  test('an emitted event reaches a kizunasync.on subscriber', () => {
    const fake = observableHandle()
    const seen: TEngineEvent[] = []
    const kizunasync = createKizunaSync({ databasePath: '/tmp/kizunasync-uniffi-observer.sqlite' }, remote, config, {
      uniffiHandle: fake.handle,
      nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      pollIntervalMs: 0,
      inspector: false,
    })
    const off = kizunasync.on((event) => {
      seen.push(event)
    })

    fake.emit({ tag: EUniffiEngineEventTag.LocalChanged })
    fake.emit({ tag: EUniffiEngineEventTag.QueueDepth, inner: { depth: 3 } })
    fake.emit({
      tag: EUniffiEngineEventTag.MutationRejected,
      inner: { mutationId: 'm1', reason: ERejectReason.RLS_DENIED },
    })
    fake.emit({
      tag: EUniffiEngineEventTag.ColumnOverwritten,
      inner: {
        table: 'todos',
        pk: 'p1',
        column: 'title',
        loserValueJson: '{"was":"mine"}',
        winnerMutationId: 'm2',
        conflictMode: EConflictMode.hlc,
      },
    })

    expect(seen).toEqual([
      { type: EEngineEventType.LOCAL_CHANGED },
      { type: EEngineEventType.QUEUE_DEPTH, depth: 3 },
      { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.RLS_DENIED },
      {
        type: EEngineEventType.COLUMN_OVERWRITTEN,
        table: 'todos',
        pk: 'p1',
        column: 'title',
        loserValue: { was: 'mine' },
        winnerMutationId: 'm2',
        conflictMode: EConflictMode.hlc,
      },
    ])

    off()
    fake.emit({ tag: EUniffiEngineEventTag.LocalChanged })
    expect(seen).toHaveLength(4)
    kizunasync.dispose()
  })

  test.each([ESoftBlockReason.resetRequired, ESoftBlockReason.identityChanged])(
    'a ResetRequired naming %s hands the reason to kizunasync.on and to sync health',
    (reason) => {
      const fake = observableHandle()
      const seen: TEngineEvent[] = []
      const kizunasync = createKizunaSync({ databasePath: '/tmp/kizunasync-uniffi-reset-reason.sqlite' }, remote, config, {
        uniffiHandle: fake.handle,
        nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
        pollIntervalMs: 0,
        inspector: false,
      })

      kizunasync.on((event) => {
        seen.push(event)
      })
      fake.emit({ tag: EUniffiEngineEventTag.ResetRequired, inner: { reason } })

      expect(seen).toEqual([{ type: EEngineEventType.RESET_REQUIRED, reason }])
      expect(kizunasync.getSyncHealth().softBlockReason).toBe(reason)
      kizunasync.dispose()
    },
  )

  test('a ResetRequired naming no reason carries none and records none', () => {
    const fake = observableHandle()
    const seen: TEngineEvent[] = []
    const kizunasync = createKizunaSync({ databasePath: '/tmp/kizunasync-uniffi-reset-no-reason.sqlite' }, remote, config, {
      uniffiHandle: fake.handle,
      nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      pollIntervalMs: 0,
      inspector: false,
    })

    kizunasync.on((event) => {
      seen.push(event)
    })
    fake.emit({ tag: EUniffiEngineEventTag.ResetRequired, inner: {} })

    expect(seen).toEqual([{ type: EEngineEventType.RESET_REQUIRED }])
    expect('reason' in seen[0]!).toBe(false)
    expect(kizunasync.getSyncHealth().softBlockReason).toBeNull()
    kizunasync.dispose()
  })

  test('dispose unsubscribes and shuts the engine down', async () => {
    const fake = observableHandle()
    const engine = createRustUniffiEngine({
      handle: fake.handle,
      databasePath: '/tmp/kizunasync-uniffi-shutdown.sqlite',
      remote,
      config: { tables: { todos: { bucketColumn: 'user_id' } }, schemaVersion: 1 },
      clientId: 'c1',
      now: () => 't0',
      uuid: () => 'id',
      logger: noopLogger,
      deps: {
        connectivity: alwaysOnline,
        nativeHttpRemote: { url: 'https://example.supabase.co', publishableKey: 'pub' },
      },
    })

    // The checkpoint read the engine makes as it opens settles first, so the release is not waiting on it.
    await Bun.sleep(1)
    expect(fake.shutdowns()).toBe(0)
    engine.dispose?.()
    expect(fake.unsubscribed()).toEqual([SUBSCRIPTION_ID])
    expect(fake.shutdowns()).toBe(1)

    engine.dispose?.()
    expect(fake.shutdowns()).toBe(1)
  })
})

describe('the UniFFI JSON boundaries', () => {
  const HTTP = { url: 'https://example.supabase.co', publishableKey: 'pub' }

  const recordingLogger = (debugged: string[]): ILogger => {
    const logger: ILogger = {
      debug: (message) => debugged.push(message),
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
    }

    return logger
  }

  const overwritten = (loserValueJson: string): TUniffiEngineEvent => ({
    tag: EUniffiEngineEventTag.ColumnOverwritten,
    inner: { table: 'todos', pk: 'p1', column: 'title', loserValueJson, winnerMutationId: 'm2', conflictMode: EConflictMode.hlc },
  })

  test('a loser value is any JSON value, and an event whose value is not JSON is logged and dropped', () => {
    const fake = observableHandle()
    const debugged: string[] = []
    const engine = createRustUniffiEngine({
      handle: fake.handle,
      databasePath: '/tmp/kizunasync-uniffi-loser-value.sqlite',
      remote,
      config: { tables: { todos: { bucketColumn: 'user_id' } }, schemaVersion: 1 },
      clientId: 'c1',
      now: () => 't0',
      uuid: () => 'id',
      logger: recordingLogger(debugged),
      deps: { connectivity: alwaysOnline, nativeHttpRemote: HTTP },
    })
    const loserValues: unknown[] = []
    const off = engine.subscribe((event) => {
      if (event.type === EEngineEventType.COLUMN_OVERWRITTEN) {
        loserValues.push(event.loserValue)
      }
    })

    for (const loserValueJson of ['null', '{}', '{"ok":false}', 'not json', '"mine"']) {
      fake.emit(overwritten(loserValueJson))
    }

    expect(loserValues).toEqual([null, {}, { ok: false }, 'mine'])
    expect(debugged).toEqual(['dropped an unreadable engine event'])
    off()
    engine.dispose?.()
  })

  test.each(['null', '[]', 'not json'])('a create config of %p is the JSON engine error', (configJson) => {
    let caught: unknown = null

    try {
      toCreateJson({ configJson, databasePath: null, http: HTTP })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TEngineError)
    expect((caught as TEngineError).code).toBe(EEngineErrorCode.JSON)
  })

  test.each([
    ['{}', {}],
    ['{"ok":false}', { ok: false }],
    ['{"client_id":"c1","tables":{}}', { client_id: 'c1', tables: {} }],
  ])('a create config of %p keeps its fields beside the database path and the remote', (configJson, fields) => {
    expect(JSON.parse(toCreateJson({ configJson, databasePath: '/tmp/k.sqlite', http: HTTP }))).toEqual({
      ...fields,
      database_path: '/tmp/k.sqlite',
      remote: { url: HTTP.url, publishable_key: HTTP.publishableKey },
    })
  })
})
