// MARK: - useOverwrites

/**
 * Mirrors use-rejections.test.tsx: a fake IKizunaSync plus a Probe component that
 * reassigns a captured `latest` reference on every render, so the test asserts
 * on the hook's return value directly.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { EConflictMode, EEngineEventType, ERejectReason, type IKizunaSync, type TEngineEvent, type TOverwriteRecord } from '@kizunasync/core'
import { useOverwrites, type IOverwritesResult } from './use-overwrites'

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

const makeClient = (
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
    setRecords: (next) => {
      records = next
    },
    failReadsWith: (failure) => {
      readFailure = failure
    },
    failDismissWith: (failure) => {
      dismissFailure = failure
    },
  }
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })

let latest: IOverwritesResult | undefined

function Probe({
  client,
  includeDismissed,
}: {
  client: IKizunaSync
  includeDismissed?: boolean
}): React.ReactElement {
  latest = useOverwrites({ client, includeDismissed })

  return React.createElement('div', null, String(latest.overwrites.length))
}

describe('useOverwrites', () => {
  test('loads the journal on mount', async () => {
    const { client } = makeClient([makeRecord(1)])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.isLoading).toBe(false)
    expect(latest?.overwrites.map((o) => o.id)).toEqual([1])
  })

  test('re-reads when a COLUMN_OVERWRITTEN event fires', async () => {
    const { client, emit, setRecords } = makeClient([])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.overwrites).toEqual([])

    setRecords([makeRecord(2)])
    emit(overwriteEvent())
    await flush()
    expect(latest?.overwrites.map((o) => o.id)).toEqual([2])
  })

  test('a rejection event does not re-read the overwrite journal', async () => {
    const { client, emit, setRecords } = makeClient([])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })

    setRecords([makeRecord(3)])
    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm3', reason: ERejectReason.RLS_DENIED })
    await flush()
    expect(latest?.overwrites).toEqual([])
  })

  test('dismiss hides the entry (round trip through dismissOverwrite + re-read)', async () => {
    const { client } = makeClient([makeRecord(4)])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.overwrites.map((o) => o.id)).toEqual([4])

    await act(async () => {
      await latest?.dismiss(4)
    })
    expect(latest?.overwrites).toEqual([])
  })

  test('includeDismissed surfaces already-dismissed entries', async () => {
    const { client } = makeClient([makeRecord(5, true)])

    await act(async () => {
      render(React.createElement(Probe, { client, includeDismissed: true }))
    })
    expect(latest?.overwrites.map((o) => o.id)).toEqual([5])
  })

  test('a failed read surfaces the error instead of an empty journal', async () => {
    const { client, failReadsWith } = makeClient([makeRecord(6)])

    failReadsWith(new Error('local store is closed'))
    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.error?.message).toBe('local store is closed')
    expect(latest?.isLoading).toBe(false)
    expect(latest?.overwrites).toEqual([])
  })

  test('dismiss rejects when dismissOverwrite itself fails', async () => {
    const { client, failDismissWith } = makeClient([makeRecord(7)])

    failDismissWith(new Error('journal write failed'))
    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    await expect(latest!.dismiss(7)).rejects.toThrow('journal write failed')
  })
})
