import { KSYNC_PALETTE } from '@kizunasync/ui'

/**
 * The example's semantic palette, derived from the shared KSYNC_PALETTE so the
 * Sumi & Vermilion hex values live in one place (@kizunasync/ui) instead of being
 * re-typed here. `focusRing` is the brand's bright accent; `scrim` is the modal
 * backdrop overlay token from the shared palette.
 */
export const EThemeColor = {
  background: KSYNC_PALETTE.background,
  surface: KSYNC_PALETTE.surface,
  surfaceElevated: KSYNC_PALETTE.surfaceElevated,
  panel: KSYNC_PALETTE.panel,
  border: KSYNC_PALETTE.border,
  borderStrong: KSYNC_PALETTE.borderStrong,
  hairline: KSYNC_PALETTE.hairline,
  panelBorder: KSYNC_PALETTE.panelBorder,
  text: KSYNC_PALETTE.text,
  muted: KSYNC_PALETTE.muted,
  faint: KSYNC_PALETTE.faint,
  accent: KSYNC_PALETTE.accent,
  accentSoft: KSYNC_PALETTE.accentSoft,
  accentForeground: KSYNC_PALETTE.accentForeground,
  focusRing: KSYNC_PALETTE.accentBright,
  success: KSYNC_PALETTE.success,
  warning: KSYNC_PALETTE.warning,
  info: KSYNC_PALETTE.info,
  danger: KSYNC_PALETTE.danger,
  scrim: KSYNC_PALETTE.scrim,
} as const
