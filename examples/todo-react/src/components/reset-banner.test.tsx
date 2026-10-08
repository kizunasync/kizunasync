import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ESoftBlockReason, type TSoftBlockReason } from 'kizunasync'
import { ResetBanner } from './reset-banner'

const renderBlockedBy = (reason: TSoftBlockReason, outboxDepth = 0): string =>
  renderToStaticMarkup(
    <ResetBanner needsReset softBlockReason={reason} outboxDepth={outboxDepth} isResetting={false} onReset={() => undefined} />,
  )

describe('ResetBanner', () => {
  test('a replaced identity says the local data belongs to another user', () => {
    const markup = renderBlockedBy(ESoftBlockReason.identityChanged, 2)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Sync is blocked')
    expect(markup).toContain(
      'This device&#x27;s local data belongs to another user than the one signed in, so nothing syncs until it is rebuilt. 2 unsynced writes will be lost.',
    )
  })

  test('a server refusal keeps the refusal text', () => {
    const markup = renderBlockedBy(ESoftBlockReason.resetRequired, 1)

    expect(markup).toContain(
      'The server refused this client, so nothing syncs until the local database is rebuilt. 1 unsynced write will be lost.',
    )
  })

  test('nothing renders while sync is not blocked', () => {
    const markup = renderToStaticMarkup(
      <ResetBanner needsReset={false} softBlockReason={null} outboxDepth={0} isResetting={false} onReset={() => undefined} />,
    )

    expect(markup).toBe('')
  })
})
