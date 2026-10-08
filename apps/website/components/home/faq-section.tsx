import { DocMarkdown } from '@/components/doc-markdown'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { Section } from '@/components/section'
import { faqDoc, homeFaq } from '@/lib/faq'

export function FaqSection() {
  const entries = homeFaq()
  const sourceFile = faqDoc().file

  return (
    <Section id="faq" bordered={false}>
      <RevealOnScroll>
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">FAQ</h2>
      </RevealOnScroll>
      <RevealOnScroll staggerChildren className="mt-8 space-y-3">
        {entries.map((entry) => (
          <details
            key={entry.id}
            // A reader can open a question before hydration ends; the browser's `open` state wins.
            suppressHydrationWarning
            className="border-site-border bg-site-surface/50 group overflow-hidden rounded-xl border"
          >
            <summary className="flex cursor-pointer list-none items-start gap-2 px-5 py-4 font-medium select-none [&::-webkit-details-marker]:hidden">
              <span className="text-site-accent inline-block shrink-0 transition-transform group-open:rotate-90">
                ›
              </span>
              <h3 className="font-medium">{entry.question}</h3>
            </summary>
            <div className="text-site-muted px-5 pb-4 text-sm leading-relaxed">
              <DocMarkdown content={entry.answerMarkdown} sourceFile={sourceFile} variant="card" />
            </div>
          </details>
        ))}
      </RevealOnScroll>
      <a href="/docs/faq" className="text-site-accent mt-6 inline-block text-sm hover:underline">
        Read the full FAQ →
      </a>
    </Section>
  )
}
