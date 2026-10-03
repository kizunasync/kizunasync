/**
 * Named Symbols Nerd Font glyph catalog: the single owner of codepoint
 * literals so no app hand-types a `\u{...}` escape twice. Every codepoint
 * must resolve to the exact glyph its name claims in the bundled font
 * (apps/website/public/fonts/SymbolsNerdFont-Regular.ttf); a codepoint that
 * exists in the font but names the wrong glyph silently renders the wrong
 * icon. Per-framework brand glyphs (FRAMEWORKS[].glyph, SUPABASE_GLYPH) stay
 * local to apps/website/lib/frameworks.ts: they are framework identity, not
 * a reusable semantic icon.
 */
export const ICONS = {
  database: '\u{EACE}', // cod-database
  cloud: '\u{F0163}', // md-cloud_outline
  cloudOff: '\u{F0164}', // md-cloud_off_outline
  databaseSync: '\u{F0CFF}', // md-database_sync
  imageMultiple: '\u{F02F9}', // md-image_multiple
  shieldLock: '\u{F099D}', // md-shield_lock
  graveStone: '\u{F0BA2}', // md-grave_stone
  lightningBolt: '\u{F140B}', // md-lightning_bolt
  languageTypescript: '\u{F06E6}', // md-language_typescript
  terminal: '\u{EA85}', // cod-terminal
  serverOff: '\u{F048F}', // md-server_off
  speedometer: '\u{F04C5}', // md-speedometer
  deleteSoft: '\u{F1557}', // md-delete_clock_outline
  deleteHard: '\u{F05E8}', // md-delete_forever
  check: '\u{F012C}', // md-check
  restore: '\u{F099B}', // md-restore
  sync: '\u{F04E6}', // md-sync
  github: '\u{F09B}', // fa-github
} as const

export type TIconName = keyof typeof ICONS
