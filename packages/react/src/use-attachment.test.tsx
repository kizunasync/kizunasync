// MARK: - useAttachment on an app client without attachment ports

/**
 * An app client built without the fileStore and transfer ports still has an
 * attachment surface; each of its calls fails with ATTACHMENT_PORTS_MISSING.
 * The hook stays idle until it follows a ref, then reports that failure as its
 * error instead of throwing during render.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { createKizunaSync, defineConfig, type IKizunaSync, type IProtocolRemote } from '@kizunasync/core'
import { useAttachment } from './use-attachment'

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

function Probe({ r, client }: { r: string | null; client: IKizunaSync }): React.ReactElement {
  const attachment = useAttachment(r, { client })

  return React.createElement('div', { 'data-testid': 'attachment' }, `${attachment.state}|${attachment.error ?? 'none'}`)
}

describe('useAttachment without attachment ports', () => {
  test('stays idle with no ref, and reports ATTACHMENT_PORTS_MISSING once it follows one', async () => {
    const client = createKizunaSync({ databasePath: null }, {} as IProtocolRemote, defineConfig({ tables: { todos: { sync: 'read-write' } } }))
    const view = render(React.createElement(Probe, { r: null, client }))

    await flush()
    expect(view.getByTestId('attachment').textContent).toBe('idle|none')

    view.rerender(React.createElement(Probe, { r: 'u1/p1/a.png', client }))
    await flush()
    expect(view.getByTestId('attachment').textContent).toStartWith('idle|createKizunaSync was called without both fileStore and transfer ports')
    client.dispose()
  })
})
