// MARK: - useQuery must not loop on an inline build

/**
 * useQuery reads `build` through a latest-ref rather than taking it in the read
 * callback deps. An INLINE build, the pattern the docs and the example app use,
 * gets a fresh identity every render; in the deps that would re-run the effect
 * (unsubscribe/resubscribe) and fire setState on every resolve, so the render→
 * effect→read→setState loop would never settle. The latest-ref makes mounting
 * subscribe once.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import type { IKizunaSync } from '@kizunasync/core'
import { useQuery } from './use-query'

const fakeClient = (onCalls: { n: number }): IKizunaSync =>
  ({
    on: () => {
      onCalls.n += 1

      return () => {}
    },
    from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
  }) as unknown as IKizunaSync

const flush = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

describe('useQuery inline build', () => {
  test('does not loop: build runs a bounded number of times, subscribes once', async () => {
    const onCalls = { n: 0 }
    const client = fakeClient(onCalls)
    let buildCalls = 0

    function Probe(): React.ReactElement {
      // Inline build ⇒ a fresh identity every render (the real-world pattern).
      const result = useQuery(
        (k) => {
          buildCalls += 1

          return k.from('items').select()
        },
        { client },
      )

      return React.createElement('div', null, String(result.data.length))
    }

    await act(async () => {
      render(React.createElement(Probe))
    })
    await flush(60) // let any loop spin on read-resolution microtasks

    // A settled mount builds a bounded number of times; a resubscribe loop would reach dozens or hundreds.
    expect(buildCalls).toBeLessThanOrEqual(5)
    expect(onCalls.n).toBeLessThanOrEqual(2)
  })
})
