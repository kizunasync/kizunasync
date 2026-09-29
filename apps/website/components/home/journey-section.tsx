import { CodePanel } from '@/components/code-panel'
import { JourneyNav } from '@/components/journey-nav'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { Section } from '@/components/section'
import { StatusChip } from '@/components/status-chip'
import { TerminalShowcase } from '@/components/terminal-showcase'
import { QuickstartTabs } from '@/components/quickstart-tabs'
import { JOURNEY_STEPS, TANSTACK_ROADMAP_SLUG } from '@/components/home/journey.data'

// MARK: - JourneySection

export function JourneySection() {
  return (
    <div className="relative">
      <JourneyOverview />
      <JourneyNav steps={JOURNEY_STEPS} />
      <JourneyCliStep />
      <JourneyApiStep />
      <JourneyQuickstartStep />
    </div>
  )
}

// MARK: - Steps

function JourneyOverview() {
  return (
    <Section
      id="how-it-works"
      bordered={false}
      containerClassName="pt-0 pb-0 sm:pt-0 sm:pb-0"
    >
      <RevealOnScroll>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">
            How it works
          </p>
          <StatusChip />
        </div>
        <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          Three pieces: source-built CLI, sync config, and local client.
        </h2>
      </RevealOnScroll>
    </Section>
  )
}

function JourneyCliStep() {
  return (
    <Section
      id="cli"
      bordered={false}
      className="journey-destination"
      containerClassName="grid items-center gap-10 lg:grid-cols-[0.85fr_1.15fr]"
    >
      <RevealOnScroll className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">
            {JOURNEY_STEPS[0].number} · {JOURNEY_STEPS[0].action}
          </p>
          <p className="text-site-faint font-mono text-xs">{JOURNEY_STEPS[0].section}</p>
        </div>
        <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          Preview the source-built CLI before it writes.
        </h2>
        <p className="text-site-muted mt-3 leading-relaxed">
          A connected <code className="font-mono text-sm">kizunasync init</code> can inspect
          policies and propose simple owner buckets. Dry-run changes nothing; an applied
          run writes the pack and project config.{' '}
          <code className="font-mono text-sm">kizunasync deprovision</code> removes understood
          ledgered objects, not every base-pack object.
        </p>
        <ul className="text-site-muted mt-6 space-y-2 font-mono text-sm">
          <li>
            <span className="text-site-accent" aria-hidden="true">
              ›{' '}
            </span>
 no Kizuna account: the target remains your Supabase project
          </li>
          <li>
            <span className="text-site-accent" aria-hidden="true">
              ›{' '}
            </span>
            declared equality buckets select rows; RLS remains the authorization layer
          </li>
          <li>
            <span className="text-site-accent" aria-hidden="true">
              ›{' '}
            </span>
 npx kizunasync, pnpm dlx kizunasync, yarn dlx kizunasync, or bunx kizunasync in your Supabase app project
          </li>
        </ul>
      </RevealOnScroll>
      <RevealOnScroll className="min-w-0">
        <TerminalShowcase />
      </RevealOnScroll>
    </Section>
  )
}

function JourneyApiStep() {
  return (
    <Section
      id="api"
      bordered={false}
      className="journey-destination"
      containerClassName="grid items-center gap-10 lg:grid-cols-[1.15fr_0.85fr]"
    >
      <RevealOnScroll className="min-w-0 lg:order-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">
            {JOURNEY_STEPS[1].number} · {JOURNEY_STEPS[1].action}
          </p>
          <p className="text-site-faint font-mono text-xs">{JOURNEY_STEPS[1].section}</p>
        </div>
        <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          A scoped supabase-js-like local API.
        </h2>
        <p className="text-site-muted mt-3 leading-relaxed">
          A documented supabase-js-like subset reads local SQLite while offline.
          Unsupported constructs throw LOCAL_UNSUPPORTED according to the compatibility
          matrix; there is no silent network fallback.
        </p>
        <ul className="text-site-muted mt-6 space-y-2 font-mono text-sm">
          <li>
            <span className="text-site-accent" aria-hidden="true">
              ›{' '}
            </span>
 createKizunaSync(driver, remote, config): the network client is an explicit
            argument, never hidden
          </li>
          <li>
            <span className="text-site-accent" aria-hidden="true">
              ›{' '}
            </span>
            kizunasync.from(table).select() / .insert() / .update() / .delete(), plus
            kizunasync.on(handler) for engine events
          </li>
          <li>
            <span className="text-site-accent" aria-hidden="true">
              ›{' '}
            </span>
            <a href={`/docs/roadmap#${TANSTACK_ROADMAP_SLUG}`} className="text-site-accent hover:underline">
              a TanStack DB collection adapter
            </a>{' '}
            is on the roadmap
          </li>
        </ul>
      </RevealOnScroll>
      <RevealOnScroll className="min-w-0 lg:order-1">
        <CodePanel />
      </RevealOnScroll>
    </Section>
  )
}

function JourneyQuickstartStep() {
  return (
    <Section id="quickstart" bordered={false} className="journey-destination">
      <RevealOnScroll>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-site-accent font-mono text-xs tracking-wide uppercase">
            {JOURNEY_STEPS[2].number} · {JOURNEY_STEPS[2].action}
          </p>
          <p className="text-site-faint font-mono text-xs">{JOURNEY_STEPS[2].section}</p>
        </div>
        <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          One file wires it into your framework.
        </h2>
        <p className="text-site-muted mt-2">
          Each tab trims a working guide composition: a platform driver, your config and
          Supabase client, plus attachment ports where that example configures media.
        </p>
      </RevealOnScroll>

      <div id="demo" className="mt-8 min-w-0 scroll-mt-44">
        <RevealOnScroll>
          <QuickstartTabs />
        </RevealOnScroll>
      </div>
    </Section>
  )
}
