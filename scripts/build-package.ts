/**
 * build-package: shared esbuild + declaration-emit build for a publishable
 * @kizunasync/* package. Run from the package directory as
 * `bun ../../scripts/build-package.ts`.
 *
 * Entry points come from the dev `exports`: every target that is a `.ts` file
 * under `./src/`, built to `dist/` under its path relative to `./src/` without
 * `.ts` (`./src/config/index.ts` -> `dist/config/index.js`).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as esbuild from 'esbuild'

interface IPackageJson {
  exports: Record<string, string>
}

const CWD = process.cwd()

const SOURCE_ENTRY = /^\.\/src\/(.+)\.ts$/

/** Output name (`config/index`) to source path (`./src/config/index.ts`) for every dev export built from TypeScript source. */
function entryPointsFromExports(exports: Record<string, string>): Record<string, string> {
  const entryPoints: Record<string, string> = {}

  for (const target of Object.values(exports)) {
    const outName = SOURCE_ENTRY.exec(target)?.[1]

    if (outName !== undefined) {
      entryPoints[outName] = target
    }
  }
  return entryPoints
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
  const entryPoints = entryPointsFromExports(pkg.exports)

  if (Object.keys(entryPoints).length === 0) {
    throw new Error('package.json exports name no .ts entry point under ./src/')
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
