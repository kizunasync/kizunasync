import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Sync inspector · Kizuna Sync',
    template: '%s · Sync inspector · Kizuna Sync',
  },
  description: 'Read-only live view over your local Kizuna Sync stack.',
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml', media: '(prefers-color-scheme: dark)' },
      { url: '/favicon-light.svg', type: 'image/svg+xml', media: '(prefers-color-scheme: light)' },
      { url: '/favicon-dark-32.png', sizes: '32x32', media: '(prefers-color-scheme: dark)' },
      { url: '/favicon-light-32.png', sizes: '32x32', media: '(prefers-color-scheme: light)' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <body className="bg-site-background text-site-text min-h-dvh antialiased">{children}</body>
    </html>
  )
}
