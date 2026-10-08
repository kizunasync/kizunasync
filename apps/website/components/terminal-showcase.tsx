'use client'

/**
 * Illustrates `kizunasync init --dry-run`. Command text types in with CSS steps, then output
 * lines fade in. JS only starts that CSS replay when the panel enters view.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { useCopyToClipboard } from '@/lib/use-copy-to-clipboard'
import { StatusChip } from '@/components/status-chip'
import { INIT_PREVIEW_ARGS, PACKAGE_MANAGER_TABS, kizunasyncCommand, type TPackageManager } from '@/lib/site'
import { useSyncedTab } from '@/lib/use-synced-tab'

// MARK: - TerminalShowcase

const LINES: { text: ReactNode; dim?: boolean }[] = [
  {
    text: (
      <>
        <span className="text-site-accent font-display">絆</span>{' '}
        <span className="font-bold">kizunasync</span>
 <span className="text-site-faint"> · illustrative dry-run plan</span>
      </>
    ),
  },
 { text: <span className="text-site-faint">kizunasync init · dry-run plan</span> },
  {
    text: (
      <>
        <span className="text-site-accent">→</span> inspect <span className="text-site-accent-bright">pg_policies</span>{' '}
        <span className="text-site-faint">when a database connection resolves</span>
      </>
    ),
  },
  {
    text: (
      <>
        <span className="text-site-accent">→</span> propose synced tables and simple owner buckets{' '}
        <span className="text-site-faint">for review</span>
      </>
    ),
  },
  {
    text: (
      <>
        <span className="text-site-accent">→</span> record the synced set in{' '}
        <span className="text-site-accent-bright">kizunasync._config</span>{' '}
        <span className="text-site-faint">skipped when a config migration is already emitted</span>
      </>
    ),
  },
  {
    text: (
      <>
        <span className="text-site-accent">→</span> preview pack and per-table config migrations{' '}
        <span className="text-site-faint">without writing them</span>
      </>
    ),
  },
  {
    text: (
      <>
        <span className="text-site-accent">→</span> preview <span className="text-site-accent-bright">[api].schemas</span>{' '}
        <span className="text-site-faint">exposure patch when the file shape is supported</span>
      </>
    ),
  },
  { text: <span aria-hidden="true"> </span> },
  {
    text: (
      <>
        <span className="text-site-ok">✓</span> dry-run: no files or database objects changed{' '}
        <span className="text-site-faint">review before applying with --yes</span>
      </>
    ),
  },
]

export function TerminalShowcase() {
  const rootRef = useRef<HTMLDivElement>(null)
  const { copied, copy } = useCopyToClipboard()
  const [active] = useSyncedTab('pm', PACKAGE_MANAGER_TABS)
  const command = kizunasyncCommand(active as TPackageManager, INIT_PREVIEW_ARGS)

  useEffect(() => {
    const node = rootRef.current

    if (node === null) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('term-play')
            observer.disconnect()
          }
        }
      },
      { rootMargin: '0px 0px -20% 0px' },
    )

    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={rootRef}
      className="border-site-border bg-site-background overflow-hidden rounded-2xl border shadow-2xl"
    >
      <div className="border-site-border/60 bg-site-surface/60 flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="bg-site-accent/80 h-3 w-3 rounded-full" />
          <span className="bg-site-gold/70 h-3 w-3 rounded-full" />
          <span className="bg-site-ok/70 h-3 w-3 rounded-full" />
        </span>
 <span className="text-site-faint ml-2 font-mono text-xs">Kizuna Sync » terminal</span>
        <StatusChip />
        <span className="text-site-faint font-mono text-[10px] tracking-wide uppercase">illustration</span>
        <button
          type="button"
          onClick={() => void copy(command)}
          className="border-site-border text-site-muted hover:border-site-accent-dim hover:text-site-text ml-auto cursor-pointer rounded-md border px-2.5 py-1 font-mono text-xs transition-colors"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>

      <div className="border-site-border/60 border-b px-5 py-4">
        <code className="font-mono text-sm sm:text-base">
          <span className="text-site-accent select-none">$ </span>
          <span className="term-cmd text-site-text">{command}</span>
          <span className="term-caret text-site-accent select-none">▍</span>
        </code>
      </div>

      <div
        className="min-h-[17rem] space-y-1.5 px-5 py-5 font-mono text-xs leading-relaxed sm:text-sm"
        aria-hidden="true"
      >
        {LINES.map((line, index) => (
          <p
            key={index}
            className="term-line"
            style={{ ['--line' as string]: index }}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  )
}
