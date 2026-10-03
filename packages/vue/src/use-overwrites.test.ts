/// <reference types="bun" />
/**
 * Mirrors use-rejections.test.ts: the composable runs inside an effectScope so
 * onScopeDispose fires deterministically (no component instance), and a fake
 * IKizunaSync exercises client.on-driven recompute without a real engine.
 */
// MARK: - useOverwrites

import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import { EConflictMode, EEngineEventType, ERejectReason, type IKizunaSync, type TEngineEvent, type TOverwriteRecord } from '@kizunasync/core'
import { useOverwrites } from './use-overwrites'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const makeRecord = (id: number, dismissed = false): TOverwriteRecord => ({
  id,
  table: 'todos',
  pk: 'p1',
  column: 'title',
  loserValue: 'mine',
  winnerMutationId: 'm-peer',
  conflictMode: EConflictMode.arrival,
  winnerSeq: null,
  at: 0,
  dismissed,
})

const overwriteEvent = (): TEngineEvent => ({
  type: EEngineEventType.COLUMN_OVERWRITTEN,
  table: 'todos',
  pk: 'p1',
  column: 'title',
  loserValue: 'mine',
  winnerMutationId: 'm-peer',
  conflictMode: EConflictMode.arrival,
})

const makeFakeKizunaSync = (
  initial: TOverwriteRecord[],
): {
  client: IKizunaSync
  emit: (event: TEngineEvent) => void
  setRecords: (next: TOverwriteRecord[]) => void
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
    overwrites: (options?: { includeDismissed?: boolean }) =>
      readFailure !== null
        ? Promise.reject(readFailure)
        : Promise.resolve(
            records.filter((r) => options?.includeDismissed === true || !r.dismissed),
          ),
    dismissOverwrite: (id: number) => {
      if (dismissFailure !== null) {
        return Promise.reject(dismissFailure)
      }
      records = records.map((r) => (r.id === id ? { ...r, dismissed: true } : r))

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

describe('useOverwrites', () => {
  test('loads the journal on mount', async () => {
    const { client } = makeFakeKizunaSync([makeRecord(1)])
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    expect(result.isLoading.value).toBe(true)
    await flush()
    expect(result.isLoading.value).toBe(false)
    expect(result.overwrites.value.map((o) => o.id)).toEqual([1])
    scope.stop()
  })

  test('re-reads when a COLUMN_OVERWRITTEN event fires', async () => {
    const { client, emit, setRecords } = makeFakeKizunaSync([])
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    await flush()
    expect(result.overwrites.value).toEqual([])

    setRecords([makeRecord(2)])
    emit(overwriteEvent())
    await flush()
    expect(result.overwrites.value.map((o) => o.id)).toEqual([2])
    scope.stop()
  })

  test('a rejection event does not re-read the overwrite journal', async () => {
    const { client, emit, setRecords } = makeFakeKizunaSync([])
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    await flush()

    setRecords([makeRecord(3)])
    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm3', reason: ERejectReason.RLS_DENIED })
    await flush()
    expect(result.overwrites.value).toEqual([])
    scope.stop()
  })

  test('dismiss hides the entry (round trip through dismissOverwrite + re-read)', async () => {
    const { client } = makeFakeKizunaSync([makeRecord(4)])
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    await flush()
    expect(result.overwrites.value.map((o) => o.id)).toEqual([4])

    await result.dismiss(4)
    expect(result.overwrites.value).toEqual([])
    scope.stop()
  })

  test('includeDismissed surfaces already-dismissed entries', async () => {
    const { client } = makeFakeKizunaSync([makeRecord(5, true)])
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client, includeDismissed: true })
    })
    await flush()
    expect(result.overwrites.value.map((o) => o.id)).toEqual([5])
    scope.stop()
  })

  test('a failed read surfaces the error instead of an empty journal', async () => {
    const { client, failReadsWith } = makeFakeKizunaSync([makeRecord(6)])

    failReadsWith(new Error('local store is closed'))
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    await flush()
    expect(result.error.value?.message).toBe('local store is closed')
    expect(result.overwrites.value).toEqual([])
    scope.stop()
  })

  test('dismiss rejects when dismissOverwrite itself fails', async () => {
    const { client, failDismissWith } = makeFakeKizunaSync([makeRecord(7)])

    failDismissWith(new Error('journal write failed'))
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    await flush()
    await expect(result.dismiss(7)).rejects.toThrow('journal write failed')
    scope.stop()
  })

  test('stopping the scope unsubscribes from the engine', async () => {
    const { client, emit, setRecords } = makeFakeKizunaSync([])
    const scope = effectScope()
    let result!: ReturnType<typeof useOverwrites>

    scope.run(() => {
      result = useOverwrites({ client })
    })
    await flush()
    scope.stop()

    setRecords([makeRecord(8)])
    emit(overwriteEvent())
    await flush()
    expect(result.overwrites.value).toEqual([])
  })
})
