/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { headingIds } from './heading-ids'

describe('headingIds', () => {
  test('strips inline-code punctuation the same way the renderer does', () => {
    const [heading] = headingIds('## Per-table fields (`tables.<name>.*`)')

    expect(heading?.id).toBe('per-table-fields-tablesname')
  })

  test('keeps underscores from inline code in the id', () => {
    const [heading] = headingIds('## `kizunasync._conflict_journal`')

    expect(heading?.id).toBe('kizunasync_conflict_journal')
    expect(heading?.id).toMatch(/_/)
  })

  test('keeps underscores from plain heading text in the id', () => {
    const [heading] = headingIds('## BUCKET_UNSET')

    expect(heading?.id).toBe('bucket_unset')
  })

  test('deduplicates repeated headings the way github-slugger does', () => {
    const headings = headingIds('## Notes\n\n## Notes')

    expect(headings.map((heading) => heading.id)).toEqual(['notes', 'notes-1'])
  })

  test('ignores a heading-shaped line inside a fenced code block', () => {
    const headings = headingIds('```\n## Hidden\n```')

    expect(headings).toEqual([])
  })

  test('resolves link text and id for a heading that is itself a link', () => {
    const [heading] = headingIds('## [Sync](./sync.md) options')

    expect(heading?.text).toBe('Sync options')
    expect(heading?.id).toBe('sync-options')
  })

  test('reports the correct depth for h1 through h3', () => {
    const headings = headingIds('# H1\n\n## H2\n\n### H3')

    expect(headings.map((heading) => heading.depth)).toEqual([1, 2, 3])
  })
})
