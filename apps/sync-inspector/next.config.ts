import { fileURLToPath } from 'node:url'
import { loadEnvConfig } from '@next/env'
import type { NextConfig } from 'next'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

loadEnvConfig(repoRoot)

/**
 * useTypeScriptCli: TypeScript 7 dropped the public compiler API (it returns in
 * 7.1), and Next.js type-checks through that API by default. This flag makes it
 * shell out to the tsc CLI instead, which is the escape hatch Next's own error
 * message names.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kizunasync/ui'],
  experimental: {
    useTypeScriptCli: true,
  },
  turbopack: {
    // Monorepo root (bun hoists node_modules there).
    root: repoRoot,
  },
}

export default nextConfig
