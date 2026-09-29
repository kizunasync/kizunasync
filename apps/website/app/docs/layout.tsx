import type { ReactNode } from 'react'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'

/**
 * Turborepo-style shell: sidebar | content (max 54rem) | TOC, centered in a
 * 90rem canvas (.docs-shell in globals.css). Pages emit <article> (+ optional
 * TOC aside) as direct grid children. On mobile the docs nav attaches to the
 * main header via DocsMobileBar (portal into the pill's slot).
 */

// MARK: - Docs layout

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <div className="docs-shell pt-32 pb-20 lg:pt-28">{children}</div>
      <SiteFooter />
    </>
  )
}
