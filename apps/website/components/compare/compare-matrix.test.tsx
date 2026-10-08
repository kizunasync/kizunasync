import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompareMatrix } from '@/components/compare/compare-matrix'
import { COMPARE_GROUPS } from '@/components/compare/compare-matrix.data'

const html = renderToStaticMarkup(<CompareMatrix />)
const firstRow = COMPARE_GROUPS[0]!.rows[0]!

/** React escapes text in markup, and the definitions carry apostrophes. */
const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')

describe('CompareMatrix markup', () => {
  test('renders the legend with all four states', () => {
    for (const label of ['Supported', 'Partly supported', 'Not supported', 'Not documented']) {
      expect(html).toContain(label)
    }
  })

  test('puts every capability definition and cell detail in the server HTML', () => {
    expect(html).toContain(escapeHtml(firstRow.definition))
    expect(html).toContain(escapeHtml(firstRow.cells.powersync.detail))
  })

  test('wires each trigger to its panel', () => {
    expect(html).toMatch(/aria-controls="tip-no-third-party-servers-kizuna"/)
    expect(html).toMatch(/id="tip-no-third-party-servers-kizuna"[^>]*hidden/)
  })

  test('marks the Kizuna column for highlight and every column for filtering', () => {
    expect(html).toContain('data-col="kizuna"')
    expect(html).toContain('data-col="firestore"')
  })

  test('renders no filter chips before hydration', () => {
    expect(html).not.toContain('data-compare-filter')
  })
})
