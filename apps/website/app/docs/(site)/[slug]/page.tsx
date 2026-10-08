import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocMarkdown } from '@/components/doc-markdown'
import { DocsToc } from '@/components/docs-toc'
import { DocEyebrow } from '@/components/doc-eyebrow'
import { DocPageFooter } from '@/components/doc-page-footer'
import { DOCS } from '@/lib/docs-registry'
import { adjacentDocs, getDoc } from '@/lib/docs'
import { faqJsonLd, jsonLdScript, readFaq } from '@/lib/faq'
import { pageMetadata } from '@/lib/page-metadata'
import { GITHUB_URL } from '@/lib/site'

// MARK: - Doc page: breadcrumb, content, scrollspy TOC, prev/next, edit link.

export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const doc = DOCS.find((entry) => entry.slug === slug)

  return doc === undefined
    ? {}
    : pageMetadata({ title: `${doc.title} · Docs`, description: doc.description, path: `/docs/${slug}`, hasOwnImage: true })
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const doc = getDoc(slug)

  if (doc === null) {
    notFound()
  }
  const { prev, next } = adjacentDocs(slug)

  return (
    <>
      {slug === 'faq' && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript({ '@context': 'https://schema.org', ...faqJsonLd(readFaq()) }) }}
        />
      )}
      <main id="main-content" className="min-w-0">
        <DocEyebrow
          crumbs={[
            { href: '/docs', label: 'Docs' },
            { label: doc.group },
          ]}
        />
        <DocMarkdown content={doc.content} sourceFile={doc.file} />
        <DocPageFooter
          prev={prev !== null ? { href: `/docs/${prev.slug}`, title: prev.title } : null}
          next={next !== null ? { href: `/docs/${next.slug}`, title: next.title } : null}
          editUrl={`${GITHUB_URL}/edit/main/${doc.file}`}
        />
      </main>
      <DocsToc headings={doc.headings.filter((heading) => heading.depth === 2)} />
    </>
  )
}
