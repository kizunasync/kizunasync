'use client'

import type { IHeading } from '@/lib/docs'
import { useTocScrollspy } from '@/lib/use-toc-scrollspy'

/**
 * "On this page" navigation with a turborepo-style cursor. Scrollspy marks
 * the active heading. A vermilion thumb tracks the active link along the
 * rail using Supabase's --toc-top/--toc-height technique, and a fill above
 * the thumb grows as the page scrolls.
 */

// MARK: - DocsToc

export function DocsToc({ headings }: { headings: IHeading[] }) {
  const { activeId, railRef, registerLink } = useTocScrollspy(headings)

  if (headings.length < 2) {
    return <aside className="hidden xl:block" aria-hidden="true" />
  }

  return (
    <aside className="sticky top-28 hidden max-h-[calc(100dvh-8rem)] self-start overflow-y-auto xl:block">
      <p className="text-site-faint font-mono text-xs tracking-wide uppercase">On this page</p>
      <div ref={railRef} className="toc-rail mt-3">
        <div className="toc-progress" aria-hidden="true" />
        <div className="toc-thumb" aria-hidden="true" />
        <ul className="space-y-0.5 text-[0.85rem]">
          {headings.map((heading) => (
            <li key={heading.id}>
              <a
                ref={(node) => registerLink(heading.id, node)}
                href={`#${heading.id}`}
                className={`block py-1 transition-colors ${
                  heading.depth === 3 ? 'pl-7' : 'pl-4'
                } ${
                  activeId === heading.id
                    ? 'text-site-text font-medium'
                    : 'text-site-muted hover:text-site-text'
                }`}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
