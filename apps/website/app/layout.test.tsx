/// <reference types="bun" />
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

// next/font and next/script only work inside a Next build; the stand-ins keep what the layout passes them visible.
mock.module('geist/font/sans', () => ({ GeistSans: { variable: 'font-geist-sans' } }))
mock.module('geist/font/mono', () => ({ GeistMono: { variable: 'font-geist-mono' } }))
mock.module('next/script', () => ({
  default: ({ id, strategy, dangerouslySetInnerHTML }: { id: string; strategy: string; dangerouslySetInnerHTML: { __html: string }; children?: ReactNode }) => (
    <script id={id} data-strategy={strategy} dangerouslySetInnerHTML={dangerouslySetInnerHTML} />
  ),
}))

const { default: RootLayout } = await import('./layout')

const GTM_ID = 'GTM-TEST'
const ORIGINAL_GTM_ID = process.env.NEXT_PUBLIC_WEBSITE_GTM_ID

const renderLayout = (gtmId: string | undefined): string => {
  if (gtmId === undefined) {
    delete process.env.NEXT_PUBLIC_WEBSITE_GTM_ID
  } else {
    process.env.NEXT_PUBLIC_WEBSITE_GTM_ID = gtmId
  }

  return renderToStaticMarkup(
    <RootLayout>
      <p>Page</p>
    </RootLayout>,
  )
}

afterEach(() => {
  if (ORIGINAL_GTM_ID === undefined) {
    delete process.env.NEXT_PUBLIC_WEBSITE_GTM_ID
  } else {
    process.env.NEXT_PUBLIC_WEBSITE_GTM_ID = ORIGINAL_GTM_ID
  }
})

describe('root layout tag manager', () => {
  test('a GTM id runs the consent bootstrap before the page becomes interactive', () => {
    const markup = renderLayout(GTM_ID)
    const bootstrap = markup.match(/<script id="gtm-consent-bootstrap" data-strategy="([^"]+)">([\s\S]*?)<\/script>/)

    expect(bootstrap?.[1]).toBe('beforeInteractive')
    expect(bootstrap?.[2]).toContain(`"gtmId":"${GTM_ID}"`)
    expect(bootstrap?.[2]).toContain('"regions":["AT"')
    expect(bootstrap?.[2]).toContain('"storageKey":"kizunasync.consent"')
  })

  test('a GTM id adds the noscript iframe first in the body', () => {
    const markup = renderLayout(GTM_ID)
    const bodyStart = markup.slice(markup.indexOf('<body'))

    expect(bodyStart).toMatch(/^<body[^>]*><noscript><iframe src="https:\/\/www\.googletagmanager\.com\/ns\.html\?id=GTM-TEST"/)
  })

  test('without a GTM id the layout loads no tags', () => {
    for (const gtmId of [undefined, '']) {
      const markup = renderLayout(gtmId)

      expect(markup).not.toContain('gtm-consent-bootstrap')
      expect(markup).not.toContain('googletagmanager')
    }
  })

  test('the server render leaves the consent banner to the browser', () => {
    expect(renderLayout(GTM_ID)).not.toContain('role="region"')
  })
})
