'use client'

import { useRef, type CSSProperties } from 'react'
import { activeJourneyIndex, journeyBarProgress } from '@/lib/journey-progress'
import { useJourneyProgress } from '@/lib/use-journey-progress'

// MARK: - Journey navigation

export function JourneyNav({
  steps,
}: {
  steps: readonly {
    id: string
    number: string
    action: string
    section: string
  }[]
}) {
  const navRef = useRef<HTMLDivElement>(null)
  const progresses = useJourneyProgress(
    steps.map((step) => step.id),
    navRef,
  )
  const activeIndex = activeJourneyIndex(progresses)
  const activeId = steps[activeIndex]?.id ?? ''
  const progress = `${journeyBarProgress(progresses) * 100}%`

  return (
    <div ref={navRef} className="sticky top-20 z-40 mt-8">
      <div className="site-container">
        <nav
          aria-label="How Kizuna works"
          style={{ '--journey-progress': progress } as CSSProperties}
          className="journey-nav border-site-border bg-site-background/90 overflow-hidden rounded-xl border backdrop-blur-xl"
        >
          <ol className="divide-site-border grid grid-cols-3 divide-x">
            {steps.map((step) => {
              const isActive = step.id === activeId

              return (
                <li key={step.id} className="min-w-0">
                  <a
                    href={`#${step.id}`}
                    aria-current={isActive ? 'location' : undefined}
                    className={`group focus-visible:relative focus-visible:z-10 flex min-h-16 items-center gap-2 px-3 py-2 transition-[background-color,color] sm:min-h-20 sm:gap-3 sm:px-5 ${
                      isActive
                        ? 'bg-site-surface/80 text-site-text'
                        : 'text-site-muted hover:bg-site-surface/40 hover:text-site-text'
                    }`}
                  >
                    <span
                      className={`font-mono text-xs transition-colors sm:text-sm ${
                        isActive ? 'text-site-accent-bright' : 'text-site-faint group-hover:text-site-accent'
                      }`}
                      aria-hidden="true"
                    >
                      {step.number}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold leading-tight sm:text-sm">
                        {step.action}
                      </span>
                      <span className="text-site-faint mt-1 hidden truncate text-xs sm:block">
                        {step.section}
                      </span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ol>
        </nav>
      </div>
    </div>
  )
}
