// MARK: - useRejections

/**
 * Mirrors use-query-loop.test.tsx / use-attachment-stale.test.tsx: a fake IKizunaSync
 * (no renderer dependency beyond what @testing-library/react already provides),
 * with a Probe component that reassigns a captured `latest` reference on every
 * render so the test can assert on the hook's return value directly.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { EEngineEventType, ERejectReason, ERejectionKind, type IKizunaSync, type TEngineEvent, type TRejectionRecord } from '@kizunasync/core'
import { useRejections, type IRejectionsResult } from './use-rejections'

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

const makeClient = (initial: TRejectionRecord[]): {
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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

let latest: IRejectionsResult | undefined

function Probe({ client, includeDismissed }: { client: IKizunaSync; includeDismissed?: boolean }): React.ReactElement {
  latest = useRejections({ client, includeDismissed })

  return React.createElement('div', null, String(latest.rejections.length))
}

describe('useRejections', () => {
  test('loads the journal on mount', async () => {
    const { client } = makeClient([makeRecord('m1')])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.isLoading).toBe(false)
    expect(latest?.rejections.map((r) => r.mutationId)).toEqual(['m1'])
  })

  test('re-reads when a MUTATION_REJECTED event fires', async () => {
    const { client, emit, setRecords } = makeClient([])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.rejections).toEqual([])

    setRecords([makeRecord('m2')])
    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm2', reason: ERejectReason.RLS_DENIED })
    await flush()
    expect(latest?.rejections.map((r) => r.mutationId)).toEqual(['m2'])
  })

  test('dismiss hides the entry (round trip through dismissRejection + re-read)', async () => {
    const { client } = makeClient([makeRecord('m3')])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.rejections.map((r) => r.mutationId)).toEqual(['m3'])

    await act(async () => {
      await latest?.dismiss('m3')
    })
    expect(latest?.rejections).toEqual([])
  })

  test('includeDismissed surfaces already-dismissed entries', async () => {
    const { client } = makeClient([makeRecord('m4', true)])

    await act(async () => {
      render(React.createElement(Probe, { client, includeDismissed: true }))
    })
    expect(latest?.rejections.map((r) => r.mutationId)).toEqual(['m4'])
  })

  test('a failed read surfaces the error instead of an empty journal', async () => {
    const { client, failReadsWith } = makeClient([makeRecord('m5')])

    failReadsWith(new Error('local store is closed'))
    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.error?.message).toBe('local store is closed')
    expect(latest?.isLoading).toBe(false)
    expect(latest?.rejections).toEqual([])
  })

  test('a read that recovers clears the error', async () => {
    const { client, emit, failReadsWith } = makeClient([makeRecord('m6')])

    failReadsWith(new Error('local store is closed'))
    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    expect(latest?.error).not.toBeNull()

    failReadsWith(null)
    emit({ type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm6', reason: ERejectReason.RLS_DENIED })
    await flush()
    expect(latest?.error).toBeNull()
    expect(latest?.rejections.map((r) => r.mutationId)).toEqual(['m6'])
  })

  test('dismiss rejects when dismissRejection itself fails', async () => {
    const { client, failDismissWith } = makeClient([makeRecord('m7')])

    failDismissWith(new Error('journal write failed'))
    await act(async () => {
      render(React.createElement(Probe, { client }))
    })
    await expect(latest!.dismiss('m7')).rejects.toThrow('journal write failed')
  })

  test('a dismiss whose refresh fails still resolves, and reports the failure', async () => {
    const { client, failReadsWith } = makeClient([makeRecord('m8')])

    await act(async () => {
      render(React.createElement(Probe, { client }))
    })

    failReadsWith(new Error('local store is closed'))
    await act(async () => {
      await latest?.dismiss('m8')
    })
    expect(latest?.error?.message).toBe('local store is closed')
  })
})
