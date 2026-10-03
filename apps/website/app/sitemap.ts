import type { MetadataRoute } from 'next'
import { DOCS } from '@/lib/docs-registry'
import { REFERENCE_LIBRARIES, referenceHref } from '@/lib/reference-registry'
import { SITE_URL } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const referenceRoutes = REFERENCE_LIBRARIES.flatMap((library) =>
    library.pages.map((page) => ({
      url: `${SITE_URL}${referenceHref(library.id, page.slug)}`,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  )

  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/compare`, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/docs`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE_URL}/docs/reference`, changeFrequency: 'weekly', priority: 0.85 },
    { url: `${SITE_URL}/agent-setup.md`, changeFrequency: 'weekly', priority: 0.85 },
    { url: `${SITE_URL}/feedback`, changeFrequency: 'monthly', priority: 0.5 },
    ...DOCS.map((doc) => ({
      url: `${SITE_URL}/docs/${doc.slug}`,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    ...referenceRoutes,
  ]
}
