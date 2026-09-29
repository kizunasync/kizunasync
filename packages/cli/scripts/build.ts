/**
 * build: esbuild bundle for a Node-portable kizunasync CLI
 *
 * Bundles src/main.ts → dist/main.js (Node ESM, node shebang), then copies the
 * SQL pack into packages/cli/pack/ (flat layout: manifest + pack .sql) so the
 * published tarball resolves the pack without monorepo packages/supabase-pack.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PACK_OUT = join(ROOT, 'pack')
const SUPABASE_PACK = join(ROOT, '..', 'supabase-pack')

async function main(): Promise<void> {
  rmSync(DIST, { recursive: true, force: true })
  rmSync(PACK_OUT, { recursive: true, force: true })

  await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'main.ts')],
    outfile: join(DIST, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node\n' },
    external: [],
    logLevel: 'info',
  })

  chmodSync(join(DIST, 'main.js'), 0o755)

  mkdirSync(PACK_OUT, { recursive: true })
  const manifestPath = join(SUPABASE_PACK, 'pack.manifest.json')

  copyFileSync(manifestPath, join(PACK_OUT, 'pack.manifest.json'))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { pack: string[] }

  for (const file of manifest.pack) {
    const source = join(SUPABASE_PACK, 'supabase', 'migrations', file)

    if (!existsSync(source)) {
      throw new Error(`pack file ${file} is listed in pack.manifest.json but missing at ${source}`)
    }
    copyFileSync(source, join(PACK_OUT, file))
  }
}

await main()
