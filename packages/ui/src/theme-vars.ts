import { KSYNC_PALETTE } from './palette'

/**
 * CSS custom properties the web examples style against, sourced from
 * {@link KSYNC_PALETTE} so examples do not hand-copy a brand hex. Each example
 * applies the map to `:root` before mount; a plain stylesheet (no Tailwind)
 * then reaches the same colors React Native reads from the palette object.
 * Seven values are not palette entries and live in `effects.css`: the
 * background gradient's tint, the two online-pulse stops, the raised edge,
 * the skeleton shimmer, and the two shadow colors. Radii and the shadow
 * composites that consume those colors stay in each example's `globals.css`.
 *
 * `--signal-emerald` / `--signal-gray` / `--on-signal` exist for the HeroUI
 * alias block. An example that does not alias HeroUI never reads them.
 */
export const KSYNC_THEME_VARS: Readonly<Record<string, string>> = {
  '--sumi': KSYNC_PALETTE.background,
  '--sumi-raised': KSYNC_PALETTE.surface,
  '--sumi-elevated': KSYNC_PALETTE.surfaceElevated,
  '--sumi-sunken': KSYNC_PALETTE.sunken,
  '--panel': KSYNC_PALETTE.panel,
  '--border': KSYNC_PALETTE.border,
  '--border-strong': KSYNC_PALETTE.borderStrong,
  '--hairline': KSYNC_PALETTE.hairline,
  '--text': KSYNC_PALETTE.text,
  '--muted': KSYNC_PALETTE.muted,
  '--faint': KSYNC_PALETTE.faint,
  '--vermilion': KSYNC_PALETTE.accent,
  '--vermilion-bright': KSYNC_PALETTE.accentBright,
  '--vermilion-soft': KSYNC_PALETTE.accentSoft,
  '--vermilion-ring': KSYNC_PALETTE.accentRing,
  '--on-vermilion': KSYNC_PALETTE.accentForeground,
  '--online': KSYNC_PALETTE.success,
  '--signal-emerald': KSYNC_PALETTE.success,
  '--signal-amber': KSYNC_PALETTE.warning,
  '--signal-red': KSYNC_PALETTE.danger,
  '--signal-sky': KSYNC_PALETTE.info,
  '--signal-gray': KSYNC_PALETTE.faint,
  '--on-signal': KSYNC_PALETTE.accentForeground,
  '--scrim': KSYNC_PALETTE.scrim,
}
