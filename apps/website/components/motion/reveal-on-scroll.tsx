'use client'

import { useEffect, useRef, type ReactNode } from 'react'

// MARK: - RevealOnScroll

/**
 * IntersectionObserver flips data-shown once; all motion lives in CSS
 * ([data-reveal] / [data-reveal-stagger] in globals.css), so the JS cost is
 * one observer per section and reduced-motion is handled in the stylesheet.
 */
export function RevealOnScroll({
  children,
  staggerChildren = false,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode
  staggerChildren?: boolean
  className?: string
  as?: 'div' | 'section' | 'ul'
}) {
  const ref = useRef<HTMLElement & HTMLDivElement & HTMLUListElement>(null)

  useEffect(() => {
    const node = ref.current

    if (node === null) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.setAttribute('data-shown', '')
            observer.disconnect()
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    )

    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  const revealAttr = staggerChildren ? { 'data-reveal-stagger': '' } : { 'data-reveal': '' }

  return (
    <Tag ref={ref} className={className} {...revealAttr}>
      {children}
    </Tag>
  )
}
