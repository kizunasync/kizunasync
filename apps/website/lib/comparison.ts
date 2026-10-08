import { COMPARE_PRODUCTS } from '@/components/compare/compare-matrix.data'
import { getDoc } from './docs'
import { markdownSections, type IMarkdownSection } from './markdown-sections'

export const CUSTOM_SECTION_ID = 'a-typical-custom-implementation'

/** The docs page section id of every alternative in the matrix; the page's other H2s (the matrix pointer) are not alternatives. */
const ALTERNATIVE_SECTION_IDS: ReadonlySet<string> = new Set(
  COMPARE_PRODUCTS.filter((product) => product.id !== 'kizuna').map((product) => (product.id === 'custom' ? CUSTOM_SECTION_ID : product.id)),
)

/** The docs comparison page from the registry; server-only (reads the repository file). */
export function comparisonDoc(): NonNullable<ReturnType<typeof getDoc>> {
  const doc = getDoc('comparison-with-alternatives')

  if (doc === null) {
    throw new Error('The docs registry has no "comparison-with-alternatives" page')
  }
  return doc
}

/** The per-product sections of the docs comparison page, in docs order; server-only (reads the repository file). */
export function readAlternatives(): IMarkdownSection[] {
  return markdownSections(comparisonDoc().content, 2).filter((section) => ALTERNATIVE_SECTION_IDS.has(section.id))
}
