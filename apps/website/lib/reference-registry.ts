import { GITHUB_URL } from './site'
import { SWIFT } from './reference/swift'
import { KOTLIN } from './reference/kotlin'
import { JAVASCRIPT } from './reference/javascript'
import { REACT } from './reference/react'
import { VUE } from './reference/vue'
import { EXPO } from './reference/expo'

// MARK: - Types

export const REFERENCE_SECTIONS = [
  'Config',
  'Database',
  'Sync',
  'Auth session',
  'Rejections',
  'Overwrites',
  'Events',
  'Attachments',
  'Scheduler',
  'Supabase adapters',
  'Browser driver',
  'Inspector',
  'Hooks',
  'Composables',
  'Drivers',
  'Files',
  'Engine',
  'Types',
] as const
type TReferenceSection = (typeof REFERENCE_SECTIONS)[number]

export const REFERENCE_PAGE_KINDS = [
  'introduction',
  'installing',
  'initializing',
  'method',
  'guide',
  'type',
] as const
type TReferencePageKind = (typeof REFERENCE_PAGE_KINDS)[number]

interface IReferencePage {
  slug: string
  title: string
  kind: TReferencePageKind
  section?: TReferenceSection
}

export type TVersionSource =
  | { kind: 'package-json'; path: string }
  | { kind: 'cargo-workspace'; path: string }

export interface IReferenceLibrary {
  id: string
  title: string
  packageName: string
  description: string

  /** Fence languages a method page may use for its examples. */
  codeLangs: readonly string[]

  versionSource: TVersionSource
  supabaseReferenceUrl: string
  pages: IReferencePage[]
}

// MARK: - Registry

export const REFERENCE_LIBRARIES: IReferenceLibrary[] = [
  SWIFT,
  KOTLIN,
  JAVASCRIPT,
  REACT,
  VUE,
  EXPO,
]

export const FIXED_REFERENCE_SLUGS = ['introduction', 'installing', 'initializing'] as const

/** Slugs that must exist in swift, kotlin, and javascript so the language switcher keeps the page. */
export const SHARED_REFERENCE_SLUGS = [
  ...FIXED_REFERENCE_SLUGS,
  'fetch-data',
  'insert-data',
  'update-data',
  'delete-data',
  'using-filters',
  'using-transforms',
  'sync',
  'pull-once',
  'push-once',
  'set-bucket',
  'checkpoint',
  'outbox-depth',
  'reset',
  'set-access-token',
  'rejections',
  'dismiss-rejection',
  'overwrites',
  'dismiss-overwrite',
  'on',
  'from-file',
  'resolve-download',
  'get-status',
  'attachment-retry',
  'attachment-cancel',
  'attachment-remove',
  'inspector',
  'watch',
  'vacuum',
  'types',
] as const

// MARK: - Helpers

export function referencePageFile(libraryId: string, slug: string): string {
  return `docs/reference/${libraryId}/${slug}.md`
}

export function referenceHref(libraryId: string, slug: string): string {
  return `/docs/reference/${libraryId}/${slug}`
}

export function findReferenceLibrary(libraryId: string): IReferenceLibrary | undefined {
  return REFERENCE_LIBRARIES.find((library) => library.id === libraryId)
}

export function findReferencePage(
  libraryId: string,
  slug: string,
): { library: IReferenceLibrary; page: IReferencePage } | undefined {
  const library = findReferenceLibrary(libraryId)
  const page = library?.pages.find((entry) => entry.slug === slug)

  return library !== undefined && page !== undefined ? { library, page } : undefined
}

/** Maps a repository Markdown path to its in-site route, or undefined when the file is not rendered. */
export function referenceRouteForFile(file: string): string | undefined {
  const match = /^docs\/reference\/([a-z]+)\/([a-z0-9-]+)\.md$/.exec(file)

  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined
  }
  return findReferencePage(match[1], match[2]) === undefined
    ? undefined
    : referenceHref(match[1], match[2])
}

export function referenceEditUrl(libraryId: string, slug: string): string {
  return `${GITHUB_URL}/edit/main/${referencePageFile(libraryId, slug)}`
}
