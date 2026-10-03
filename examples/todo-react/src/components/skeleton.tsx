import type { CSSProperties } from 'react'

/**
 * A shimmering placeholder block. Width/height/radius come from the caller so it
 * matches the real element; the shimmer + reduced-motion fallback live in the
 * .skeleton rule in globals.css.
 */
export function Skeleton({
  width,
  height,
  radius,
  className,
}: {
  width?: string | number
  height?: string | number
  radius?: string
  className?: string
}) {
  const style: CSSProperties = { width, height, borderRadius: radius }

  return (
    <span className={className === undefined ? 'skeleton' : `skeleton ${className}`} style={style} aria-hidden="true" />
  )
}

/** A 2rem row thumbnail placeholder (reuses .item-thumb for size + border). */
export function SkeletonThumb() {
  return <Skeleton className="item-thumb" />
}

/** One placeholder row mirroring .item: checkbox, thumb, title bar, chip. */
function SkeletonRow() {
  return (
    <li className="item" aria-hidden="true">
      <Skeleton width="1.3125rem" height="1.3125rem" radius="0.375rem" />
      <SkeletonThumb />
      <Skeleton height="0.875rem" radius="0.375rem" className="skeleton-grow" />
      <Skeleton width="2.75rem" height="1.25rem" radius="999px" />
    </li>
  )
}

/** A short list of placeholder rows for the first-load / boot states. */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <ul className="list">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonRow key={index} />
      ))}
    </ul>
  )
}

/** The whole-board placeholder shown during boot (add-row bar + list). */
export function SkeletonBoard() {
  return (
    <div className="column">
      <Skeleton width="100%" height="2.875rem" radius="var(--radius-md)" />
      <SkeletonList />
    </div>
  )
}
