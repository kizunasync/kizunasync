import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { DocsSidebar } from '@/components/docs-sidebar'
import { DocsMobileBar } from '@/components/docs-mobile-bar'
import { ReferenceNavList } from '@/components/reference-nav-list'
import { findReferenceLibrary, referenceHref } from '@/lib/reference-registry'

// MARK: - Reference library layout

export default async function ReferenceLibraryLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ library: string }>
}) {
  const { library: libraryId } = await params
  const library = findReferenceLibrary(libraryId)

  if (library === undefined) {
    notFound()
  }

  const items = library.pages.map((page) => ({
    href: referenceHref(libraryId, page.slug),
    title: page.title,
  }))

  return (
    <>
      <DocsMobileBar items={items}>
        <ReferenceNavList library={library} />
      </DocsMobileBar>
      <DocsSidebar>
        <ReferenceNavList library={library} />
      </DocsSidebar>
      {children}
    </>
  )
}
