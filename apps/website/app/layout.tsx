import type { Metadata, Viewport } from 'next'
import type { ReactElement, ReactNode } from 'react'
import Script from 'next/script'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { ConsentBanner, createTagManagerBootstrapScript, createTagManagerNoscriptUrl } from '@kizunasync/ui'
import { DESCRIPTION, SITE_FULL_NAME, SITE_URL, TAGLINE } from '@/lib/site'
import './globals.css'
import '@fontsource/shippori-mincho/latin-600.css'
import '@fontsource/shippori-mincho/latin-700.css'

// MARK: - Metadata

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_FULL_NAME} · ${TAGLINE}`,
    template: `%s · ${SITE_FULL_NAME}`,
  },
  description: DESCRIPTION,
  keywords: [
    'Supabase offline sync',
    'offline-first',
    'local-first',
    'Supabase SQLite',
    'Supabase sync source code',
    'Expo offline',
    'React Native sync',
    'attachment sync',
    'Kizuna Sync',
  ],
  alternates: { canonical: '/' },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml', media: '(prefers-color-scheme: dark)' },
      { url: '/favicon-light.svg', type: 'image/svg+xml', media: '(prefers-color-scheme: light)' },
      { url: '/favicon-dark-32.png', sizes: '32x32', media: '(prefers-color-scheme: dark)' },
      { url: '/favicon-light-32.png', sizes: '32x32', media: '(prefers-color-scheme: light)' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  openGraph: {
    type: 'website',
    siteName: SITE_FULL_NAME,
    title: `${SITE_FULL_NAME} · ${TAGLINE}`,
    description: DESCRIPTION,
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_FULL_NAME} · ${TAGLINE}`,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

// MARK: - Root layout

/** suppressHydrationWarning on <html> suppresses mismatches injected by browser extensions (e.g. dark-mode or translation attributes) that modify the DOM before React hydrates. */
export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  const gtmId = process.env.NEXT_PUBLIC_WEBSITE_GTM_ID ?? ''

  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="bg-site-background text-site-text min-h-dvh antialiased">
        {gtmId !== '' ? <TagManager gtmId={gtmId} /> : null}
        <a
          href="#main-content"
          className="sr-only rounded-md focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:border focus:border-site-accent focus:bg-site-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-site-text focus:shadow-lg"
        >
          Skip to content
        </a>
        {children}
        <ConsentBanner gtmId={gtmId} />
      </body>
    </html>
  )
}

// MARK: - Pieces

/**
 * The website sets no CSP, so the consent bootstrap runs inline before
 * hydration; the noscript iframe loads the container when JavaScript is off.
 */
function TagManager({ gtmId }: { gtmId: string }): ReactElement {
  return (
    <>
      <noscript>
        <iframe
          src={createTagManagerNoscriptUrl(gtmId)}
          title="Google Tag Manager"
          height="0"
          width="0"
          style={{ display: 'none', visibility: 'hidden' }}
        />
      </noscript>
      <Script
        id="gtm-consent-bootstrap"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{ __html: createTagManagerBootstrapScript(gtmId) }}
      />
    </>
  )
}
