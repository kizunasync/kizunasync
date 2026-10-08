/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ESoftBlockReason, ESyncPhase, type TSoftBlockReason } from 'kizunasync'
import * as button from './button'
import * as tip from './tip'
import type { IPaneClient } from '../runtime/kizunasync'

// Bun does not read the `@/` alias from tsconfig.app.json, so the modules status-strip.tsx imports through it resolve to the real ones.
mock.module('@/components/button', () => button)
mock.module('@/components/tip', () => tip)

let softBlockReason: TSoftBlockReason | null = null

mock.module('kizunasync/react', () => ({
  useSyncStatus: () => ({
    outboxDepth: 0,
    isSyncing: false,
    isOnline: true,
    needsReset: softBlockReason !== null,
    softBlockReason,
    health: { phase: ESyncPhase.idle, lastSuccessAt: null },
    syncNow: () => Promise.resolve(),
  }),
}))

const { StatusStrip } = await import('./status-strip')

const CLIENT = { engine: 'wasm' } as unknown as IPaneClient

const renderBlockedBy = (reason: TSoftBlockReason): string => {
  softBlockReason = reason

  return renderToStaticMarkup(<StatusStrip client={CLIENT} />)
}

describe('StatusStrip', () => {
  test('a replaced visitor identity says the pane is resetting to the new one', () => {
    const markup = renderBlockedBy(ESoftBlockReason.identityChanged)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('The visitor session was replaced. This pane is resetting to the new one.')
  })

  test('a server refusal points at Wipe &amp; rehydrate', () => {
    const markup = renderBlockedBy(ESoftBlockReason.resetRequired)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Sync is blocked: the server refused this pane. Wipe &amp; rehydrate rebuilds it.')
  })
})
