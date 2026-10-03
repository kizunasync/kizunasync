/// <reference types="bun" />
/**
 * A fake IKizunaSync exercises the override-wins resolver and the kizunasync.on-driven
 * recompute without a real engine. Local reads are async (the driver may run off
 * the main thread), so the fake's select() is a thenable and getOutboxDepth /
 * getCheckpoint are async; the composables read them on a microtask, so the
 * tests flush() before asserting the resolved state. Composables run inside an
 * effectScope so onScopeDispose fires deterministically (no component instance).
 */
// MARK: - Smoke + exports test

import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import { alwaysOnline, EEngineEventType, ERejectReason, ESyncPhase, MISSING_CLIENT_MESSAGE } from '@kizunasync/core'
import type { IAttachmentClient, IConnectivity, IKizunaSync, ILocalFromBuilder, ILocalSelectBuilder, ISyncHealth, TCheckpointState, TColumnValues, TEngineEvent } from '@kizunasync/core'
import { createKizunaSyncPlugin, kizunasyncInjectionKey, provideKizunaSync, useAttachment, useKizunaSync, useMutation, useQuery, useSyncStatus } from './index'

// MARK: - Microtask flush

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// MARK: - Fake client

/** This fake has no attachment queue: nothing here reaches one. */
const NO_ATTACHMENTS: IAttachmentClient = {
  fromFile: () => Promise.reject(new Error('the fake has no attachment queue')),
  resolveDownload: () => Promise.reject(new Error('the fake has no attachment queue')),
  vacuum: () => Promise.reject(new Error('the fake has no attachment queue')),
  getStatus: () => Promise.reject(new Error('the fake has no attachment queue')),
  watch: () => () => undefined,
  retry: () => Promise.reject(new Error('the fake has no attachment queue')),
  cancel: () => Promise.reject(new Error('the fake has no attachment queue')),
  remove: () => Promise.reject(new Error('the fake has no attachment queue')),
}

/** This fake has no loop of its own, so its sync health never leaves idle. */
const IDLE_HEALTH: ISyncHealth = {
  phase: ESyncPhase.idle,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  attemptStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
}

const makeFakeKizunaSync = (initialRows: TColumnValues[]): {
  client: IKizunaSync
  emit: (event: TEngineEvent) => void
  setRows: (rows: TColumnValues[]) => void
  reads: () => number
  failNextRead: () => void
} => {
  let rows = initialRows
  let depth = 0
  let reads = 0
  let failNext = false
  const handlers = new Set<(event: TEngineEvent) => void>()
  const checkpoint: TCheckpointState = { cursor: '0', schemaVersion: 1, softBlocked: false }

  const selectBuilder = (): ILocalSelectBuilder => {
    const builder = {
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (onfulfilled: unknown, onrejected: unknown) => {
        reads += 1

        if (failNext) {
          failNext = false

          return Promise.reject(new Error('read failed')).then(onfulfilled as never, onrejected as never)
        }
        return Promise.resolve({ data: rows, error: null }).then(onfulfilled as never)
      },
    } as unknown as ILocalSelectBuilder

    return builder
  }

  const fromBuilder = (): ILocalFromBuilder =>
    ({ select: selectBuilder } as unknown as ILocalFromBuilder)

  const refused = (): never => {
    throw new Error('the fake client runs no server call')
  }

  const client: IKizunaSync = {
    engine: 'rust',
    from: () => fromBuilder(),
    rpc: refused,
    schema: refused,
    getOpenApiSpec: refused,
    on: (handler) => {
      handlers.add(handler)

      return () => handlers.delete(handler)
    },
    setBucket: () => {},
    sync: async () => {
      depth = 0
    },
    pullOnce: async () => {},
    pushOnce: async () => {},
    rejections: async () => [],
    dismissRejection: async () => {},
    overwrites: async () => [],
    dismissOverwrite: async () => {},
    getCheckpoint: async () => checkpoint,
    getOutboxDepth: async () => depth,
    getSyncHealth: () => IDLE_HEALTH,
    onSyncHealth: () => () => undefined,
    reset: async () => {},
    seedCheckpoint: async () => {},
    dispose: () => {},
    setRemoteAccessToken: async () => {},
    attachments: NO_ATTACHMENTS,
    connectivity: alwaysOnline,
  }

  return {
    client,
    emit: (event) => handlers.forEach((handler) => handler(event)),
    setRows: (next) => {
      rows = next
      depth = next.length
    },
    reads: () => reads,
    failNextRead: () => {
      failNext = true
    },
  }
}

