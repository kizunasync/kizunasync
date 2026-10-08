import { DocMarkdown } from '@/components/doc-markdown'
import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { comparisonDoc, CUSTOM_SECTION_ID } from '@/lib/comparison'
import type { IMarkdownSection } from '@/lib/markdown-sections'

function resolveSectionLabels(section: IMarkdownSection): { eyebrow: string; title: string } {
  if (section.id === CUSTOM_SECTION_ID) {
    return { eyebrow: 'Custom implementation', title: 'Kizuna vs a typical custom implementation' }
  }
  return { eyebrow: section.heading, title: `Kizuna vs ${section.heading}` }
}

/** One product's comparison, rendered from its section of the docs comparison page. */
export function CompareAlternativeSection({ section }: { section: IMarkdownSection }) {
  const { eyebrow, title } = resolveSectionLabels(section)

  return (
    <section id={section.id} className="mt-16 scroll-mt-20 sm:mt-20">
      <RevealOnScroll>
        <p className="text-site-accent font-mono text-xs tracking-wide uppercase">{eyebrow}</p>
        <article className="border-site-border bg-site-surface/40 mt-3 rounded-2xl border p-6 sm:p-8">
          <h2 className="font-display text-xl font-bold tracking-tight sm:text-2xl">{title}</h2>
          <DocMarkdown content={section.bodyMarkdown} sourceFile={comparisonDoc().file} variant="card" />
        </article>
      </RevealOnScroll>
    </section>
  )
}
