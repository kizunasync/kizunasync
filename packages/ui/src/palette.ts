/**
 * Kizuna "Sumi & Vermilion" palette: the JS source of truth for React Native.
 * The website, sync-inspector, and demo apps consume theme.css via Tailwind.
 * The React and Vue examples apply KSYNC_THEME_VARS from this palette to
 * `:root` instead (see theme-vars.ts). React Native (the Expo example) cannot
 * read CSS, so it imports these hex values directly. The two CSS encodings
 * share this file's brand intent but use different token names: theme.css
 * uses `raised` where this file uses `surfaceElevated`, and `ok` where this
 * file uses `success`. Keep the semantic intent in sync; do not align names
 * across the boundary without updating every consumer. Vermilion is RED
 * (#e5484d), never orange.
 */
export const KSYNC_PALETTE = {
  background: '#15141f',
  surface: '#1d1c29',
  surfaceElevated: '#26252f',
  sunken: '#100f18',
  panel: '#191824',
  border: '#34323f',
  borderStrong: '#45424f',
  hairline: '#2a2935',
  panelBorder: '#4a3a3f',
  text: '#ecebf0',
  muted: '#a7a4b2',
  faint: '#76727f',
  accent: '#e5484d',
  accentBright: '#f0676b',
  accentDim: '#b03b3f',
  accentSoft: 'rgba(229, 72, 77, 0.14)',
  accentRing: 'rgba(240, 103, 107, 0.45)',
  accentForeground: '#ffffff',
  success: '#46a758',
  warning: '#d99528',
  gold: '#e0b341',
  // Traffic-light signal hues for op badges (insert→success, update→warning).
  info: '#3b9eff',
  danger: '#f43a57',
  scrim: 'rgba(10, 9, 15, 0.66)',
} as const

export type TKizunaSyncPalette = typeof KSYNC_PALETTE
