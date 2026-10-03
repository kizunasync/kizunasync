import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { PRIMARY_SOURCES } from '@/components/compare/compare-primary-sources.data'

export function ComparePrimarySources() {
  return (
    <>
      <div id="primary-sources" className="mt-16 scroll-mt-24">
        <RevealOnScroll>
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">Primary sources</p>
          <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
            Read the vendor contracts behind every summary above.
          </h2>
          <p className="text-site-muted mt-2 max-w-2xl">
            These are the official pages used for the architectural summaries above. They can
            change independently; the review date is part of this page for that reason.
          </p>
        </RevealOnScroll>
      </div>
      <RevealOnScroll staggerChildren className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PRIMARY_SOURCES.map((entry) => (
          <a
            key={entry.name}
            href={entry.href}
            target="_blank"
            rel="noopener noreferrer"
            className="border-site-border bg-site-surface/50 hover:border-site-accent rounded-xl border p-5 transition-colors"
          >
            <p className="font-semibold">{entry.name}</p>
            <p className="text-site-muted mt-1.5 text-sm leading-relaxed">{entry.what}</p>
          </a>
        ))}
      </RevealOnScroll>
      <RevealOnScroll className="mt-6">
        <p className="text-site-faint text-xs leading-relaxed">
          All trademarks belong to their respective owners; no endorsement implied. Wrong tool
          for Kizuna entirely? Concurrent text or canvas editing → a{' '}
          <a
            href="https://grokipedia.com/page/Conflict-free_replicated_data_type"
            target="_blank"
            rel="noopener noreferrer"
            className="text-site-accent hover:underline"
          >
            CRDT
          </a>{' '}
          system · cross-user transactional invariants → online-only flows · peer or edge mesh →
          a mesh-first system. The full list:{' '}
          <a href="/docs/introduction" className="text-site-accent hover:underline">
            Product &amp; fit
          </a>
          .
        </p>
      </RevealOnScroll>
    </>
  )
}
