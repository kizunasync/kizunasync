import Link from 'next/link'
import type { RefObject } from 'react'
import { MOBILE_NAV, TRY_DEMO } from '@/components/site-header.data'

/** Fullscreen blurred overlay with staggered links; the caller's `useMobileMenu` hook owns the enter animation and scroll lock. */
export function SiteHeaderMobileMenu({
  overlayRef,
  onClose,
}: {
  overlayRef: RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  return (
    <div
      ref={overlayRef}
      className="mobile-menu pointer-events-auto fixed inset-0 z-40 flex flex-col items-center justify-center gap-7 opacity-0 backdrop-blur-2xl md:hidden"
    >
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="border-site-border text-site-muted hover:border-site-accent-dim hover:text-site-text absolute top-4 right-4 flex size-11 items-center justify-center rounded-full border transition-colors sm:top-5 sm:right-5"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      {MOBILE_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={onClose}
          {...(item.href.startsWith('http')
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : {})}
          className={
            item.label === TRY_DEMO.label
              ? 'mobile-link bg-site-accent text-site-accent-foreground hover:bg-site-accent-bright rounded-xl px-6 py-3 text-2xl font-semibold transition-colors'
              : 'mobile-link font-display text-4xl font-semibold tracking-tight'
          }
        >
          {item.label}
        </Link>
      ))}
      <p className="mobile-link text-site-faint mt-2 font-mono text-xs">
        絆 · the red thread holds
      </p>
    </div>
  )
}
