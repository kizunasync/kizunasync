// MARK: - useKizunaSync resolution and the message @kizunasync/core owns

/**
 * The "no client" text lives in @kizunasync/core so this binding and @kizunasync/vue fail
 * with one string, and the reference pages that quote it have one source to
 * match. Asserting the constant here rather than a literal is what keeps a later
 * edit to the message from silently splitting the two bindings apart.
 */

import '../happydom'
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { cleanup, render } from '@testing-library/react'
import { MISSING_CLIENT_MESSAGE, type IKizunaSync } from '@kizunasync/core'
import { KizunaSyncProvider, useKizunaSync } from './provider'

function Probe({ client }: { client?: IKizunaSync }): React.ReactElement {
  const resolved = useKizunaSync(client === undefined ? undefined : { client })

  return React.createElement('div', { 'data-testid': 'engine' }, resolved.engine)
}

const fakeClient = (): IKizunaSync => ({ engine: 'rust' }) as unknown as IKizunaSync

/**
 * bun:test does not run @testing-library/react's automatic cleanup, so each
 * render would otherwise stay in document.body and make getByTestId ambiguous.
 */
afterEach(cleanup)

describe('useKizunaSync client resolution', () => {
  test('throws the shared kizunasync message outside a provider with no override', () => {
    expect(() => render(React.createElement(Probe))).toThrow(new Error(MISSING_CLIENT_MESSAGE))
  })

  test('resolves the provider client', () => {
    const view = render(
      React.createElement(
        KizunaSyncProvider,
        { client: fakeClient(), children: React.createElement(Probe) },
      ),
    )

    expect(view.getByTestId('engine').textContent).toBe('rust')
  })

  test('the explicit override wins over the provider client', () => {
    const override = { engine: 'override' } as unknown as IKizunaSync
    const view = render(
      React.createElement(
        KizunaSyncProvider,
        { client: fakeClient(), children: React.createElement(Probe, { client: override }) },
      ),
    )

    expect(view.getByTestId('engine').textContent).toBe('override')
  })
})
