import { FAQ } from '@/components/home/faq.data'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { Section } from '@/components/section'

export function FaqSection() {
  return (
    <Section id="faq" bordered={false} containerClassName="max-w-3xl">
      <RevealOnScroll>
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">FAQ</h2>
      </RevealOnScroll>
      <RevealOnScroll staggerChildren className="mt-8 space-y-3">
        {FAQ.map((entry) => (
          <details
            key={entry.question}
            className="border-site-border bg-site-surface/50 group overflow-hidden rounded-xl border"
          >
            <summary className="block cursor-pointer list-none px-5 py-4 font-medium select-none [&::-webkit-details-marker]:hidden">
              <span className="text-site-accent mr-2 inline-block transition-transform group-open:rotate-90">
                ›
              </span>
              <h3 className="inline font-medium">{entry.question}</h3>
            </summary>
            <p className="text-site-muted px-5 pb-4 text-sm leading-relaxed">
              {entry.answer}
            </p>
          </details>
        ))}
      </RevealOnScroll>
    </Section>
  )
}