describe('@kizunasync/vue exports', () => {
  test('surface is present', () => {
    expect(typeof provideKizunaSync).toBe('function')
    expect(typeof useKizunaSync).toBe('function')
    expect(typeof useQuery).toBe('function')
    expect(typeof useMutation).toBe('function')
    expect(typeof useSyncStatus).toBe('function')
    expect(typeof useAttachment).toBe('function')
    expect(typeof createKizunaSyncPlugin).toBe('function')
    expect(typeof kizunasyncInjectionKey).toBe('symbol')
  })
})

describe('useKizunaSync resolution (hybrid)', () => {
  test('explicit { client } override wins without a provider', () => {
    const { client } = makeFakeKizunaSync([])
    const scope = effectScope()

    scope.run(() => {
      expect(useKizunaSync({ client })).toBe(client)
    })
    scope.stop()
  })

  test('throws the message @kizunasync/core owns when neither override nor provider is present', () => {
    const scope = effectScope()

    scope.run(() => {
      expect(() => useKizunaSync()).toThrow(new Error(MISSING_CLIENT_MESSAGE))
    })
    scope.stop()
  })

  test('createKizunaSyncPlugin install provides via app.provide', () => {
    const { client } = makeFakeKizunaSync([])
    let provided: unknown

    createKizunaSyncPlugin(client).install({
      provide: (_key: unknown, value: unknown) => {
        provided = value
      },
    } as never)
    expect(provided).toBe(client)
  })
})

describe('useQuery reactivity (async)', () => {
  test('starts loading, resolves data, then recomputes on a row-changing engine event', async () => {
    const { client, emit, setRows } = makeFakeKizunaSync([{ id: 'a' }])
    const scope = effectScope()
    let result!: ReturnType<typeof useQuery>

    scope.run(() => {
      result = useQuery((kizunasync) => kizunasync.from('todos').select(), { client })
    })

    // First render: loading, empty; the read has not resolved yet.
    expect(result.isLoading.value).toBe(true)
    expect(result.data.value).toEqual([])

    await flush()
    expect(result.isLoading.value).toBe(false)
    expect(result.data.value).toEqual([{ id: 'a' }])
    expect(result.error.value).toBeNull()

    setRows([{ id: 'a' }, { id: 'b' }])
    emit({ type: EEngineEventType.LOCAL_CHANGED })
    await flush()
    expect(result.data.value).toEqual([{ id: 'a' }, { id: 'b' }])

    scope.stop()
    setRows([{ id: 'a' }])
    emit({ type: EEngineEventType.LOCAL_CHANGED })
    await flush()
    // Disposed scope unsubscribed: no recompute after teardown.
    expect(result.data.value).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  test('captures a thrown build/read into error', async () => {
    const { client } = makeFakeKizunaSync([])
    const scope = effectScope()
    let result!: ReturnType<typeof useQuery>

    scope.run(() => {
      result = useQuery((): ILocalSelectBuilder => {
        throw new Error('boom')
      }, { client })
    })
    // A build that throws before it names a shape reads as a list.
    expect(result.data.value).toEqual([])
    await flush()
    expect(result.error.value?.message).toBe('boom')
    expect(result.isLoading.value).toBe(false)
    scope.stop()
  })

  test('a same-tick burst of row-changing events causes one re-read', async () => {
    const { client, emit, reads } = makeFakeKizunaSync([{ id: 'a' }])
    const scope = effectScope()

    scope.run(() => {
      useQuery((kizunasync) => kizunasync.from('todos').select(), { client })
    })
    await flush()
    const readsAfterMount = reads()

    emit({ type: EEngineEventType.LOCAL_CHANGED })
    emit({ type: EEngineEventType.LOCAL_CHANGED })
    emit({ type: EEngineEventType.RESET_REQUIRED })
    await flush()
    expect(reads()).toBe(readsAfterMount + 1)
    scope.stop()
  })

  test('an event that cannot change rows causes no re-read', async () => {
    const { client, emit, reads } = makeFakeKizunaSync([{ id: 'a' }])
    const scope = effectScope()

    scope.run(() => {
      useQuery((kizunasync) => kizunasync.from('todos').select(), { client })
    })
    await flush()
    const readsAfterMount = reads()

    emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await flush()
    expect(reads()).toBe(readsAfterMount)
    scope.stop()
  })

  test('a failing re-read keeps the previous data and reports the error', async () => {
    const { client, emit, failNextRead } = makeFakeKizunaSync([{ id: 'a' }])
    const scope = effectScope()
    let result!: ReturnType<typeof useQuery>

    scope.run(() => {
      result = useQuery((kizunasync) => kizunasync.from('todos').select(), { client })
    })
    await flush()
    expect(result.data.value).toEqual([{ id: 'a' }])

    failNextRead()
    emit({ type: EEngineEventType.LOCAL_CHANGED })
    await flush()
    expect(result.data.value).toEqual([{ id: 'a' }])
    expect(result.error.value?.message).toBe('read failed')
    scope.stop()
  })
})

describe('useSyncStatus', () => {
  test('tracks outbox depth, sync, and rejection errors', async () => {
    const { client, emit, setRows } = makeFakeKizunaSync([])
    const scope = effectScope()
    let status!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      status = useSyncStatus({ client })
    })
    // Defaults until the first read resolves.
    expect(status.outboxDepth.value).toBe(0)
    expect(status.isSyncing.value).toBe(false)

    setRows([{ id: 'a' }])
    emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await flush()
    expect(status.outboxDepth.value).toBe(1)

    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.RLS_DENIED })
    expect(status.lastError.value?.message).toBe('Write rejected: You do not have permission to write this row.')

    await status.syncNow()
    expect(status.outboxDepth.value).toBe(0)
    expect(status.lastError.value).toBeNull()
    scope.stop()
  })

  test('isOnline follows the app client connectivity when no connectivity is given', async () => {
    const offline: IConnectivity = { isOnline: () => false, subscribe: () => () => undefined }
    const client: IKizunaSync = { ...makeFakeKizunaSync([]).client, connectivity: offline }
    const scope = effectScope()
    let status!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      status = useSyncStatus({ client })
    })
    expect(status.isOnline.value).toBe(false)
    scope.stop()
  })

  test('isOnline reflects the connectivity signal and its transitions', async () => {
    const { client } = makeFakeKizunaSync([])
    let online = false
    const listeners: Array<(online: boolean) => void> = []
    const connectivity: IConnectivity = {
      isOnline: () => online,
      subscribe: (onChange) => {
        listeners.push(onChange)

        return () => {
          const index = listeners.indexOf(onChange)

          if (index >= 0) {
            listeners.splice(index, 1)
          }
        }
      },
    }
    const scope = effectScope()
    let status!: ReturnType<typeof useSyncStatus>

    scope.run(() => {
      status = useSyncStatus({ client, connectivity })
    })
    expect(status.isOnline.value).toBe(false)

    online = true
    listeners.forEach((notify) => notify(true))
    expect(status.isOnline.value).toBe(true)
    scope.stop()
  })
})

