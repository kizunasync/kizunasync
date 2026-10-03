'use client'

import Link from 'next/link'
import { useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { DocsNavSectionHeading } from '@/components/docs-nav-section-heading'
import { FIXED_REFERENCE_SLUGS, REFERENCE_LIBRARIES, REFERENCE_SECTIONS, referenceHref, type IReferenceLibrary } from '@/lib/reference-registry'
import { useNavChromeHeight } from '@/lib/use-nav-chrome-height'

// MARK: - ReferenceNavList

export function ReferenceNavList({
  library,
  onNavigate,
}: {
  library: IReferenceLibrary
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const router = useRouter()
  const navRef = useRef<HTMLElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)

  useNavChromeHeight(navRef, chromeRef)

  const fixedPages = FIXED_REFERENCE_SLUGS.map((slug) =>
    library.pages.find((page) => page.slug === slug),
  ).filter((page) => page !== undefined)

  const sectionedPages = REFERENCE_SECTIONS.map((section) => ({
    section,
    pages: library.pages.filter(
      (page) =>
        page.section === section &&
        !FIXED_REFERENCE_SLUGS.includes(page.slug as (typeof FIXED_REFERENCE_SLUGS)[number]),
    ),
  })).filter((group) => group.pages.length > 0)

  const onLibraryChange = (nextLibraryId: string) => {
    const nextLibrary = REFERENCE_LIBRARIES.find((entry) => entry.id === nextLibraryId)

    if (nextLibrary === undefined) {
      return
    }
    const currentSlug = pathname.split('/').pop() ?? 'introduction'
    const samePage = nextLibrary.pages.find((page) => page.slug === currentSlug)

    router.push(referenceHref(nextLibraryId, samePage?.slug ?? 'introduction'))
    onNavigate?.()
  }

  const sectionHeadingOffset = 'top-[var(--reference-nav-chrome-h,0px)]'

  return (
    <nav ref={navRef} aria-label="Client library reference" className="space-y-6">
      <div
        ref={chromeRef}
        className="border-site-border/40 bg-site-background/95 sticky top-0 z-20 -mr-2 space-y-6 border-b pb-3 pr-2 backdrop-blur-sm"
      >
        <Link
          href="/docs"
          onClick={onNavigate}
          className="text-site-muted hover:text-site-text block text-sm transition-colors"
        >
          ← All docs
        </Link>

        <ReferenceLibrarySwitcher library={library} onLibraryChange={onLibraryChange} />
      </div>

      <ReferenceNavSection
        heading="Reference"
        pages={fixedPages}
        libraryId={library.id}
        pathname={pathname}
        onNavigate={onNavigate}
        stickyOffset={sectionHeadingOffset}
      />

      {sectionedPages.map(({ section, pages }) => (
        <ReferenceNavSection
          key={section}
          heading={section}
          pages={pages}
          libraryId={library.id}
          pathname={pathname}
          onNavigate={onNavigate}
          stickyOffset={sectionHeadingOffset}
        />
      ))}
    </nav>
  )
}

function ReferenceLibrarySwitcher({
  library,
  onLibraryChange,
}: {
  library: IReferenceLibrary
  onLibraryChange: (nextLibraryId: string) => void
}) {
  return (
    <div>
      <label htmlFor="reference-library" className="text-site-faint font-mono text-xs tracking-wide uppercase">
        Client library
      </label>
      <select
        id="reference-library"
        value={library.id}
        onChange={(event) => onLibraryChange(event.target.value)}
        className="border-site-border bg-site-surface text-site-text mt-2 w-full rounded-md border px-2.5 py-1.5 text-sm"
      >
        {REFERENCE_LIBRARIES.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.title}
          </option>
        ))}
      </select>
    </div>
  )
}

function ReferenceNavSection({
  heading,
  pages,
  libraryId,
  pathname,
  onNavigate,
  stickyOffset,
}: {
  heading: string
  pages: IReferenceLibrary['pages']
  libraryId: string
  pathname: string
  onNavigate?: () => void
  stickyOffset: string
}) {
  return (
    <div>
      <DocsNavSectionHeading stickyOffset={stickyOffset}>{heading}</DocsNavSectionHeading>
      <ul className="mt-2 space-y-0.5">
        {pages.map((page) => (
          <ReferenceNavItem
            key={page.slug}
            href={referenceHref(libraryId, page.slug)}
            title={page.title}
            active={pathname === referenceHref(libraryId, page.slug)}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </div>
  )
}

function ReferenceNavItem({
  href,
  title,
  active,
  onNavigate,
}: {
  href: string
  title: string
  active: boolean
  onNavigate?: () => void
}) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        className={`block rounded-md px-2.5 py-1.5 text-sm transition-colors ${
          active
            ? 'bg-site-surface text-site-accent-bright font-medium'
            : 'text-site-muted hover:text-site-text'
        }`}
      >
        {title}
      </Link>
    </li>
  )
}
