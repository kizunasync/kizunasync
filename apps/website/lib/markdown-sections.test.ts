import { describe, expect, test } from 'bun:test'
import { markdownSections } from '@/lib/markdown-sections'

const sample = [
  '# Comparison',
  '',
  'An intro that belongs to no section.',
  '',
  '## PowerSync',
  '',
  'A [sync service](https://docs.powersync.com) with client SDKs.',
  '',
  '### How Kizuna differs',
  '',
  '- No service runs beside Supabase.',
  '',
  '## A typical custom implementation',
  '',
  'Built on `supabase-js`.',
  '',
  '### How Kizuna differs',
  '',
  '- Each mutation gets a verdict.',
  '',
  '## Related pages',
  '',
  '- [Architecture](./architecture.md)',
].join('\n')

describe('markdownSections', () => {
  test('splits at H2 headings and keeps the H3 children in each body', () => {
    const sections = markdownSections(sample, 2)

    expect(sections.map(({ heading, id }) => ({ heading, id }))).toEqual([
      { heading: 'PowerSync', id: 'powersync' },
      { heading: 'A typical custom implementation', id: 'a-typical-custom-implementation' },
    ])
    expect(sections[0]?.bodyMarkdown).toBe('A [sync service](https://docs.powersync.com) with client SDKs.\n\n### How Kizuna differs\n\n- No service runs beside Supabase.')
    expect(sections[1]?.bodyMarkdown).toBe('Built on `supabase-js`.\n\n### How Kizuna differs\n\n- Each mutation gets a verdict.')
  })

  test('ends an H3 section at the next H2 and numbers repeated ids like the rendered anchors', () => {
    const sections = markdownSections(sample, 3)

    expect(sections.map(({ id, bodyMarkdown }) => ({ id, bodyMarkdown }))).toEqual([
      { id: 'how-kizuna-differs', bodyMarkdown: '- No service runs beside Supabase.' },
      { id: 'how-kizuna-differs-1', bodyMarkdown: '- Each mutation gets a verdict.' },
    ])
  })

  test('drops a closing section and every section after it', () => {
    const markdown = ['## Kept', '', 'Body.', '', '## Next steps', '', '- More.', '', '## After', '', 'Ignored.'].join('\n')

    expect(markdownSections(markdown, 2).map((section) => section.id)).toEqual(['kept'])
  })

  test('reports the nearest shallower heading as parentHeading, and omits it when none exists', () => {
    const sections = markdownSections(sample, 3)

    expect(sections.map((section) => section.parentHeading)).toEqual(['PowerSync', 'A typical custom implementation'])
    expect('parentHeading' in (markdownSections('### Orphan\n\nText.', 3)[0] ?? {})).toBe(false)
  })

  test('returns an empty body for a heading followed directly by another', () => {
    const [first] = markdownSections('## Empty\n\n## Full\n\nText.', 2)

    expect(first?.bodyMarkdown).toBe('')
    expect(first?.bodyText).toBe('')
  })
})

describe('markdownSections bodyText', () => {
  const textOf = (body: string): string | undefined => markdownSections(`## Section\n\n${body}`, 2)[0]?.bodyText

  test('joins block-level nodes with one space', () => {
    expect(textOf('A.\n\nB.')).toBe('A. B.')
  })

  test('keeps link text and drops the URL', () => {
    expect(textOf('See [Offline writes](../sync/offline-writes.md).')).toBe('See Offline writes.')
  })

  test('keeps inline code and drops image alt text', () => {
    expect(textOf('Call `increment` here ![diagram](./flow.svg) now.')).toBe('Call increment here now.')
  })

  test('turns a hard line break into a space', () => {
    expect(textOf('First line  \nsecond line\\\nthird line.')).toBe('First line second line third line.')
  })

  test('separates list items and nested headings, collapsing whitespace', () => {
    expect(textOf('Intro\nwraps.\n\n### Choose it when\n\n- First.\n- Second.')).toBe('Intro wraps. Choose it when First. Second.')
  })
})
