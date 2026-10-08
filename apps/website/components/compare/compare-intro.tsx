import { RevealOnScroll } from '@/components/motion/reveal-on-scroll'
import { CompareResearchDate } from '@/components/compare/compare-research-date'
import { COMPARE_TITLE } from '@/lib/compare-copy'
import { GITHUB_URL } from '@/lib/site'

export function CompareIntro() {
  return (
    <RevealOnScroll>
      <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {COMPARE_TITLE}
      </h1>
      <p className="text-site-muted mt-4 leading-relaxed">
        This page compares Kizuna with other offline sync products and with a sync layer a team builds itself, from the
        point of view of a team whose app already runs on Supabase. The matrix puts their capabilities side by side, and
        the sections below it explain how Kizuna differs from each product and when that product fits better. Facts about
        the other products come from their official sources as read on <CompareResearchDate />, and every source is listed
        under{' '}
        <a href="#primary-sources" className="text-site-accent hover:underline">
          primary sources
        </a>
        . Prices and benchmarks are out of scope. If a fact is wrong or out of date,{' '}
        <a
          href={`${GITHUB_URL}/issues`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-site-accent hover:underline"
        >
          open an issue
        </a>{' '}
        with a link to the page that shows the current behavior.
      </p>
    </RevealOnScroll>
  )
}
