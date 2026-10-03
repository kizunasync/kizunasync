import type { Metadata } from 'next'
import { CompareHeadToHeads } from '@/components/compare/compare-head-to-heads'
import { CompareIntro } from '@/components/compare/compare-intro'
import { CompareMatrix } from '@/components/compare/compare-matrix'
import { ComparePrimarySources } from '@/components/compare/compare-primary-sources'
import { SiteFooter } from '@/components/site-footer'
import { SiteHeader } from '@/components/site-header'

export const metadata: Metadata = {
  title: 'Compare',
  description:
    'An architecture-focused comparison of Kizuna, PowerSync, WatermelonDB, RxDB, Electric, TinyBase, and a custom sync implementation, linked to current primary sources.',
}

// MARK: - Page

export default function ComparePage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" className="site-container pt-28 pb-20">
        <CompareIntro />
        <CompareMatrix />
        <CompareHeadToHeads />
        <ComparePrimarySources />
      </main>
      <SiteFooter />
    </>
  )
}
