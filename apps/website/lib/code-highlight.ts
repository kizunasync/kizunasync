import { createHighlighter, type Highlighter, type ThemeRegistrationRaw } from 'shiki'

// MARK: - Site code theme

/**
 * A Shiki TextMate theme built directly from the site's own design tokens
 * (packages/ui theme.css) via `var(--color-site-*)` references: Shiki treats
 * theme colors as opaque strings through its whole token pipeline, so the
 * custom properties resolve at paint time instead of duplicating a hex copy.
 * Keywords land in the brand orange, strings gold, function calls green,
 * numbers the deeper red-orange, comments faint italic. Mirrors the hand-built
 * CodePanel.
 */
const SITE_DARK: ThemeRegistrationRaw = {
  name: 'site-dark',
  type: 'dark',
  colors: {
    'editor.background': 'var(--color-site-surface)',
    'editor.foreground': 'var(--color-site-text)',
  },
  settings: [
    { settings: { foreground: 'var(--color-site-text)' } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: 'var(--color-site-faint)', fontStyle: 'italic' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'constant.other.symbol'],
      settings: { foreground: 'var(--color-site-gold)' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'variable.language',
        'keyword.operator.new',
        'keyword.operator.expression',
      ],
      settings: { foreground: 'var(--color-site-accent-bright)' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'],
      settings: { foreground: 'var(--color-site-ok)' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.language.boolean', 'support.constant'],
      settings: { foreground: 'var(--color-site-accent)' },
    },
    {
      scope: [
        'keyword.operator',
        'punctuation',
        'meta.brace',
        'punctuation.separator',
        'punctuation.terminator',
        'punctuation.accessor',
      ],
      settings: { foreground: 'var(--color-site-muted)' },
    },
    {
      scope: [
        'entity.name.type',
        'support.type',
        'entity.name.class',
        'support.class',
        'entity.name.tag',
        'entity.other.attribute-name',
      ],
      settings: { foreground: 'var(--color-site-text)' }, // keep types calm
    },
    {
      scope: ['variable', 'variable.other', 'meta.definition.variable', 'variable.parameter'],
      settings: { foreground: 'var(--color-site-text)' },
    },
  ],
}

export const CODE_THEME = 'site-dark'

const LANGS = ['ts', 'tsx', 'js', 'jsx', 'vue', 'json', 'jsonc', 'bash', 'sh', 'shell', 'sql', 'html', 'css', 'diff', 'yaml', 'swift', 'kotlin']

// MARK: - Memoized highlighter

/**
 * One highlighter for the whole build/server: createHighlighter is async (it
 * loads grammars + the theme once); codeToHtml is then synchronous, so the
 * markdown `pre` renderer can stay sync inside react-markdown.
 */
let instance: Promise<Highlighter> | null = null

export function getHighlighter(): Promise<Highlighter> {
  instance ??= createHighlighter({ themes: [SITE_DARK], langs: LANGS })

  return instance
}

/**
 * Resolve a fence's language to a loaded grammar. Untagged fences default to
 * TypeScript (the docs are JS/TS-first); a tagged-but-unloaded language renders
 * as plain text rather than mis-highlighted as another language.
 */
export function resolveLang(requested: string | undefined, highlighter: Highlighter): string {
  if (requested === undefined || requested === '') {
    return 'ts'
  }
  return highlighter.getLoadedLanguages().includes(requested) ? requested : 'txt'
}
