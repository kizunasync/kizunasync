/// <reference types="bun" />
/**
 * Mirrors index.test.ts's makeFakeKizunaSync + effectScope pattern: composables run
 * inside an effectScope so onScopeDispose fires deterministically (no component
 * instance), and a fake IKizunaSync exercises client.on-driven recompute without a
 * real engine.
 */
// MARK: - useRejections

import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import { EEngineEventType, ERejectReason, ERejectionKind, type IKizunaSync, type TEngineEvent, type TRejectionRecord } from '@kizunasync/core'
import { useRejections } from './use-rejections'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const makeRecord = (mutationId: string, dismissed = false): TRejectionRecord => ({
  mutationId,
  table: 'todos',
  pk: 'p1',
  kind: ERejectionKind.REJECTED,
  reason: ERejectReason.RLS_DENIED,
  changedColumns: ['title'],
  serverRow: null,
  at: 0,
  dismissed,
})

const makeFakeKizunaSync = (initial: TRejectionRecord[]): {
  client: IKizunaSync
  emit: (event: TEngineEvent) => void
  setRecords: (next: TRejectionRecord[]) => void
  failReadsWith: (failure: Error | null) => void
  failDismissWith: (failure: Error | null) => void
} => {
  let records = initial
  let readFailure: Error | null = null
  let dismissFailure: Error | null = null
  const handlers = new Set<(event: TEngineEvent) => void>()
  const client = {
    on: (handler: (event: TEngineEvent) => void) => {
      handlers.add(handler)

      return () => handlers.delete(handler)
    },
    rejections: (options?: { includeDismissed?: boolean }) =>
      readFailure !== null
        ? Promise.reject(readFailure)
        : Promise.resolve(records.filter((r) => options?.includeDismissed === true || !r.dismissed)),
    dismissRejection: (mutationId: string) => {
      if (dismissFailure !== null) {
        return Promise.reject(dismissFailure)
      }
      records = records.map((r) => (r.mutationId === mutationId ? { ...r, dismissed: true } : r))

      return Promise.resolve()
    },
  } as unknown as IKizunaSync

  return {
    client,
    emit: (event) => handlers.forEach((handler) => handler(event)),
    setRecords: (next) => { records = next },
    failReadsWith: (failure) => { readFailure = failure },
    failDismissWith: (failure) => { dismissFailure = failure },
  }
}

describe('useRejections', () => {
  test('loads the journal on mount', async () => {
    const { client } = makeFakeKizunaSync([makeRecord('m1')])
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    expect(result.isLoading.value).toBe(true)
    await flush()
    expect(result.isLoading.value).toBe(false)
    expect(result.rejections.value.map((r) => r.mutationId)).toEqual(['m1'])
    scope.stop()
  })

  test('re-reads when a MUTATION_REJECTED event fires', async () => {
    const { client, emit, setRecords } = makeFakeKizunaSync([])
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    await flush()
    expect(result.rejections.value).toEqual([])

    setRecords([makeRecord('m2')])
    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm2', reason: ERejectReason.RLS_DENIED })
    await flush()
    expect(result.rejections.value.map((r) => r.mutationId)).toEqual(['m2'])
    scope.stop()
  })

  test('dismiss hides the entry (round trip through dismissRejection + re-read)', async () => {
    const { client } = makeFakeKizunaSync([makeRecord('m3')])
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    await flush()
    expect(result.rejections.value.map((r) => r.mutationId)).toEqual(['m3'])

    await result.dismiss('m3')
    expect(result.rejections.value).toEqual([])
    scope.stop()
  })

  test('includeDismissed surfaces already-dismissed entries', async () => {
    const { client } = makeFakeKizunaSync([makeRecord('m4', true)])
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client, includeDismissed: true })
    })
    await flush()
    expect(result.rejections.value.map((r) => r.mutationId)).toEqual(['m4'])
    scope.stop()
  })

  test('a failed read surfaces the error instead of an empty journal', async () => {
    const { client, failReadsWith } = makeFakeKizunaSync([makeRecord('m5')])

    failReadsWith(new Error('local store is closed'))
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    await flush()
    expect(result.error.value?.message).toBe('local store is closed')
    expect(result.isLoading.value).toBe(false)
    expect(result.rejections.value).toEqual([])
    scope.stop()
  })

  test('a read that recovers clears the error', async () => {
    const { client, emit, failReadsWith } = makeFakeKizunaSync([makeRecord('m6')])

    failReadsWith(new Error('local store is closed'))
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    await flush()
    expect(result.error.value).not.toBeNull()

    failReadsWith(null)
    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm6', reason: ERejectReason.RLS_DENIED })
    await flush()
    expect(result.error.value).toBeNull()
    expect(result.rejections.value.map((r) => r.mutationId)).toEqual(['m6'])
    scope.stop()
  })

  test('dismiss rejects when dismissRejection itself fails', async () => {
    const { client, failDismissWith } = makeFakeKizunaSync([makeRecord('m7')])

    failDismissWith(new Error('journal write failed'))
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    await flush()
    expect(result.dismiss('m7')).rejects.toThrow('journal write failed')
    scope.stop()
  })

  test('a dismiss whose refresh fails still resolves, and reports the failure', async () => {
    const { client, failReadsWith } = makeFakeKizunaSync([makeRecord('m8')])
    const scope = effectScope()
    let result!: ReturnType<typeof useRejections>

    scope.run(() => {
      result = useRejections({ client })
    })
    await flush()

    failReadsWith(new Error('local store is closed'))
    await result.dismiss('m8')
    expect(result.error.value?.message).toBe('local store is closed')
    scope.stop()
  })
})
