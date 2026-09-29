<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/ui</span>
</h1>

Shared Sumi & Vermilion theme tokens and cross-app React components. Apps import the theme instead of duplicating tokens.

Workspace-only alpha at `0.2.6-alpha.1`. Private monorepo exports, not a published registry API.

## What this is

The package surface is small (`src/index.ts`):

- `@kizunasync/ui/theme.css`: full theme for Tailwind apps. Imports `effects.css`, defines `--color-site-*` semantic tokens in a Tailwind `@theme` block, plus the seven `--color-brand-*` framework glyph colors
- `@kizunasync/ui/effects.css`: plain `:root` surface effects (gradient tint, online-dot pulse, raised edge, skeleton shimmer, shadow colors). Use this when the consumer has no Tailwind, or owns its own focus rings
- `BrandMark`: 絆 wordmark. Optional `suffix` appends muted text after `Kizuna Sync`
- `KSYNC_PALETTE`: palette as a JS object (`@kizunasync/ui/palette`) for non-CSS consumers such as React Native
- `KSYNC_THEME_VARS`: palette-to-CSS-custom-property map (`@kizunasync/ui/theme-vars`)
- `t`: framework-agnostic i18n helper (`@kizunasync/ui/i18n`)
- `SPACING` / `RADIUS`: numeric scales (`@kizunasync/ui/spacing`)
- `ICONS`: Symbols Nerd Font glyphs (`@kizunasync/ui/icons`)

## Theme tokens

`src/theme.css` is the web color source of truth. `src/effects.css` is the plain-CSS half it imports.

Tailwind apps import once from `globals.css` and never redefine the tokens:

```css
@import '@kizunasync/ui/theme.css';
```

Used by `apps/website`, `apps/sync-inspector`, and `apps/demo`. After the import, use utilities such as `bg-site-background` and `text-site-accent`.

The web examples import the effects half instead (`examples/todo-react`, `examples/todo-vue`), because each owns focus rings and selection styling. The Vue example has no Tailwind at all.

Native examples cannot consume CSS tokens. Expo keeps the same semantic palette in `examples/todo-expo/src/theme.ts`, with a literal-hex restatement in `global.css` for heroui-native. A test keeps the two encodings from drifting.

Raw hex, `oklch()`, and other raw color functions belong only in the theme-authority files (`palette.ts`, `theme.css`, `effects.css`, and the Expo example theme files). Everywhere else, a new color means a new token.

## Consuming the package

`@kizunasync/ui` ships TypeScript source, not a compiled build. Next.js consumers must transpile it:

```ts
// next.config.ts
transpilePackages: ['@kizunasync/ui']
```

## When to add a component

Extract within the owning app first. Promote to `packages/ui` only when the same stable semantic primitive is used by at least two apps, or when it is an intentional design-system primitive. Inspector-specific pieces stay in `apps/sync-inspector/components`.

## Related

- [`branding/`](../../branding/README.md): SVG marks and brandbook
- [`apps/website`](../../apps/website/README.md)
- [`apps/demo`](../../apps/demo/README.md)

## License

Apache-2.0.
