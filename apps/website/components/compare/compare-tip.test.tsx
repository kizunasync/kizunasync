import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompareMatrix } from '@/components/compare/compare-matrix'
import { TipPinnedContext, useTipPinned } from '@/components/compare/compare-tip'

function Probe() {
  return <a href="https://example.com" tabIndex={useTipPinned() ? 0 : -1}>Source</a>
}

describe('CompareTip tab order', () => {
  test('keeps every Source link out of the Tab order while no tip is pinned', () => {
    const links = renderToStaticMarkup(<CompareMatrix />).match(/<a [^>]*>Source<\/a>/g) ?? []

    expect(links.length).toBeGreaterThan(0)
    expect(links.every((link) => link.includes('tabindex="-1"'))).toBe(true)
  })

  test('makes tip content tabbable only when pinned', () => {
    expect(renderToStaticMarkup(<Probe />)).toContain('tabindex="-1"')
    expect(renderToStaticMarkup(<TipPinnedContext.Provider value><Probe /></TipPinnedContext.Provider>)).toContain('tabindex="0"')
  })
})
