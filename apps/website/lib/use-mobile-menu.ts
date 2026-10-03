'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { usePathname } from 'next/navigation'

export interface IUseMobileMenuResult {
  mobileOpen: boolean
  overlayRef: RefObject<HTMLDivElement | null>
  openMobile: () => void
  closeMobile: () => void
}

/**
 * Owns the mobile fullscreen overlay: open/close state, its GSAP enter
 * animation, closing on route change, and the Escape key handler. Never
 * leaves the body scroll-locked.
 */
export function useMobileMenu(): IUseMobileMenuResult {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  function openMobile() {
    setMobileOpen(true)
    document.body.style.overflow = 'hidden'
  }

  function closeMobile() {
    const node = overlayRef.current

    document.body.style.overflow = ''

    if (node === null) {
      setMobileOpen(false)

      return
    }
    void import('gsap').then(({ gsap }) => {
      gsap.to(node, {
        autoAlpha: 0,
        duration: 0.2,
        ease: 'power2.in',
        onComplete: () => setMobileOpen(false),
      })
    })
  }

  useEffect(() => {
    const node = overlayRef.current

    if (!mobileOpen || node === null) {
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.style.opacity = '1'
      node.style.visibility = 'visible'

      return
    }
    void import('gsap').then(({ gsap }) => {
      gsap.fromTo(node, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power2.out' })
      gsap.fromTo(
        node.querySelectorAll('.mobile-link'),
        { autoAlpha: 0, y: 24 },
        { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power3.out', stagger: 0.06, delay: 0.05 },
      )
    })
  }, [mobileOpen])

  // Close on route change; never leave the body locked.
  useEffect(() => {
    document.body.style.overflow = ''
    setMobileOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!mobileOpen) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMobile()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  return { mobileOpen, overlayRef, openMobile, closeMobile }
}
