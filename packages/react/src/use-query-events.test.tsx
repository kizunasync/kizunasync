// MARK: - useQuery re-reads only on row-changing engine events

/**
 * useQuery filters kizunasync.on to the events that can change what a row
 * read would return (LOCAL_CHANGED, RESET_REQUIRED, CHECKPOINT_EXPIRED),
 * coalesces a same-tick burst of them into one read, and keeps the last
 * resolved data when a re-read fails instead of clearing it to [].
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { EEngineEventType, type IKizunaSync, type TEngineEvent } from '@kizunasync/core'
import { useQuery } from './use-query'

interface IFakeClient {
  client: IKizunaSync
  emit: (event: TEngineEvent) => void
  reads: () => number
  failNextRead: () => void
}

const fakeClient = (rows: { id: string }[]): IFakeClient => {
  const handlers = new Set<(event: TEngineEvent) => void>()
  let reads = 0
  let failNext = false

  const client = {
    on: (handler: (event: TEngineEvent) => void) => {
      handlers.add(handler)

      return () => handlers.delete(handler)
    },
    from: () => ({
      select: () => {
        reads += 1

        if (failNext) {
          failNext = false

          return Promise.reject(new Error('read failed'))
        }
        return Promise.resolve({ data: rows, error: null })
      },
    }),
  } as unknown as IKizunaSync

  return {
    client,
    emit: (event) => handlers.forEach((handler) => handler(event)),
    reads: () => reads,
    failNextRead: () => {
      failNext = true
    },
  }
}

const flush = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

function Probe({ client }: { client: IKizunaSync }): React.ReactElement {
  const result = useQuery((k) => k.from('items').select(), { client })

  return React.createElement(
    'div',
    { 'data-testid': 'state' },
    JSON.stringify({ data: result.data, error: result.error?.message ?? null }),
  )
}

describe('useQuery row-change event filter', () => {
  test('a same-tick burst of row-changing events causes one re-read', async () => {
    const fake = fakeClient([{ id: 'a' }])
    const view = render(React.createElement(Probe, { client: fake.client }))

    await flush()
    const readsAfterMount = fake.reads()

    await act(async () => {
      fake.emit({ type: EEngineEventType.LOCAL_CHANGED })
      fake.emit({ type: EEngineEventType.LOCAL_CHANGED })
      fake.emit({ type: EEngineEventType.RESET_REQUIRED })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(fake.reads()).toBe(readsAfterMount + 1)
    view.unmount()
  })

  test('an event that cannot change rows causes no re-read', async () => {
    const fake = fakeClient([{ id: 'a' }])
    const view = render(React.createElement(Probe, { client: fake.client }))

    await flush()
    const readsAfterMount = fake.reads()

    fake.emit({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    await flush()

    expect(fake.reads()).toBe(readsAfterMount)
    view.unmount()
  })

  test('a failing re-read keeps the previous data and reports the error', async () => {
    const fake = fakeClient([{ id: 'a' }])
    const view = render(React.createElement(Probe, { client: fake.client }))

    await flush()
    expect(view.getByTestId('state').textContent).toBe(JSON.stringify({ data: [{ id: 'a' }], error: null }))

    fake.failNextRead()
    fake.emit({ type: EEngineEventType.LOCAL_CHANGED })
    await flush()

    const state = JSON.parse(view.getByTestId('state').textContent ?? '{}') as { data: unknown; error: string | null }

    expect(state.data).toEqual([{ id: 'a' }])
    expect(state.error).toBe('read failed')
    view.unmount()
  })
})
