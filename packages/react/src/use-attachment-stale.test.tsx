// MARK: - useAttachment must not commit a stale ref's status

/**
 * When the displayed ref changes while a prefetch is in flight, the OLD
 * prefetch's continuation must not call refresh() and commit the OLD ref's
 * status onto the component now showing the NEW ref (the shared seq counter
 * can't tell them apart). A ref-generation guard drops the stale commit.
 */

import '../happydom'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { act, render } from '@testing-library/react'
import { EAttachmentState, type IKizunaSync, type TAttachmentStatus } from '@kizunasync/core'
import { useAttachment } from './use-attachment'

const status = (ref: string): TAttachmentStatus =>
  ({
    state: EAttachmentState.synced,
    progress: 100,
    localUri: ref === 'B' ? 'uri-B' : null, // A has no local uri ⇒ triggers auto-prefetch
    error: null,
  }) as unknown as TAttachmentStatus

const makeClient = (deferredA: Promise<void>): IKizunaSync =>
  ({
    attachments: {
      getStatus: async (ref: string) => status(ref),
      resolveDownload: async (ref: string) => {
        if (ref === 'A') {
          await deferredA // A's fetch is slow (still pending on ref change)
        }
      },
      watch: () => () => {},
    },
  }) as unknown as IKizunaSync

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

function Probe({ r, client }: { r: string; client: IKizunaSync }): React.ReactElement {
  const a = useAttachment(r, { client })

  return React.createElement('div', { 'data-testid': 'uri' }, a.localUri ?? 'none')
}

describe('useAttachment stale prefetch', () => {
  test('a slow prefetch for the previous ref does not overwrite the current ref', async () => {
    let resolveA!: () => void
    const deferredA = new Promise<void>((r) => { resolveA = r })
    const client = makeClient(deferredA)

    const view = render(React.createElement(Probe, { r: 'A', client }))

    await flush() // A: localUri null ⇒ auto-prefetch fires (deferred)

    view.rerender(React.createElement(Probe, { r: 'B', client }))
    await flush() // B: localUri uri-B
    expect(view.getByTestId('uri').textContent).toBe('uri-B')

    // A's stale prefetch resolves after the switch to B and must NOT refresh onto B.
    resolveA()
    await flush()
    expect(view.getByTestId('uri').textContent).toBe('uri-B')
  })
})
