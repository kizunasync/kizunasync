/**
 * Run every TLA+ model registered in properties/index.json.
 * bun tools/run-all-tla.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const index = JSON.parse(readFileSync(join(ROOT, 'properties', 'index.json'), 'utf8')) as Record<
  string,
  { tla?: string; cfg?: string }
>

const modules: string[] = []

for (const entry of Object.values(index)) {
  if (typeof entry.tla !== 'string') {
    continue
  }
  const base = entry.tla.replace(/^tla\//, '').replace(/\.tla$/, '')

  modules.push(base)
  const tlaPath = join(ROOT, 'properties', entry.tla)
  const cfgPath = typeof entry.cfg === 'string' ? join(ROOT, 'properties', entry.cfg) : ''

  if (!existsSync(tlaPath)) {
    console.error(`missing ${entry.tla}`)
    process.exit(1)
  }
  if (cfgPath !== '' && !existsSync(cfgPath)) {
    console.error(`missing ${entry.cfg}`)
    process.exit(1)
  }
}

const onDisk = readdirSync(join(ROOT, 'properties', 'tla'))
  .filter((name) => name.endsWith('.tla'))
  .map((name) => name.replace(/\.tla$/, ''))
  .sort()
const registered = [...modules].sort()

if (onDisk.join(',') !== registered.join(',')) {
  console.error(`properties/tla/ ${onDisk.join(', ')} != index ${registered.join(', ')}`)
  process.exit(1)
}

for (const name of modules) {
  console.log(`== ${name} ==`)
  const result = spawnSync('tools/run-tlc.sh', [name], { cwd: ROOT, stdio: 'inherit' })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
