/**
 * Spacing and radius scale, mirroring Tailwind v4's native scale. The web
 * keeps Tailwind's built-in `mt-<n>` / `gap-<n>` / `rounded-<name>` utilities.
 * React Native StyleSheets cannot read Tailwind's CSS variables, so this file
 * is their only source: the same numbers, by the same n×4px formula Tailwind
 * uses, keyed by the step numbers the apps reach for. `RADIUS` mirrors
 * Tailwind v4's default `--radius-sm/md/lg/xl` pixel values (compiled, not
 * from memory; see spacing.test.ts). `RADIUS.full` has no Tailwind equivalent
 * (`rounded-full` compiles to `calc(infinity * 1px)`, not a finite token), so
 * it uses a value large enough to round any element into a full pill
 * regardless of height.
 *
 * spacing.test.ts compiles a real Tailwind stylesheet and asserts every value
 * here against the compiled px, so this file cannot silently drift from the
 * web.
 */
export const SPACING = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
} as const

export const RADIUS = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  full: 9999,
} as const

export type TSpacingStep = keyof typeof SPACING
export type TRadiusStep = keyof typeof RADIUS
