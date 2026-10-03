<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/website</span>
</h1>

Marketing site and in-site docs viewer for Kizuna (絆). A Next.js app that renders the Markdown declared in its docs registry, plus the comparison page and the `llms.txt` endpoint.

Alpha. The site states the project honestly. API and CLI examples describe the current product, not a published release. Nothing is on npm.

## What it serves

- Landing page (`app/page.tsx`): hero, sync scene, framework tabs
- Docs viewer (`app/docs/`): seven registry groups: Getting started, Sync, Attachments, CLI & provisioning, Testing & operations, Reference, and Resources. Reader pages come from `docs/`; root `GOVERNANCE.md` is the one explicit exception. The site never keeps a second prose copy
- Comparison page (`app/compare/`): feature matrix and head-to-heads against PowerSync, WatermelonDB, RxDB, Electric, TinyBase, and DIY sync
- `app/llms.txt/route.ts`: machine-readable summary at `/llms.txt`, plus `sitemap.ts` and `robots.ts`

## Where the content lives

Docs are not authored in this app. Source paths are registered and rendered in-site.

- [`docs/`](../../docs): reader-first Markdown
- [`GOVERNANCE.md`](../../GOVERNANCE.md): also registered as public reference
- [`lib/docs-registry.ts`](./lib/docs-registry.ts): ordered registry for flat docs pages (slug → file, title, group, description). Order defines the sidebar and prev/next. Optional `navHidden` omits an entry from human nav while keeping the URL live
- [`lib/reference/*.ts`](./lib/reference) and [`lib/reference-registry.ts`](./lib/reference-registry.ts): per-library client reference trees at `/docs/reference/<library>/<page>`
- [`lib/docs.ts`](./lib/docs.ts): server-only loading. Resolves the repository root (or `KIZUNASYNC_REPO_ROOT` for out-of-tree builds), reads the registered file, extracts headings for the TOC

To add a flat reader page, write Markdown under `docs/` and add an entry to `lib/docs-registry.ts`. To add a client reference page, write `docs/reference/<library>/<slug>.md` and append it to that library's module under `lib/reference/`. Registry tests enforce a one-to-one mapping for reader pages and validate local links.

## Get started

Bun and Next 16. From the repository root:

```bash
bun run turbo run dev --filter=@kizunasync/website
bun run turbo run build --filter=@kizunasync/website
```

`bun run dev` / `bun run build` at the root start or build the whole monorepo through Turbo.

The docs viewer reads Markdown from the repository during development and during static generation. Run it from inside a checkout. For a build outside the tree, set `KIZUNASYNC_REPO_ROOT` so `lib/docs.ts` can find every registered source, including root `GOVERNANCE.md`.

## Related

- [Docs](https://kizunasync.com/docs)
- [Repository layout](../../docs/resources/repository-layout.md)
- [`@kizunasync/protocol`](../../packages/protocol/README.md)
