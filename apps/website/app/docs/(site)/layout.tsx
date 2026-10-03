import type { ReactNode } from 'react'
import { DocsSidebar } from '@/components/docs-sidebar'
import { DocsMobileBar } from '@/components/docs-mobile-bar'
import { DocsNavList } from '@/components/docs-nav-list'
import { getDocsNavEntries } from '@/lib/docs'

// MARK: - Site docs layout

export default function SiteDocsLayout({ children }: { children: ReactNode }) {
  const docs = getDocsNavEntries()
  const items = docs.map((entry) => ({ href: entry.href, title: entry.title }))

  return (
    <>
      <DocsMobileBar items={items}>
        <DocsNavList docs={docs} />
      </DocsMobileBar>
      <DocsSidebar>
        <DocsNavList docs={docs} />
      </DocsSidebar>
      {children}
    </>
  )
}
