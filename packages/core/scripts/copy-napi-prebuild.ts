/**
 * Copy a built kizunasync-napi cdylib into packages/core/src/native/<platform>-<arch>/.
 * Run after `cargo build -p kizunasync-napi` (release preferred).
 *
 * Usage (repo root):
 *   bun packages/core/scripts/copy-napi-prebuild.ts
 *   bun run cargo:napi:prebuild
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = resolve(here, '..')
const repoRoot = resolve(coreRoot, '../..')

const libName = (): string => {
  if (platform() === 'darwin') {
    return 'libkizunasync_napi.dylib'
  }
  if (platform() === 'win32') {
    return 'kizunasync_napi.dll'
  }
  return 'libkizunasync_napi.so'
}

const name = libName()
const sources = [
  resolve(repoRoot, `target/release/${name}`),
  resolve(repoRoot, `target/debug/${name}`),
]
const src = sources.find((p) => existsSync(p))

if (src === undefined) {
  console.error(
    `kizunasync-napi library not found (tried ${sources.join(', ')}).\n` +
      `Build first: cargo build -p kizunasync-napi  (or cargo build -p kizunasync-napi --release)`,
  )
  process.exit(1)
}

const destDir = resolve(coreRoot, `src/native/${platform()}-${arch()}`)

mkdirSync(destDir, { recursive: true })
const dest = resolve(destDir, name)

cpSync(src, dest)
console.log(`napi prebuild: ${src} → ${dest}`)
