import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { GITHUB_URL } from '@/lib/site'

export function CompareIntro() {
  return (
    <RevealOnScroll>
      <p className="text-site-accent font-mono text-xs tracking-wide uppercase">Compare</p>
      <h1 className="font-display mt-3 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
        Different architectures, different ownership boundaries.
      </h1>
      <p className="text-site-muted mt-4 max-w-2xl leading-relaxed">
        This page compares architecture, not prices, release cadence, issue counts,
        benchmarks, licensing tiers, or support promises. Vendor summaries follow the official
        sources linked on every card and collected under{' '}
        <a href="#primary-sources" className="text-site-accent hover:underline">
          primary sources
        </a>
        . Got a fact wrong?{' '}
        <a
          href={`${GITHUB_URL}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-site-accent hover:underline"
        >
          Open an issue
        </a>{' '}
        and we fix it.
      </p>
    </RevealOnScroll>
  )
}
