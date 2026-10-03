import type { ReactNode } from 'react'

/** Desktop sticky sidebar. Mobile navigation lives in DocsMobileBar (portaled into the header pill). */

// MARK: - DocsSidebar

export function DocsSidebar({ children }: { children: ReactNode }) {
  return (
    <aside className="sticky top-28 hidden max-h-[calc(100dvh-8rem)] self-start overflow-y-auto pr-2 pb-8 lg:block">
      {children}
    </aside>
  )
}
