import { describe, expect, test } from 'bun:test'
import { CODE_THEME, getHighlighter } from './code-highlight'

describe('code-highlight theme', () => {
  test('CODE_THEME uses the site-* naming register, not a bare kizuna key', () => {
    expect(CODE_THEME).toBe('site-dark')
  })

  test('the highlighter resolves the registered theme by name and emits site-color spans', async () => {
    const highlighter = await getHighlighter()
    const html = highlighter.codeToHtml('const x = 1', { lang: 'ts', theme: CODE_THEME })

    expect(html).toContain('var(--color-site-')
  })

  test('the highlighter loads Swift and Kotlin grammars', async () => {
    const highlighter = await getHighlighter()

    expect(highlighter.getLoadedLanguages()).toContain('swift')
    expect(highlighter.getLoadedLanguages()).toContain('kotlin')
  })
})
