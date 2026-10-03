import { ICONS } from '@kizunasync/ui'
import { HeroCommand } from '@/components/hero-command'
import { HeroShowcase } from '@/components/hero-showcase'
import { Reveal } from '@/components/motion/reveal'
import { StatusTicker } from '@/components/status-ticker'
import { GITHUB_URL } from '@/lib/site'

export function HeroSection() {
  return (
    <section id="home" className="relative overflow-hidden">
      <div className="bg-grid-faint absolute inset-0 -z-10" aria-hidden="true" />
      <div className="site-container flex min-h-dvh flex-col items-center pt-24 pb-10 text-center">
        <div className="flex w-full flex-1 flex-col items-center justify-center">
          <Reveal>
            <p className="border-site-border bg-site-surface/70 text-site-muted mb-6 inline-block rounded-full border px-4 py-1 font-mono text-[11px] tracking-wide sm:text-xs">
              Alpha · on npm, Swift Package Manager, and Maven Central
            </p>
          </Reveal>
          <Reveal delay={0.08} className="w-full">
            <HeroShowcase />
          </Reveal>
          <Reveal delay={0.16}>
            <p className="text-site-muted mx-auto mt-8 max-w-2xl text-base text-pretty sm:text-lg">
              Synchronizes <strong className="text-site-text">rows</strong> and <strong className="text-site-text">attachment references</strong>. Buckets select; Postgres grants and RLS authorize.
            </p>
          </Reveal>
          <Reveal delay={0.24} className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
            <HeroCommand />
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-site-accent text-site-accent-foreground hover:bg-site-accent-bright inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold transition-colors"
            >
              <span className="nf" aria-hidden="true">
                {ICONS.github}
              </span>
              Star on GitHub
            </a>
          </Reveal>
          <Reveal
            delay={0.3}
            className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-xs sm:text-sm"
          >
            <a
              href={`${GITHUB_URL}/tree/main/apps/demo`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-site-accent hover:underline"
            >
              Run it from apps/demo →
            </a>
            <a href="/docs/quickstart" className="text-site-accent hover:underline">
              Quickstart guide →
            </a>
            <a href="/agent-setup.md" className="text-site-muted hover:text-site-accent hover:underline">
              Building with an AI agent? Bot setup guide →
            </a>
          </Reveal>
          <Reveal delay={0.36}>
            <StatusTicker />
          </Reveal>
        </div>
      </div>
    </section>
  )
}
