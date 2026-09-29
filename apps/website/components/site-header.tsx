'use client'

import type { CSSProperties } from 'react'
import Link from 'next/link'
import { SiteHeaderMobileMenu } from '@/components/site-header-mobile-menu'
import { SiteHeaderNav } from '@/components/site-header-nav'
import { useMobileMenu } from '@/lib/use-mobile-menu'
import { useScrollProgress } from '@/lib/use-scroll-progress'

/**
 * Detaches into a floating glass pill while the page scrolls (the
 * --header-progress variable drives margin/width/radius/border/blur in CSS).
 * Mobile: bordered burger that morphs to an X (bars thicken with header progress),
 * opening a fullscreen blurred overlay with staggered links (GSAP), body scroll locked
 * while open.
 */

// MARK: - Site header

/**
 * Pages can portal a second row INTO the pill (the docs bar) so it shares the
 * same glass surface and can never detach from the menu.
 */
export const HEADER_BAR_SLOT_ID = 'header-bar-slot'

export function SiteHeader() {
  const progress = useScrollProgress()
  const { mobileOpen, overlayRef, openMobile, closeMobile } = useMobileMenu()

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div
        style={{ '--header-progress': progress } as CSSProperties}
        className="pointer-events-auto mx-auto mt-[calc(var(--header-progress,0)*var(--spacing)*4)] w-[calc(100%_-_var(--header-progress,0)*var(--spacing)*8)] max-w-6xl overflow-hidden rounded-[calc(var(--header-progress,0)*var(--spacing)*4)] border border-[color-mix(in_oklab,var(--color-site-border)_calc(var(--header-progress,0)*100%),transparent)] bg-[color-mix(in_oklab,var(--color-site-background)_calc(var(--header-progress,0)*88%),transparent)] backdrop-blur-[calc(var(--header-progress,0)*16px)]"
      >
        <div className="flex items-center justify-between px-4 py-1.5 sm:px-6 sm:py-2.5">
          <Link
            href="/"
            aria-label="Kizuna Sync"
            className="brand-link flex items-baseline gap-1.5 font-semibold tracking-tight"
          >
            <span className="text-site-accent font-display text-lg leading-none" aria-hidden="true">
              絆
            </span>
            <BrandMark />
          </Link>

          <SiteHeaderNav />

          <button
            type="button"
            aria-expanded={mobileOpen}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => (mobileOpen ? closeMobile() : openMobile())}
            className={`flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors md:hidden ${
              mobileOpen ? 'burger-open' : ''
            } border-[color-mix(in_oklab,var(--color-site-border)_calc((1-var(--header-progress,0))*100%),transparent)] text-[color-mix(in_oklab,var(--color-site-muted),var(--color-site-text)_calc(var(--header-progress,0)*60%))]`}
          >
            <span className="inline-flex flex-col items-center justify-center gap-1">
              <span className="burger-bar" />
              <span className="burger-bar" />
              <span className="burger-bar" />
            </span>
          </button>
        </div>
        <div id={HEADER_BAR_SLOT_ID} />
      </div>

      {mobileOpen ? <SiteHeaderMobileMenu overlayRef={overlayRef} onClose={closeMobile} /> : null}
    </header>
  )
}

// MARK: - Pieces

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-k">
        <span className="brand-k-full">K</span>
        <span className="brand-k-short">k</span>
      </span>
      <span className="brand-collapse">IZUNA</span>
      <span className="brand-gap" />
      <span className="brand-sync">sync</span>
    </span>
  )
}
