# Kizuna Sync. Brand book

絆 (kizuna) is Japanese for *the bonds that tie people together*. The product keeps offline-first data in sync across devices and people; the name is the promise. The shorthand is kizunasync (lowercase wordmark, package + CLI namespace).

## The mark

The mark is the single glyph 絆, outlined from Shippori Mincho SemiBold. The glyph is always vermilion `#e5484d`, on sumi `#15141f` (dark) or the palette's off-white `#ecebf0` (light). Both come with square or rounded corners. Use the larger-glyph favicon for compact surfaces and inspect the export at its final display size.

- Lockup. `logo.svg`: the mark + the Kizuna Sync wordmark ("Sync" in muted).
- Mark only. `mark-dark-square.svg`, `mark-dark-rounded.svg`, `mark-light-square.svg`, and `mark-light-rounded.svg`: the four 1024 × 1024 app/social variants. `mark.svg` is identical to the dark rounded version.
- Favicon. `favicon.svg` (sumi field, dark mode) and `favicon-light.svg` (off-white field, light mode).

Centering: center the visible glyph contours, not the font's advance width or baseline. The four 1024 variants share identical paths, centered at `(512, 512)`, with equal left/right and top/bottom margins. Corner radius is `0` for square fields and `224` for rounded fields. The favicon and the mark inside the horizontal lockup are independently centered on their fields.

Clearspace: keep padding ≥ the height of the 絆 stroke around the lockup. **Don't:** recolor the glyph, stretch it, add shadows/outlines, or place it on a busy/low-contrast background. Use the light variant for a light field; retain the same vermilion glyph in both themes.

## Color. "Sumi & Vermilion"

Canonical tokens live in `packages/ui/src/theme.css` (OKLCH, for Tailwind/DOM) and `packages/ui/src/palette.ts` (hex, for React Native). These express the same brand intent; the paired hex and OKLCH entries below are semantic counterparts, not exact numeric conversions. Standalone SVG assets bake in the existing hex palette so they export without a stylesheet. Never hand-pick colors outside the tokens.

| Role | Hex | OKLCH | Use |
|------|-----|-------|-----|
| background (sumi) | `#15141f` | `oklch(0.14 0.012 285)` | app/page base |
| surface | `#1d1c29` | `oklch(0.175 0.013 285)` | cards |
| raised | `#26252f` | `oklch(0.225 0.015 285)` | elevated rows |
| border | `#34323f` | `oklch(0.29 0.015 285)` | hairlines/borders |
| text | `#ecebf0` | `oklch(0.93 0.005 285)` | primary text |
| muted | `#a7a4b2` | `oklch(0.64 0.012 285)` | secondary text |
| faint | `#76727f` | `oklch(0.46 0.012 285)` | tertiary/labels |
| **accent (vermilion)** | `#e5484d` | `oklch(0.62 0.21 29)` | primary action, the 絆 glyph |
| accent bright | `#f0676b` | `oklch(0.71 0.19 33)` | hover/focus ring |
| accent foreground | `#ffffff` | `oklch(0.98 0.008 29)` | text on vermilion |
| success | `#46a758` | `oklch(0.78 0.17 150)` | online/synced |

> Vermilion is red (`#e5484d`, hue ≈ 29), never orange.

## Type

Sans is Inter, used for UI, wordmark, and headings. Mono is JetBrains Mono, used for code, CLI, and inline `code`. The kanji mark uses Shippori Mincho SemiBold 3.110, with SVG contours outlined and no font fallback. The horizontal wordmark is outlined from Inter 24pt Bold 4.001. Both source fonts use the SIL OFL 1.1 license.

Constants: `packages/ui/src/fonts.ts` (`kizunasyncFonts`).

## Assets in this folder

| File | What |
|------|------|
| `mark-dark-square.svg` / `mark-dark-rounded.svg` | Vermilion 絆 on sumi, 1024 canvas, with same-name PNG/JPG exports |
| `mark-light-square.svg` / `mark-light-rounded.svg` | Vermilion 絆 on off-white, 1024 canvas, with same-name PNG/JPG exports |
| `mark.svg` | Same as `mark-dark-rounded.svg`, retained as the default |
| `logo.svg` | Horizontal lockup with outlined lettering |
| `favicon.svg` | Centered favicon with a larger glyph, 64 canvas, sumi field |
| `favicon-light.svg` | Same geometry as `favicon.svg`, off-white field, for a light-mode tab |
| `favicon.png`, `logo.png`, `logo-1024.png`, `logo.jpg`, `logo-1024.jpg` | Regenerated compatibility exports: favicon at 256 px, dark rounded mark at 512/1024 px |
| `favicon-dark-32.png`, `favicon-dark-180.png` | Regenerated from `favicon.svg`, 32 and 180 px |
| `favicon-light-32.png`, `favicon-light-180.png` | Regenerated from `favicon-light.svg`, 32 and 180 px |
| `apple-touch-icon.png` | Regenerated from `mark-dark-square.svg`, 180 px |

The SVGs are the source of truth; rasters are generated from them. Rounded PNGs have transparent corners. Rounded JPGs have a contrasting outer background from the palette: off-white for dark marks, sumi for light marks. See `README.md` for export settings.
