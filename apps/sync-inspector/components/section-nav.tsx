'use client'

/**
 * The only client responsibility here is scroll-spying the shell's own
 * scroll container (id `inspector-scroll`; the content column scrolls, not
 * the window) via IntersectionObserver, so the active link tracks whichever
 * section sits nearest the top as the reader scrolls. The sections themselves
 * come from `lib/section-defs`, the same list the page anchors. Navigation is
 * plain anchor links; no router, no client-side data.
 */
import { useEffect, useState } from 'react'
import { INSPECTOR_SECTIONS } from '@/lib/section-defs'

// MARK: - Scroll root

const SCROLL_ROOT_ID = 'inspector-scroll'

// MARK: - Component

export function SectionNav() {
  const [activeId, setActiveId] = useState<string>(INSPECTOR_SECTIONS[0].id)

  useEffect(() => {
    const root = document.getElementById(SCROLL_ROOT_ID)

    if (root === null) {
      return
    }
    const targets = INSPECTOR_SECTIONS.map((section) => document.getElementById(section.id)).filter(
      (element): element is HTMLElement => element !== null,
    )

    if (targets.length === 0) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)

        if (visible.length === 0) {
          return
        }
        const topMost = visible.reduce((closest, entry) =>
          entry.boundingClientRect.top < closest.boundingClientRect.top ? entry : closest,
        )

        setActiveId(topMost.target.id)
      },
      // Treat a section as active once it crosses into the top 30% of the scroll area, rather than requiring full visibility.
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    )

    for (const target of targets) {
      observer.observe(target)
    }
    return () => observer.disconnect()
  }, [])

  return (
    <nav aria-label="Sections" className="flex items-center gap-1">
      {INSPECTOR_SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={activeId === section.id ? 'location' : undefined}
          className={`rounded-full px-2.5 py-1 font-mono text-xs tracking-wide transition-colors ${
            activeId === section.id
              ? 'bg-site-accent/10 text-site-accent-bright'
              : 'text-site-muted hover:text-site-text'
          }`}
        >
          {section.label}
        </a>
      ))}
    </nav>
  )
}
