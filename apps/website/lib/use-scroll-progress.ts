'use client'

import { useEffect, useState } from 'react'

// MARK: - useScrollProgress

/**
 * 0 → 1 over the first 80px of scroll; drives the header's glass-pill detach
 * entirely in CSS via the --header-progress custom property.
 */
export function useScrollProgress(range = 80): number {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        setProgress(Math.min(window.scrollY / range, 1))
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
    }
  }, [range])

  return progress
}
