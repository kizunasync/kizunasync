/**
 * Fail when the browser bridge's public API drifts from the committed glue.
 *
 * Usage (repository root, after `bun run cargo:wasm`):
 *   bun run check:wasm-glue
 *
 * Only the `export class KizunaSyncWasmEngine` block is compared. The rest of
 * kizunasync_wasm.d.ts carries wasm-bindgen's internal symbol table, whose closure
 * indices move with the compiler and the toolchain, so diffing the whole file
 * would fail for reasons that have nothing to do with the bridge's contract.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const relative = 'packages/web/src/wasm/kizunasync_wasm.d.ts'
const declarations = resolve(root, relative)
const OPENING = 'export class KizunaSyncWasmEngine'

/**
 * The declaration block for the exported class: its opening line through the
 * first line that is exactly `}`.
 */
function apiBlock(source: string, origin: string): string[] {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(OPENING))

  if (start === -1) {
    console.error(`[check-wasm-glue] ${origin} declares no ${OPENING}`)
    process.exit(1)
  }
  const end = lines.findIndex((line, index) => index > start && line === '}')

  if (end === -1) {
    console.error(`[check-wasm-glue] ${origin}: ${OPENING} is never closed`)
    process.exit(1)
  }
  return lines.slice(start, end + 1)
}

/** The committed revision of the file, or null when it is not in HEAD yet. */
function committed(): string | null {
  const shown = spawnSync('git', ['show', `HEAD:${relative}`], { cwd: root, encoding: 'utf8' })

  return shown.status === 0 && typeof shown.stdout === 'string' ? shown.stdout : null
}

if (!existsSync(declarations)) {
  console.error(`[check-wasm-glue] ${relative} is missing. Run: bun run cargo:wasm`)
  process.exit(1)
}

const baseline = committed()

if (baseline === null) {
  console.log(`[check-wasm-glue] ${relative} is not in HEAD yet; nothing to compare`)
  process.exit(0)
}

const built = apiBlock(readFileSync(declarations, 'utf8'), 'the generated glue')
const previous = apiBlock(baseline, 'the committed glue')

if (built.join('\n') === previous.join('\n')) {
  console.log(`[check-wasm-glue] ${OPENING} matches the committed glue`)
  process.exit(0)
}

console.error(`[check-wasm-glue] ${OPENING} drifted from the committed glue:`)

for (const line of previous) {
  if (!built.includes(line)) console.error(`  - ${line}`)
}
for (const line of built) {
  if (!previous.includes(line)) console.error(`  + ${line}`)
}
console.error('[check-wasm-glue] commit the regenerated declarations if the change is intended')
process.exit(1)
