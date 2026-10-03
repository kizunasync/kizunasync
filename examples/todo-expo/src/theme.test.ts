/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { KSYNC_PALETTE } from '@kizunasync/ui/palette'

/**
 * global.css is the second encoding of the palette.
 *
 * React Native reads `KSYNC_PALETTE` (hex, via src/theme.ts). heroui-native
 * reads CSS custom properties, which no JavaScript value can reach, so the
 * brand colors are written twice. This test re-reads global.css and asserts
 * every heroui token still carries the palette value it was mapped from. A
 * palette change that fails here was not mirrored.
 *
 * global.css overrides heroui in two places, and both are swept below:
 *   - the `@variant dark` block, which restates the semantic palette;
 *   - a `@theme inline static` block, which pins the interaction-state colors
 *     heroui derives with `color-mix()`. Those derived tokens are read back
 *     into JavaScript by `useThemeColor`, and on web that read is
 *     `getComputedStyle().getPropertyValue()`, which returns a custom property
 *     unevaluated; heroui then receives the literal `color-mix(…)` text and
 *     falls back to black. Pinning them to concrete palette values keeps the
 *     press states on brand, not black.
 *
 * Tokens not asserted are heroui's own structural defaults (radii, shadows,
 * opacity); those stay the library's to decide.
 */
// MARK: - Palette ↔ global.css drift test

const GLOBAL_CSS = new URL('../global.css', import.meta.url).pathname

/**
 * Every heroui custom property this app overrides, and the palette entry it
 * must equal. Adding an override without adding it here fails the sweep below.
 */
const TOKEN_SOURCE: Record<string, string> = {
  '--background': KSYNC_PALETTE.background,
  '--foreground': KSYNC_PALETTE.text,
  '--surface': KSYNC_PALETTE.surface,
  '--surface-foreground': KSYNC_PALETTE.text,
  '--surface-secondary': KSYNC_PALETTE.surfaceElevated,
  '--surface-secondary-foreground': KSYNC_PALETTE.text,
  '--surface-tertiary': KSYNC_PALETTE.panel,
  '--surface-tertiary-foreground': KSYNC_PALETTE.text,
  '--overlay': KSYNC_PALETTE.surfaceElevated,
  '--overlay-foreground': KSYNC_PALETTE.text,
  '--backdrop': KSYNC_PALETTE.scrim,
  '--muted': KSYNC_PALETTE.muted,
  '--default': KSYNC_PALETTE.surfaceElevated,
  '--default-foreground': KSYNC_PALETTE.text,
  '--accent': KSYNC_PALETTE.accent,
  '--accent-foreground': KSYNC_PALETTE.accentForeground,
  '--field-background': KSYNC_PALETTE.surface,
  '--field-foreground': KSYNC_PALETTE.text,
  '--field-placeholder': KSYNC_PALETTE.faint,
  '--field-border': KSYNC_PALETTE.border,
  '--success': KSYNC_PALETTE.success,
  '--success-foreground': KSYNC_PALETTE.accentForeground,
  '--warning': KSYNC_PALETTE.warning,
  '--warning-foreground': KSYNC_PALETTE.accentForeground,
  '--danger': KSYNC_PALETTE.danger,
  '--danger-foreground': KSYNC_PALETTE.accentForeground,
  '--segment': KSYNC_PALETTE.surfaceElevated,
  '--segment-foreground': KSYNC_PALETTE.text,
  '--border': KSYNC_PALETTE.border,
  '--separator': KSYNC_PALETTE.hairline,
  '--focus': KSYNC_PALETTE.accentBright,
  '--link': KSYNC_PALETTE.accent,
}

/**
 * The interaction-state tokens heroui derives with `color-mix()`, pinned to the
 * palette member that plays the same role. The red family has one lifted
 * member (`accentBright`), so both the accent and the danger press states
 * resolve to it.
 */
const STATIC_TOKEN_SOURCE: Record<string, string> = {
  '--color-accent-hover': KSYNC_PALETTE.accentBright,
  '--color-default-hover': KSYNC_PALETTE.border,
  '--color-danger-hover': KSYNC_PALETTE.accentBright,
  '--color-danger-soft-hover': KSYNC_PALETTE.accentSoft,
  '--color-warning-hover': KSYNC_PALETTE.gold,
}

function readTokens(from: string, to?: string): Map<string, string> {
  const css = readFileSync(GLOBAL_CSS, 'utf8')
  const start = css.indexOf(from)

  expect(start).toBeGreaterThan(-1)
  const end = to === undefined ? css.length : css.indexOf(to)

  expect(end).toBeGreaterThan(start)
  const tokens = new Map<string, string>()

  for (const match of css.slice(start, end).matchAll(/(--[a-z-]+):\s*([^;]+);/g)) {
    const [, name, value] = match

    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim())
    }
  }
  return tokens
}

/** The `@variant dark` block's declarations, by property name. */
function readDarkTokens(): Map<string, string> {
  return readTokens('@variant dark')
}

/** The `@theme inline static` block's declarations, by property name. */
function readStaticTokens(): Map<string, string> {
  return readTokens('@theme inline static', '@layer theme')
}

describe('global.css mirrors the Kizuna palette', () => {
  test('every mapped heroui token carries its palette value', () => {
    const tokens = readDarkTokens()

    for (const [name, expected] of Object.entries(TOKEN_SOURCE)) {
      expect(`${name}: ${tokens.get(name) ?? 'MISSING'}`).toBe(`${name}: ${expected}`)
    }
  })

  test('no override escapes the mapping', () => {
    const unmapped = [...readDarkTokens().keys()].filter((name) => TOKEN_SOURCE[name] === undefined)

    expect(unmapped).toEqual([])
  })

  test('every pinned interaction-state token carries its palette value', () => {
    const tokens = readStaticTokens()

    for (const [name, expected] of Object.entries(STATIC_TOKEN_SOURCE)) {
      expect(`${name}: ${tokens.get(name) ?? 'MISSING'}`).toBe(`${name}: ${expected}`)
    }
  })

  test('no pinned token escapes the mapping', () => {
    const unmapped = [...readStaticTokens().keys()].filter((name) => STATIC_TOKEN_SOURCE[name] === undefined)

    expect(unmapped).toEqual([])
  })
})
