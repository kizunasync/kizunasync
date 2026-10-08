import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DocMarkdown } from '@/components/doc-markdown'
import { SITE_URL } from '@/lib/site'

const renderMarkdown = async (content: string): Promise<string> => renderToStaticMarkup(await DocMarkdown({ content }))

describe('DocMarkdown card variant', () => {
  const content = '### How Kizuna differs\n\n- No service.'

  test('keeps slugged, anchored headings on a docs page', async () => {
    const html = await renderMarkdown(content)

    expect(html).toContain('<div class="docs-prose">')
    expect(html).toContain('<h3 id="how-kizuna-differs">')
    expect(html).toContain('docs-anchor')
  })

  test('renders headings without ids or anchors inside a card', async () => {
    const html = renderToStaticMarkup(await DocMarkdown({ content, variant: 'card' }))

    expect(html).toContain('<div class="docs-prose docs-prose-card">')
    expect(html).toContain('<h3>How Kizuna differs</h3>')
    expect(html).not.toContain('id="')
    expect(html).not.toContain('docs-anchor')
  })
})

describe('DocMarkdown links', () => {
  test('renders a link to the site origin as an in-site path in the same tab', async () => {
    const html = await renderMarkdown(`[matrix](${SITE_URL}/compare#electric)`)

    expect(html).toContain('href="/compare#electric"')
    expect(html).not.toContain('target="_blank"')
  })

  test('keeps the query string of a site link', async () => {
    const html = await renderMarkdown(`[docs](${SITE_URL}/docs?tab=vue#setup)`)

    expect(html).toContain('href="/docs?tab=vue#setup"')
  })

  test('opens a link to another origin in a new tab', async () => {
    const html = await renderMarkdown('[Electric](https://electric.ax/docs)')

    expect(html).toContain('href="https://electric.ax/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test('never leaks the markdown node into a link attribute', async () => {
    const html = await renderMarkdown(`## Title\n\n[site](${SITE_URL}/compare) [vendor](https://electric.ax/docs) [docs](./offline-writes.md)`)

    expect(html).not.toContain('node=')
  })

  test('treats a host that only starts with the site host as external', async () => {
    const lookalike = `${new URL(SITE_URL).protocol}//${new URL(SITE_URL).host}.example.com/compare`
    const html = await renderMarkdown(`[lookalike](${lookalike})`)

    expect(html).toContain(`href="${lookalike}"`)
    expect(html).toContain('target="_blank"')
  })
})
