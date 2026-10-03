import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'
import { HomeHashSpy } from '@/components/home-hash-spy'
import { HeroSection } from '@/components/home/hero-section'
import { AtAGlanceSection } from '@/components/home/at-a-glance-section'
import { JourneySection } from '@/components/home/journey-section'
import { FeaturesSection } from '@/components/home/features-section'
import { KeyNumbersSection } from '@/components/home/key-numbers-section'
import { WhySection } from '@/components/home/why-section'
import { HonestySection } from '@/components/home/honesty-section'
import { FaqSection } from '@/components/home/faq-section'
import { FAQ } from '@/components/home/faq.data'
import { GITHUB_URL, SITE_FULL_NAME, SITE_MODIFIED, SITE_PUBLISHED, SITE_URL } from '@/lib/site'

// MARK: - Landing page

export default function HomePage() {
  return (
    <>
      <JsonLd />
      <SiteHeader />
      <HomeHashSpy />
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
      {
        '@type': 'FAQPage',
        mainEntity: FAQ.map((entry) => ({
          '@type': 'Question',
          name: entry.question,
          acceptedAnswer: { '@type': 'Answer', text: entry.answer },
        })),
      },
    ],
  }

  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }} />
  )
}
