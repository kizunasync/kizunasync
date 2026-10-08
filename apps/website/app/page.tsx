import type { Metadata } from 'next'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'
import { SectionHashSpy } from '@/components/section-hash-spy'
import { HeroSection } from '@/components/home/hero-section'
import { AtAGlanceSection } from '@/components/home/at-a-glance-section'
import { JourneySection } from '@/components/home/journey-section'
import { FeaturesSection } from '@/components/home/features-section'
import { KeyNumbersSection } from '@/components/home/key-numbers-section'
import { WhySection } from '@/components/home/why-section'
import { HonestySection } from '@/components/home/honesty-section'
import { FaqSection } from '@/components/home/faq-section'
import { jsonLdScript } from '@/lib/faq'
import { pageMetadata } from '@/lib/page-metadata'
import { DESCRIPTION, GITHUB_URL, SITE_FULL_NAME, SITE_MODIFIED, SITE_PUBLISHED, SITE_URL, TAGLINE } from '@/lib/site'

export const metadata: Metadata = pageMetadata({
  title: `${SITE_FULL_NAME} · ${TAGLINE}`,
  description: DESCRIPTION,
  path: '/',
  hasOwnImage: true,
})

// MARK: - Landing page

export default function HomePage() {
  return (
    <>
      <JsonLd />
      <SiteHeader />
      <SectionHashSpy />
      <main id="main-content">
        <HeroSection />
        <AtAGlanceSection />
        <JourneySection />
        <FeaturesSection />
        <KeyNumbersSection />
        <WhySection />
        <HonestySection />
        <FaqSection />
      </main>
      <SiteFooter />
    </>
  )
}

// MARK: - JSON-LD

function JsonLd() {
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#org`,
        name: SITE_FULL_NAME,
        url: SITE_URL,
        sameAs: [GITHUB_URL],
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: SITE_FULL_NAME,
        url: SITE_URL,
        datePublished: SITE_PUBLISHED,
        dateModified: SITE_MODIFIED,
        publisher: { '@id': `${SITE_URL}/#org` },
      },
      {
        '@type': 'SoftwareApplication',
 name: 'Kizuna Sync » offline-first sync for Supabase',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'iOS, Android, Web',
        softwareVersion: 'Alpha',
        url: SITE_URL,
        datePublished: SITE_PUBLISHED,
        dateModified: SITE_MODIFIED,
        publisher: { '@id': `${SITE_URL}/#org` },
      },
    ],
  }

  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(graph) }} />
  )
}
