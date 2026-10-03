import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import type { IComparison } from '@/components/compare/compare-head-to-heads.data'

export function CompareHeadToHeadCard({ entry }: { entry: IComparison }) {
  return (
    <RevealOnScroll>
      <article
        id={entry.id}
        className="border-site-border bg-site-surface/40 scroll-mt-24 rounded-2xl border p-6 sm:p-8"
      >
        <h2 className="font-display text-xl font-bold tracking-tight sm:text-2xl">
          Kizuna vs {entry.name}
        </h2>
        <p className="text-site-muted mt-2 max-w-3xl text-sm leading-relaxed">{entry.what}</p>
        <a
          href={entry.sourceUrl}
          className="text-site-accent mt-2 inline-flex text-xs hover:underline"
          {...(entry.sourceUrl.startsWith('http')
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : {})}
        >
          Primary source: {entry.sourceLabel} →
        </a>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="text-site-accent font-mono text-xs tracking-wide uppercase">
              Kizuna-side differences
            </h3>
            <ul className="text-site-muted mt-3 space-y-2 text-sm leading-relaxed">
              {entry.whyKizunaSync.map((item) => (
                <li key={item}>
                  <span className="text-site-accent" aria-hidden="true">
                    ›{' '}
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-site-gold font-mono text-xs tracking-wide uppercase">
              Documented {entry.name} characteristics
            </h3>
            <ul className="text-site-muted mt-3 space-y-2 text-sm leading-relaxed">
              {entry.theyShine.map((item) => (
                <li key={item}>
                  <span className="text-site-gold" aria-hidden="true">
                    ◆{' '}
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="border-site-border/60 mt-6 grid gap-3 border-t pt-4 text-sm leading-relaxed sm:grid-cols-2">
          <p className="text-site-muted">
            <span className="text-site-accent-bright font-medium">Choose Kizuna Sync if:</span>{' '}
            {entry.chooseKizunaSync}
          </p>
          <p className="text-site-muted">
            <span className="text-site-gold font-medium">Choose {entry.name} if:</span>{' '}
            {entry.chooseThem}
          </p>
        </div>
      </article>
    </RevealOnScroll>
  )
}
