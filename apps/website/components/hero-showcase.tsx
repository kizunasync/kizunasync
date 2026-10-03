'use client'

import { FRAMEWORKS, SUPABASE_GLYPH, SUPABASE_GREEN } from '@/lib/frameworks'
import { useFrameworkTypewriter } from '@/lib/use-framework-typewriter'
import { SyncScene } from './sync-scene'

// MARK: - HeroShowcase

export function HeroShowcase() {
  const { framework, wordRef, pauseFrameworkRotation, resumeFrameworkRotation } = useFrameworkTypewriter()

  return (
    <div className="w-full">
      <h1 className="mx-auto max-w-3xl text-center text-[2.55rem] leading-[1.05] font-semibold text-balance sm:text-6xl">
        Offline data and media,
        inside your Supabase
      </h1>
      <p
        className="mt-4 flex min-h-[1.4em] flex-wrap items-baseline justify-center gap-x-3 gap-y-1 text-center text-2xl font-medium sm:text-4xl"
        aria-label={`Source-only Supabase sync Alpha for ${FRAMEWORKS.map((entry) => entry.label).join(', ')}`}
      >
        <span className="text-site-muted">Source-only</span>
        <a
          href="https://supabase.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-baseline gap-2 rounded-md underline-offset-4 transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current focus-visible:outline-none"
          style={{ color: SUPABASE_GREEN }}
        >
          <span className="nf text-[0.85em]" aria-hidden="true">
            {SUPABASE_GLYPH}
          </span>
          <span>Supabase</span>
        </a>
        <span className="text-site-muted"> sync Alpha for</span>
        <a
          href={framework.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-[8.5ch] items-baseline gap-2 rounded-md text-left underline-offset-4 transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-current focus-visible:outline-none sm:min-w-[10ch]"
          style={{ color: framework.color }}
          onMouseEnter={pauseFrameworkRotation}
          onMouseLeave={resumeFrameworkRotation}
          onFocus={pauseFrameworkRotation}
          onBlur={resumeFrameworkRotation}
        >
          <span className="nf text-[0.85em]" aria-hidden="true">
            {framework.glyph}
          </span>
          <span ref={wordRef} aria-hidden="true">
            {FRAMEWORKS[0]!.label}
          </span>
          <span className="tw-caret" aria-hidden="true" />
        </a>
      </p>
      <SyncScene framework={framework} />
    </div>
  )
}