describe('useMutation', () => {
  test('sets isPending around the write and clears it on success', async () => {
    const { client, setRows } = makeFakeKizunaSync([])
    const scope = effectScope()
    let mutation!: ReturnType<typeof useMutation>

    scope.run(() => {
      mutation = useMutation({ client })
    })

    expect(mutation.isPending.value).toBe(false)
    expect(mutation.error.value).toBeNull()

    const write = mutation.mutate(async (kizunasync) => {
      expect(mutation.isPending.value).toBe(true)
      setRows([{ id: 'a' }])
      await kizunasync.sync()
    })

    // isPending is true synchronously before the write resolves.
    expect(mutation.isPending.value).toBe(true)
    await write
    expect(mutation.isPending.value).toBe(false)
    expect(mutation.error.value).toBeNull()
    scope.stop()
  })

  test('captures a thrown write into error and clears isPending', async () => {
    const { client } = makeFakeKizunaSync([])
    const scope = effectScope()
    let mutation!: ReturnType<typeof useMutation>

    scope.run(() => {
      mutation = useMutation({ client })
    })

    await mutation.mutate(async () => {
      throw new Error('write failed')
    })
    expect(mutation.isPending.value).toBe(false)
    expect(mutation.error.value?.message).toBe('write failed')
    scope.stop()
  })

  test('clears a previous error on a new mutate call', async () => {
    const { client } = makeFakeKizunaSync([])
    const scope = effectScope()
    let mutation!: ReturnType<typeof useMutation>

    scope.run(() => {
      mutation = useMutation({ client })
    })

    await mutation.mutate(async () => {
      throw new Error('first error')
    })
    expect(mutation.error.value?.message).toBe('first error')

    await mutation.mutate(async () => {})
    expect(mutation.error.value).toBeNull()
    scope.stop()
  })
})
