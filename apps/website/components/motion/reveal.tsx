import type { CSSProperties, ReactNode } from 'react'

// MARK: - Reveal

/**
 * Pure critical-CSS animation: hero children are LCP candidates, and any
 * JS-applied change after hydration re-rasterizes them and hurts LCP on
 * throttled mobile. The keyframe starts at first paint; reduced-motion
 * disables it in the stylesheet. Server component: zero client JS.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  const style: CSSProperties | undefined = delay > 0 ? { animationDelay: `${delay}s` } : undefined

  return (
    <div className={`hero-rise ${className ?? ''}`} style={style}>
      {children}
    </div>
  )
}
