import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DOCS, docsForNav, type IDocEntry, type IDocNavEntry } from './docs-registry'
import { headingIds, type IHeadingId } from './heading-ids'
import { findReferenceLibrary, findReferencePage, REFERENCE_LIBRARIES, referenceHref, referencePageFile, type TVersionSource } from './reference-registry'

// MARK: - Docs loading

export interface IHeading {
  depth: 2 | 3
  text: string
  id: string
}

interface IParsedDoc {
  content: string
  status?: string
  description?: string
}

/**
 * Resolved at runtime (next sets cwd to the app dir; in turbo runs it may be
 * the repo root), walking up to a Kizunasync-specific marker. KIZUNASYNC_REPO_ROOT wins
 * for out-of-tree builds. Computed lazily so the bundler never tries to
 * statically resolve a parent-relative URL.
 */
export function repoRoot(): string {
  const override = process.env.KIZUNASYNC_REPO_ROOT

  if (override !== undefined && override.length > 0) {
    return override
  }
  let dir = process.cwd()

  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'turbo.json')) && existsSync(join(dir, 'CONVENTIONS.md'))) {
      return dir
    }
    dir = dirname(dir)
  }
  return process.cwd()
}

export function getDoc(
  slug: string,
): (IDocEntry & IParsedDoc & { headings: IHeading[] }) | null {
  const entry = DOCS.find((doc) => doc.slug === slug)

  if (entry === undefined) {
    return null
  }
  const parsed = readDoc(entry)

  return { ...entry, ...parsed, headings: extractHeadings(parsed.content) }
}

export function getDocsNavEntries(): IDocNavEntry[] {
  const navDocs = docsForNav(DOCS)
  const clientLibraryEntries: IDocNavEntry[] = REFERENCE_LIBRARIES.map((library) => ({
    slug: `reference-${library.id}`,
    file: referencePageFile(library.id, 'introduction'),
    title: library.title,
    group: 'Reference',
    subgroup: 'Client libraries',
    description: library.description,
    href: referenceHref(library.id, 'introduction'),
    status: 'alpha',
  }))

  const regularEntries: IDocNavEntry[] = navDocs.map((entry) => {
    const parsed = readDoc(entry)

    return {
      ...entry,
      href: `/docs/${entry.slug}`,
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    }
  })

  const firstApiRefIndex = regularEntries.findIndex((doc) => doc.group === 'Reference')

  if (firstApiRefIndex >= 0) {
    return [
      ...regularEntries.slice(0, firstApiRefIndex),
      ...clientLibraryEntries,
      ...regularEntries.slice(firstApiRefIndex),
    ]
  }
  return [...regularEntries, ...clientLibraryEntries]
}

export function adjacentDocs(slug: string): { prev: IDocEntry | null; next: IDocEntry | null } {
  const nav = docsForNav(DOCS)
  const index = nav.findIndex((doc) => doc.slug === slug)

  return {
    prev: index > 0 ? (nav[index - 1] ?? null) : null,
    next: index >= 0 && index < nav.length - 1 ? (nav[index + 1] ?? null) : null,
  }
}

export function readLibraryVersion(source: TVersionSource): string {
  const root = repoRoot()

  if (source.kind === 'package-json') {
    const pkg = JSON.parse(readFileSync(join(root, source.path), 'utf8')) as { version?: string }

    return pkg.version ?? '0.0.0'
  }
  const toml = readFileSync(join(root, source.path), 'utf8')
  const workspaceMatch = /\[workspace\.package\][\s\S]*?^\s*version\s*=\s*"([^"]+)"/m.exec(toml)

  return workspaceMatch?.[1] ?? '0.0.0'
}

export function getReferenceDoc(
  libraryId: string,
  slug: string,
):
  | ({
      library: NonNullable<ReturnType<typeof findReferenceLibrary>>
      page: NonNullable<ReturnType<typeof findReferencePage>>['page']
      file: string
      content: string
      headings: IHeading[]
      version: string
    } & Pick<IParsedDoc, 'description' | 'status'>)
  | null {
  const found = findReferencePage(libraryId, slug)

  if (found === undefined) {
    return null
  }
  const { library, page } = found
  const file = referencePageFile(libraryId, slug)
  const parsed = parseDocSource(readFileSync(join(repoRoot(), file), 'utf8'))

  return {
    library,
    page,
    file,
    content: parsed.content,
    headings: extractHeadings(parsed.content),
    version: readLibraryVersion(library.versionSource),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
  }
}

export function adjacentReferencePages(
  libraryId: string,
  slug: string,
): {
  prev: { href: string; title: string } | null
  next: { href: string; title: string } | null
} {
  const library = findReferenceLibrary(libraryId)

  if (library === undefined) {
    return { prev: null, next: null }
  }
  const index = library.pages.findIndex((entry) => entry.slug === slug)
  const prevPage = index > 0 ? library.pages[index - 1] : undefined
  const nextPage =
    index >= 0 && index < library.pages.length - 1 ? library.pages[index + 1] : undefined

  return {
    prev:
      prevPage !== undefined
        ? { href: referenceHref(libraryId, prevPage.slug), title: prevPage.title }
        : null,
    next:
      nextPage !== undefined
        ? { href: referenceHref(libraryId, nextPage.slug), title: nextPage.title }
        : null,
  }
}

// MARK: - Helpers

function readDoc(entry: IDocEntry): IParsedDoc {
  return parseDocSource(readFileSync(join(repoRoot(), entry.file), 'utf8'))
}

/** Trims a frontmatter capture group and treats an empty result the same as no match at all. */
function trimmedFrontmatterValue(match: RegExpExecArray | null): string | undefined {
  const value = match?.[1]?.trim()

  return value === undefined || value.length === 0 ? undefined : value
}

export function parseDocSource(source: string): IParsedDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)

  if (match === null) {
    return { content: source }
  }

  const frontmatter = match[1] ?? ''
  const status = trimmedFrontmatterValue(/^status:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/im.exec(frontmatter))?.toLowerCase()
  const description = trimmedFrontmatterValue(
    /^description:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/im.exec(frontmatter),
  )

  return {
    content: source.slice(match[0].length),
    ...(status === undefined ? {} : { status }),
    ...(description === undefined ? {} : { description }),
  }
}

function extractHeadings(markdown: string): IHeading[] {
  return headingIds(markdown)
    .filter((heading): heading is IHeadingId & { depth: 2 | 3 } => heading.depth === 2 || heading.depth === 3)
    .map(({ depth, text, id }) => ({ depth, text, id }))
}
