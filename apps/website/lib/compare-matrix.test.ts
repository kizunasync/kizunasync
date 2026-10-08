import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { COMPARE_GROUPS, COMPARE_PRODUCTS, ESupport, productSources } from '@/components/compare/compare-matrix.data'
import { SITE_FOOTER_COLUMNS } from '@/components/site-footer.data'
import { parseDocSource, repoRoot } from '@/lib/docs'
import { DOCS } from '@/lib/docs-registry'
import { headingIds } from '@/lib/heading-ids'
import { findReferencePage } from '@/lib/reference-registry'

const rows = COMPARE_GROUPS.flatMap((group) => group.rows)
const productIds = COMPARE_PRODUCTS.map((product) => product.id)

function resolvesToRegisteredPage(path: string): boolean {
  const reference = /^\/docs\/reference\/([a-z]+)\/([a-z0-9-]+)$/.exec(path)

  if (reference?.[1] !== undefined && reference[2] !== undefined) {
    return findReferencePage(reference[1], reference[2]) !== undefined
  }
  return DOCS.some((doc) => `/docs/${doc.slug}` === path)
}

describe('compare matrix data', () => {
  test('has the agreed products in order, Kizuna first and the custom build last', () => {
    expect(productIds).toEqual(['kizuna', 'powersync', 'electric', 'zero', 'legend-state', 'rxdb', 'watermelondb', 'tinybase', 'triplit', 'instantdb', 'firestore', 'custom'])
  })

  test('has 29 rows with unique ids, a label, and a definition', () => {
    expect(rows).toHaveLength(29)
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)

    for (const row of rows) {
      expect(row.label.length).toBeGreaterThan(0)
      expect(row.definition.length).toBeGreaterThan(20)
    }
  })

  test('starts with no third-party servers', () => {
    expect(COMPARE_GROUPS[0]?.rows[0]?.id).toBe('no-third-party-servers')
  })

  test('fills every cell with a known value and a detail', () => {
    for (const row of rows) {
      for (const id of productIds) {
        const cell = row.cells[id]

        expect(Object.values(ESupport)).toContain(cell.value)
        expect(cell.detail.length).toBeGreaterThan(10)
      }
    }
  })

  test('backs every documented third-party cell with an official https source', () => {
    for (const row of rows) {
      for (const id of productIds) {
        const cell = row.cells[id]

        if (id === 'kizuna' || id === 'custom' || cell.value === ESupport.unknown) {
          continue
        }
        expect(cell.sourceUrl?.startsWith('https://')).toBe(true)
      }
    }
  })

  test('backs every Kizuna cell with a registered docs or reference page', () => {
    for (const row of rows) {
      const sourceUrl = row.cells.kizuna.sourceUrl

      expect(sourceUrl?.startsWith('/docs/')).toBe(true)
      expect(resolvesToRegisteredPage(sourceUrl ?? '')).toBe(true)
    }
  })

  test('lists each product source once', () => {
    const sources = productSources('powersync')

    expect(new Set(sources).size).toBe(sources.length)
  })
})

describe('compare footer links', () => {
  test('land on an H2 heading of the comparison docs page', () => {
    const page = parseDocSource(readFileSync(join(repoRoot(), 'docs/resources/comparison-with-alternatives.md'), 'utf8')).content
    const sectionIds = headingIds(page).filter((heading) => heading.depth === 2).map((heading) => heading.id)
    const links = SITE_FOOTER_COLUMNS.flatMap((column) => column.links).filter((link) => link.href.startsWith('/compare#'))

    expect(links).toHaveLength(11)

    for (const link of links) {
      expect(sectionIds).toContain(link.href.slice('/compare#'.length))
    }
  })
})
