import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocMarkdown } from '@/components/doc-markdown'
import { DocsToc } from '@/components/docs-toc'
import { DocEyebrow } from '@/components/doc-eyebrow'
import { DocPageFooter } from '@/components/doc-page-footer'
import { REFERENCE_LIBRARIES, referenceEditUrl, referenceHref } from '@/lib/reference-registry'
import { adjacentReferencePages, getReferenceDoc } from '@/lib/docs'

// MARK: - Reference page

export function generateStaticParams() {
  return REFERENCE_LIBRARIES.flatMap((library) =>
    library.pages.map((page) => ({
      library: library.id,
      page: page.slug,
    })),
  )
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ library: string; page: string }>
}): Promise<Metadata> {
  const { library: libraryId, page: slug } = await params
  const doc = getReferenceDoc(libraryId, slug)

  return doc === null
    ? {}
    : {
        title: `${doc.page.title} · ${doc.library.title} · Docs`,
        description: doc.description ?? doc.library.description,
      }
}

export default async function ReferencePage({
  params,
}: {
  params: Promise<{ library: string; page: string }>
}) {
  const { library: libraryId, page: slug } = await params
  const doc = getReferenceDoc(libraryId, slug)

  if (doc === null) {
    notFound()
  }
  const { prev, next } = adjacentReferencePages(libraryId, slug)

  return (
    <>
      <main id="main-content" className="min-w-0">
        <DocEyebrow
          crumbs={[
            { href: '/docs', label: 'Docs' },
            { href: '/docs/reference', label: 'Client library reference' },
            { href: referenceHref(libraryId, 'introduction'), label: doc.library.title },
          ]}
          meta={`v${doc.version}`}
        />
        <DocMarkdown content={doc.content} sourceFile={doc.file} />
        <DocPageFooter
          prev={prev}
          next={next}
          editUrl={referenceEditUrl(libraryId, slug)}
        />
      </main>
      <DocsToc headings={doc.headings} />
    </>
  )
}
