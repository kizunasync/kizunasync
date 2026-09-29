import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadEnvConfig } from '@next/env'
import type { NextConfig } from 'next'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

loadEnvConfig(repoRoot)

/** Latest commit date touching the public site's content, else the build day. */
function computeSiteModified(): string {
  try {
    const date = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', 'apps/website', 'docs', 'README.md'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim()

    if (date.length > 0) {
      return date
    }
  } catch {
    // git unavailable (e.g. an archive build outside a checkout); fall through.
  }
  return new Date().toISOString().slice(0, 10)
}

/**
 * useTypeScriptCli: TypeScript 7 dropped the public compiler API (it returns in
 * 7.1), and Next.js type-checks through that API by default. This flag makes it
 * shell out to the tsc CLI instead, which is the escape hatch Next's own error
 * message names.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kizunasync/ui'],
  env: {
    NEXT_PUBLIC_WEBSITE_SITE_MODIFIED: computeSiteModified(),
  },
  experimental: {
    useTypeScriptCli: true,
  },
  turbopack: {
    // Monorepo root (bun hoists node_modules there).
    root: repoRoot,
  },
  async redirects() {
    return [
      {
        source: '/docs/reference/:library([a-z]+)',
        destination: '/docs/reference/:library/introduction',
        permanent: true,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
