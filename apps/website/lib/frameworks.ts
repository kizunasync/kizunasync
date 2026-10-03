import { ICONS } from '@kizunasync/ui'

// MARK: - Framework catalog

/**
 * Drives the hero typewriter AND the sync scene (the SQLite node tints to the
 * active framework). Glyphs are Symbols Nerd Font codepoints (verified against
 * glyphnames.json v3.4.0); Expo has no official NF glyph, so md-triangle_outline
 * reads as its caret mark.
 */
export interface IFramework {
  id: string
  label: string
  color: string
  glyph: string
  href: string
}

export const FRAMEWORKS: IFramework[] = [
  {
    id: 'expo',
    label: 'Expo',
    color: 'var(--color-brand-expo)',
    glyph: '\u{F0537}',
    href: 'https://expo.dev/',
  },
  {
    id: 'react-native',
    label: 'React Native',
    color: 'var(--color-brand-react)',
    glyph: '\u{E7BA}',
    href: 'https://reactnative.dev/',
  },
  {
    id: 'react',
    label: 'React',
    color: 'var(--color-brand-react)',
    glyph: '\u{E7BA}',
    href: 'https://react.dev/',
  },
  {
    id: 'vue',
    label: 'Vue',
    color: 'var(--color-brand-vue)',
    glyph: '\u{F0844}',
    href: 'https://vuejs.org/',
  },
  {
    id: 'swift',
    label: 'Swift',
    color: 'var(--color-brand-swift)',
    glyph: '\u{E755}', // nf-dev-swift
    href: 'https://www.swift.org/',
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    color: 'var(--color-brand-kotlin)',
    glyph: '\u{E634}', // nf-seti-kotlin
    href: 'https://kotlinlang.org/',
  },
  {
    id: 'vanilla',
    label: 'Vanilla',
    color: 'var(--color-brand-javascript)',
    glyph: '\u{E781}', // nf-dev-javascript
    href: '/docs/vanilla-js',
  },
]

export const SUPABASE_GLYPH = '\u{E8B6}' // nf-dev-supabase
export const SUPABASE_GREEN = 'var(--color-brand-supabase)'
export const GLYPH = { database: ICONS.database, cloud: ICONS.cloud, cloudOff: ICONS.cloudOff } as const
