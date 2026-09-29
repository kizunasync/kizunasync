import { HONESTY } from '@/components/home/honesty.data'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { Section } from '@/components/section'

export function HonestySection() {
  return (
    <Section
      id="honesty"
      bordered={false}
      containerClassName="max-w-3xl pb-0 sm:pb-0"
    >
      <RevealOnScroll>
        <p className="text-site-accent font-mono text-xs tracking-wide uppercase">
          Radical honesty
        </p>
        <h2 className="font-display mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
          When NOT to use Kizuna
        </h2>
        <p className="text-site-muted mt-2">
          These are the current wrong-tool boundaries, with the relevant alternative class
          named.
        </p>
        <p className="text-site-muted mt-2">
          Trusting a sync engine requires being able to read it. Kizuna's answer is
          readable SQL provisioned into your own project, a public wire protocol, and a
          conformance corpus, so the inspector and the transcripts let you verify every
          claim on this page yourself.
        </p>
      </RevealOnScroll>
      <RevealOnScroll staggerChildren className="mt-8 space-y-3">
        {HONESTY.map((row) => (
          <div
            key={row.need}
            className="border-site-border bg-site-surface/50 rounded-xl border p-5"
          >
            <p className="font-medium">{row.need}</p>
            <p className="text-site-muted mt-1.5 text-sm">
              <span className="text-site-accent" aria-hidden="true">
                →{' '}
              </span>
              {row.answer}
            </p>
          </div>
        ))}
      </RevealOnScroll>
    </Section>
  )
}
