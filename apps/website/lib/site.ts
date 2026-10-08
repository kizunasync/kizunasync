// MARK: - Site constants

export const SITE_FULL_NAME = 'Kizuna Sync'

/**
 * Defaults to the production origin; override with NEXT_PUBLIC_WEBSITE_SITE_URL
 * to make canonical, sitemap and JSON-LD resolve to the host being served
 * (e.g. http://localhost:3000 for a local AI-readiness audit).
 */
export const SITE_URL = process.env.NEXT_PUBLIC_WEBSITE_SITE_URL ?? 'https://kizunasync.com'
export const DEMO_URL = 'https://demo.kizunasync.com'
export const GITHUB_URL = 'https://github.com/kizunasync/kizunasync'
export const TAGLINE = 'Offline-first sync for Supabase'
export const DESCRIPTION =
  'Kizuna is offline-first sync for Supabase: rows and media, provisioned into the project you own. Its clients use SQL in your project; no Kizuna-operated service sits in the data path.'

/** Alt text of the root share image (app/opengraph-image.tsx), which pages without their own image fall back to. */
export const SHARE_IMAGE_ALT = 'Kizuna Sync: offline-first sync for Supabase'

/**
 * Freshness signals for JSON-LD (schema.org accepts date-only ISO).
 * SITE_MODIFIED is computed at build time in next.config.ts from the latest
 * commit touching apps/website, docs, or README.md, and injected as
 * NEXT_PUBLIC_WEBSITE_SITE_MODIFIED; it falls back to the build day outside git.
 */
export const SITE_PUBLISHED = '2026-09-14'
export const SITE_MODIFIED = process.env.NEXT_PUBLIC_WEBSITE_SITE_MODIFIED ?? new Date().toISOString().slice(0, 10)

export const PACKAGE_MANAGER_TABS = ['npm', 'pnpm', 'yarn', 'bun'] as const
export type TPackageManager = (typeof PACKAGE_MANAGER_TABS)[number]

const KSYNC_RUNNERS: Record<TPackageManager, string> = {
  npm: 'npx kizunasync',
  pnpm: 'pnpm dlx kizunasync',
  yarn: 'yarn dlx kizunasync',
  bun: 'bunx kizunasync',
}

export function kizunasyncCommand(pm: TPackageManager, args = ''): string {
  const runner = KSYNC_RUNNERS[pm]

  return args.length === 0 ? runner : `${runner} ${args}`
}

export const INIT_PREVIEW_ARGS = 'init --dry-run'
