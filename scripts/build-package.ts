/**
 * build-package: shared esbuild + declaration-emit build for a publishable
 * @kizunasync/* package. Run from the package directory as
 * `bun ../../scripts/build-package.ts`.
 *
 * Entry points come from `publishConfig.exports`: for each key the source is
 * the dev `exports[key]` (a `./src/...ts` path) and the output name is the
 * dist path in `publishConfig.exports[key].default`, stripped of the
 * `./dist/` prefix and `.js` suffix.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as esbuild from 'esbuild'

interface IPublishExportEntry {
  types: string
  default: string
}

interface IPackageJson {
  exports: Record<string, string>
  publishConfig?: {
    exports?: Record<string, IPublishExportEntry>
  }
}

const CWD = process.cwd()

function outNameFromDistPath(distPath: string): string {
  // "./dist/config/index.js" -> "config/index"
  return distPath.replace(/^\.\/dist\//, '').replace(/\.js$/, '')
}

function listFiles(dir: string): string[] {
  const out: string[] = []

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)

    if (entry.isDirectory()) {
      out.push(...listFiles(full))
    } else {
      out.push(full)
    }
  }
  return out
}

async function main(): Promise<void> {
  const pkg = JSON.parse(await Bun.file(join(CWD, 'package.json')).text()) as IPackageJson
  const publishExports = pkg.publishConfig?.exports

  if (!publishExports) {
    throw new Error('package.json is missing publishConfig.exports')
  }

  const entryPoints: Record<string, string> = {}

  for (const [key, publishEntry] of Object.entries(publishExports)) {
    const devSource = pkg.exports[key]

    if (!devSource) {
      throw new Error(`exports is missing the "${key}" key present in publishConfig.exports`)
    }
    const outName = outNameFromDistPath(publishEntry.default)

    entryPoints[outName] = devSource
  }

  const distDir = join(CWD, 'dist')

  rmSync(distDir, { recursive: true, force: true })

  await esbuild.build({
    entryPoints,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    packages: 'external',
    outdir: 'dist',
    sourcemap: true,
    jsx: 'automatic',
    logLevel: 'info',
  })

  execFileSync('bunx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd: CWD,
    stdio: 'inherit',
  })

  const produced = listFiles(distDir)
    .map((f) => relative(CWD, f))
    .sort()

  console.log(`\nbuild-package: produced ${produced.length} files in dist/`)

  for (const f of produced) {
    const size = statSync(join(CWD, f)).size

    console.log(`  ${f} (${size}b)`)
  }
}

await main()
