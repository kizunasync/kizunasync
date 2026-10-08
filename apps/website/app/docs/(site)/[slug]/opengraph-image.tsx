import { notFound } from 'next/navigation'
import { DOCS } from '@/lib/docs-registry'
import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from '@/lib/og-image'

export const alt = 'Kizuna Sync documentation'
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }))
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = DOCS.find((entry) => entry.slug === slug)

  if (doc === undefined) {
    notFound()
  }

  return renderOgImage({ eyebrow: doc.group, title: doc.title, description: doc.description })
}
