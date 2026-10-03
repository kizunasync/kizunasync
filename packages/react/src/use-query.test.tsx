// MARK: - useQuery re-runs when a declared dep changes

/**
 * useQuery's effect keys off [client, read, ...opts.deps]; a build closure
 * that reads an external value (a board order, a filter) needs that value in
 * deps or a later change to it never triggers a re-read. Rerendering with a
 * new deps value must produce a fresh read reflecting the new value.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import type { IKizunaSync } from '@kizunasync/core'
import { useQuery } from './use-query'

const fakeClient = (): IKizunaSync =>
  ({
    on: () => () => {},
    from: () => ({
      select: () => ({
        order: (_column: string, opts: { ascending?: boolean }) =>
          Promise.resolve({ data: [{ ascending: opts.ascending }], error: null }),
      }),
    }),
  }) as unknown as IKizunaSync

const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

function Probe({ client, ascending }: { client: IKizunaSync; ascending: boolean }): React.ReactElement {
  const result = useQuery(
    (k) => k.from('items').select().order('created_at', { ascending }),
    { client, deps: [ascending] },
  )

  return React.createElement('div', { 'data-testid': 'ascending' }, String(result.data[0]?.ascending))
}

describe('useQuery deps', () => {
  test('re-reads and reflects the new value once a declared dep changes', async () => {
    const client = fakeClient()

    const view = render(React.createElement(Probe, { client, ascending: false }))

    await flush()
    expect(view.getByTestId('ascending').textContent).toBe('false')

    view.rerender(React.createElement(Probe, { client, ascending: true }))
    await flush()
    expect(view.getByTestId('ascending').textContent).toBe('true')
  })
})
