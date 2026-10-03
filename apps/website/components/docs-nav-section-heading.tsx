import type { ReactNode } from 'react'

// MARK: - DocsNavSectionHeading

/** Sticky uppercase section label for grouped docs / reference sidebar nav. */
export function DocsNavSectionHeading({
  children,
  stickyOffset = 'top-0',
}: {
  children: ReactNode
  stickyOffset?: string
}) {
  return (
    <p
      className={`border-site-border/40 bg-site-background/95 sticky ${stickyOffset} z-10 -mr-2 border-b py-1.5 pr-2 backdrop-blur-sm text-site-faint font-mono text-xs tracking-wide uppercase`}
    >
      {children}
    </p>
  )
}
