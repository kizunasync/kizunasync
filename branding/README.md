<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">branding</span>
</h1>

Brand assets for Kizuna Sync. See [`BRANDBOOK.md`](./BRANDBOOK.md) for color, type, and usage.

The SVGs are the source of truth. All lettering is outlined, so rendering and centering do not depend on installed fonts.

## Files

The four mark variants contain only 絆 on a 1024 × 1024 field:

| Theme | Square corners | Rounded corners | Colors |
| --- | --- | --- | --- |
| Dark | [`mark-dark-square.svg`](./mark-dark-square.svg) | [`mark-dark-rounded.svg`](./mark-dark-rounded.svg) | Vermilion `#e5484d` on sumi `#15141f` |
| Light | [`mark-light-square.svg`](./mark-light-square.svg) | [`mark-light-rounded.svg`](./mark-light-rounded.svg) | Vermilion `#e5484d` on `#ecebf0` |

- [`mark.svg`](./mark.svg): identical to `mark-dark-rounded.svg`, default app/social mark
- [`logo.svg`](./logo.svg): horizontal lockup with centered mark and outlined Inter wordmark
- [`favicon.svg`](./favicon.svg): 64 × 64 dark rounded mark for compact use, sumi field
- [`favicon-light.svg`](./favicon-light.svg): same geometry as `favicon.svg`, off-white field for a light-mode tab

The four variants share one glyph path. Visible bounds are `x=238.4…785.6`, `y=230.3…793.7`, centered at `(512, 512)`. Rounded fields have radius `224` with transparent outer corners. Square fields fill the canvas.

Outlines were produced with FontTools from Shippori Mincho SemiBold 3.110 (絆) and Inter 24pt Bold 4.001 (wordmark), both SIL OFL 1.1. Fonts are not embedded. The files hold an accessible title, a background rectangle, and filled paths, with no CSS, external references, gradients, or rasters.

## Exporting JPG and PNG

Each mark variant has a same-name PNG and JPG at 1024 × 1024. Compatibility exports: `logo.png` / `logo.jpg` at 512 × 512, `logo-1024.png` / `logo-1024.jpg` at 1024 × 1024, and `favicon.png` at 256 × 256. The `logo` rasters use the dark rounded mark, not the horizontal `logo.svg` lockup.

Each web app serves `favicon.svg` and `favicon-light.svg` directly plus PNG fallbacks: `favicon-dark-32.png` / `favicon-dark-180.png` from `favicon.svg`, `favicon-light-32.png` / `favicon-light-180.png` from `favicon-light.svg`, and `apple-touch-icon.png` at 180 × 180 from `mark-dark-square.svg`. Apps copy these files into their own `public` directory; each copy stays byte-identical to its branding source.

Regenerate the four PNG variants from the repository root:

```sh
rsvg-convert -w 1024 -h 1024 branding/mark-dark-square.svg -o branding/mark-dark-square.png
rsvg-convert -w 1024 -h 1024 branding/mark-dark-rounded.svg -o branding/mark-dark-rounded.png
rsvg-convert -w 1024 -h 1024 branding/mark-light-square.svg -o branding/mark-light-square.png
rsvg-convert -w 1024 -h 1024 branding/mark-light-rounded.svg -o branding/mark-light-rounded.png
```

Regenerate the favicon and apple-touch-icon exports:

```sh
rsvg-convert -w 32 -h 32 branding/favicon.svg -o branding/favicon-dark-32.png
rsvg-convert -w 180 -h 180 branding/favicon.svg -o branding/favicon-dark-180.png
rsvg-convert -w 32 -h 32 branding/favicon-light.svg -o branding/favicon-light-32.png
rsvg-convert -w 180 -h 180 branding/favicon-light.svg -o branding/favicon-light-180.png
rsvg-convert -w 180 -h 180 branding/mark-dark-square.svg -o branding/apple-touch-icon.png
```

PNG keeps transparent corners on rounded variants. JPEG has no transparency: dark rounded JPGs use `#ecebf0` outside the round, light rounded JPGs use sumi `#15141f`. Use PNG when the destination must show through the corners.

Example dark rounded JPG from its PNG:

```sh
magick branding/mark-dark-rounded.png -background '#ecebf0' -alpha remove -alpha off -colorspace sRGB -sampling-factor 4:4:4 -quality 98 -strip branding/mark-dark-rounded.jpg
```

## Related

- [`BRANDBOOK.md`](./BRANDBOOK.md)
- [`@kizunasync/ui`](../packages/ui/README.md): runtime theme tokens
