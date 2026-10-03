import type { ReactNode } from 'react'
import { Chip } from '@heroui/react/chip'
import { BrandMark } from '@kizunasync/ui'
import { InfoModal } from '@/components/info-modal'
import { SectionNav } from '@/components/section-nav'

// MARK: - Component

export function InspectorShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-dvh w-full flex-col px-6 py-3 sm:px-8">
      <header className="border-site-border/70 shrink-0 border-b pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <BrandMark suffix="inspector" />
          <Chip
            size="sm"
            variant="soft"
            color="accent"
            className="font-mono text-[0.7rem] tracking-wide"
          >
            sync inspector
          </Chip>
          <span className="ml-auto flex items-center gap-2">
            <InfoModal />
          </span>
        </div>
        <h1 className="mt-1.5 text-base font-semibold tracking-tight sm:text-lg">
          Live view over the local stack
        </h1>
        <p className="text-site-muted mt-0.5 max-w-3xl text-xs leading-snug">
          A read-only window over your local Supabase. Keep it open beside a running todo example
          to watch todos sync, the changelog grow, and clients register in real time.
        </p>
        <div className="mt-2">
          <SectionNav />
        </div>
      </header>
      <div id="inspector-scroll" className="min-h-0 flex-1 overflow-y-auto py-3">
        {children}
        <footer className="border-site-border/70 text-site-muted mt-3 flex flex-wrap items-center gap-x-2.5 border-t pt-2 text-xs">
          <span>Read-only over the local stack</span>
          <span aria-hidden="true" className="text-site-border">
            ·
          </span>
          <a
            className="text-site-muted hover:text-site-text underline underline-offset-2 transition-colors"
            href="http://127.0.0.1:55323"
            target="_blank"
            rel="noopener noreferrer"
          >
            Supabase Studio
          </a>
          <span aria-hidden="true" className="text-site-border">
            ·
          </span>
          <a
            className="text-site-muted hover:text-site-text underline underline-offset-2 transition-colors"
            href="https://kizunasync.com/docs"
            target="_blank"
            rel="noopener noreferrer"
          >
            Docs
          </a>
        </footer>
      </div>
    </main>
  )
}
