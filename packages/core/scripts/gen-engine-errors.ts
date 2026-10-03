/**
 * Emit src/wire/engine-error-codes.generated.ts from the Rust-owned error catalog
 * at packages/protocol/spec/engine-errors.json.
 *
 * Usage (packages/core):
 *   bun run gen:errors
 *
 * The JSON itself comes from `cargo run -p kizunasync-bindgen -- engine-errors`, which
 * projects crates/kizunasync-engine/src/error_catalog.rs. Edit the Rust catalog, never
 * this output.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type TEngineErrorEntry = {
  code: string
  retryable: boolean
  description: string
}

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = resolve(here, '..')
const specPath = resolve(coreRoot, '../protocol/spec/engine-errors.json')
const outPath = resolve(coreRoot, 'src/wire/engine-error-codes.generated.ts')

function readCatalog(path: string): TEngineErrorEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))

  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of catalog entries`)
  }
  return parsed.map((raw, index) => {
    const entry = raw as Partial<TEngineErrorEntry>
    const shaped =
      typeof entry.code === 'string' &&
      typeof entry.retryable === 'boolean' &&
      typeof entry.description === 'string'

    if (!shaped) {
      throw new Error(`${path}: entry ${index} is not { code, retryable, description }`)
    }
    return { code: entry.code, retryable: entry.retryable, description: entry.description }
  })
}

function renderModule(entries: TEngineErrorEntry[]): string {
  const members = entries
    .map((entry) => `  /** ${entry.description} */\n  ${entry.code}: '${entry.code}',`)
    .join('\n')
  const flags = entries.map((entry) => `  ${entry.code}: ${String(entry.retryable)},`).join('\n')

  return [
    '/** Generated from packages/protocol/spec/engine-errors.json by scripts/gen-engine-errors.ts; do not edit. */',
    'export const ENGINE_ERROR_CODES = {',
    members,
    '} as const',
    '',
    'export type TEngineErrorCode = (typeof ENGINE_ERROR_CODES)[keyof typeof ENGINE_ERROR_CODES]',
    '',
    '/**',
    ' * The catalog\'s documented default per code: true when a retry of the same',
    ' * operation unchanged may succeed. An instance may still carry its own flag',
    ' * (a remote fault does). The failure envelope reports that instance flag.',
    ' */',
    'export const ENGINE_ERROR_RETRYABLE: Record<TEngineErrorCode, boolean> = {',
    flags,
    '}',
    '',
  ].join('\n')
}

if (import.meta.main) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, renderModule(readCatalog(specPath)))
  console.log(`wrote ${outPath}`)
}
