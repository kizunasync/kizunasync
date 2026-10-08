import type { Metadata } from 'next'
import Link from 'next/link'
import { CompareAlternativeSection } from '@/components/compare/compare-alternative-section'
import { CompareIntro } from '@/components/compare/compare-intro'
import { CompareMatrix } from '@/components/compare/compare-matrix'
import { ComparePrimarySources } from '@/components/compare/compare-primary-sources'
import { SectionHashSpy } from '@/components/section-hash-spy'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'
import { readAlternatives } from '@/lib/comparison'
import { COMPARE_DESCRIPTION } from '@/lib/compare-copy'
import { pageMetadata } from '@/lib/page-metadata'

export const metadata: Metadata = pageMetadata({
  title: 'Compare',
  description: COMPARE_DESCRIPTION,
  path: '/compare',
  hasOwnImage: true,
})

const INTRO_SECTION_ID = 'intro'

// MARK: - Page

export default function ComparePage() {
  return (
    <>
      <SiteHeader />
      <SectionHashSpy bareSectionId={INTRO_SECTION_ID} />
      <main id="main-content" className="site-container pt-28 pb-20">
        <section id={INTRO_SECTION_ID}>
          <CompareIntro />
        </section>
        <section id="matrix" className="mt-16 scroll-mt-20 sm:mt-20">
          <h2 className="text-site-accent font-mono text-xs tracking-wide uppercase">Matrix</h2>
          <div className="mt-3">
            <CompareMatrix />
          </div>
        </section>
        {readAlternatives().map((section) => (
          <CompareAlternativeSection key={section.id} section={section} />
        ))}
        <Link
          href="/docs/comparison-with-alternatives"
          className="text-site-muted hover:text-site-accent mt-16 inline-flex min-h-11 w-fit touch-manipulation items-center gap-2 transition-colors"
        >
          Read the comparison in the docs
          <span aria-hidden="true">→</span>
        </Link>
        <ComparePrimarySources />
      </main>
      <SiteFooter />
    </>
  )
}
