'use client'

import { useEffect, useRef } from 'react'

// MARK: - StatCounter

/**
 * Counts up once when scrolled into view. Server-renders the FINAL value
 * (crawler-safe, no-JS-safe); the animation only replays it.
 */
export function StatCounter({
  value,
  label,
  prefix = '',
  suffix = '',
}: {
  value: number
  label: string
  prefix?: string
  suffix?: string
}) {
  const numberRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const node = numberRef.current

    if (node === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    let frame = 0
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue
        }
        observer.disconnect()
        const start = performance.now()
        const duration = 900
        const tick = (now: number) => {
          const t = Math.min((now - start) / duration, 1)
          const eased = 1 - (1 - t) ** 3

          node.textContent = String(Math.round(eased * value))

          if (t < 1) {
            frame = requestAnimationFrame(tick)
          }
        }
        frame = requestAnimationFrame(tick)
      }
    })

    observer.observe(node)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [value])

  return (
    <div>
      <p className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {prefix}
        <span ref={numberRef}>{value}</span>
        {suffix}
      </p>
      <p className="text-site-muted mt-1 text-xs sm:text-sm">{label}</p>
    </div>
  )
}
