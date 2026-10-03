/**
 * Builds decisions/index.json from the MADR files under decisions/.
 * node:fs / node:path only: devtool, run with Bun.
 *
 * Each MADR file carries a machine-readable front block:
 *   <!-- kizunasync:decision
 *   id: D-<kebab-slug>
 *   status: <decided|open|superseded>
 *   -->
 * The title is the H1 text after the id prefix; the file path is recorded
 * relative to packages/protocol/. The index is the machine-resolvable surface
 * the harness I-7 check reads (registryIds = its keys).
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../harness/canonical'

type TDecisionEntry = { title: string; status: string; file: string }

const mdFiles = (root: string): string[] => {
  const dir = join(root, 'decisions')
  const out: string[] = []

  for (const entry of readdirSync(dir).sort()) {
    if (entry.endsWith('.md') && entry !== 'README.md') {
      out.push(`decisions/${entry}`)
    }
  }
  return out
}

export const buildDecisionsIndex = (root: string): Record<string, TDecisionEntry> => {
  const index: Record<string, TDecisionEntry> = {}

  for (const rel of mdFiles(root)) {
    const raw = readFileSync(join(root, ...rel.split('/')), 'utf8')
    const entry = parseDecision(rel, raw)

    if (index[entry.id] !== undefined) {
      throw new Error(`build-decisions-index: duplicate id ${entry.id} (${rel})`)
    }
    index[entry.id] = entry.value
  }
  return index
}

const writeDecisionsIndex = (root: string): void => {
  const index = buildDecisionsIndex(root)

  writeFileSync(join(root, 'decisions', 'index.json'), canonicalize(index), 'utf8')
}

// MARK: - front-block parser

const FRONT_RE = /<!--\s*kizunasync:decision\s*\n([\s\S]*?)\n-->/
const H1_RE = /^#\s+(D-[a-z][a-z0-9]*(?:-[a-z0-9]+)*):\s+(.+?)\s*$/m
const ID_RE = /^D-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const FILE_RE = /^decisions\/D-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md$/

const parseField = (block: string, key: string): string => {
  const match = block.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))

  if (match === null) {
    throw new Error(`build-decisions-index: missing '${key}' in front block`)
  }
  return match[1] as string
}

const STATUSES = new Set(['decided', 'open', 'superseded'])

const parseDecision = (rel: string, raw: string): { id: string; value: TDecisionEntry } => {
  const front = raw.match(FRONT_RE)

  if (front === null) {
    throw new Error(`build-decisions-index: no kizunasync:decision front block in ${rel}`)
  }
  const block = front[1] as string
  const id = parseField(block, 'id')
  const status = parseField(block, 'status')

  if (!ID_RE.test(id)) {
    throw new Error(`build-decisions-index: id '${id}' is not D-<kebab-slug> in ${rel}`)
  }
  if (!FILE_RE.test(rel) || rel !== `decisions/${id}.md`) {
    throw new Error(`build-decisions-index: file ${rel} must be decisions/${id}.md`)
  }
  if (!STATUSES.has(status)) {
    throw new Error(`build-decisions-index: unknown status '${status}' in ${rel}`)
  }
  const h1 = raw.match(H1_RE)

  if (h1 === null || h1[1] !== id) {
    throw new Error(`build-decisions-index: H1 id mismatch in ${rel} (front=${id})`)
  }
  return { id, value: { file: rel, status, title: h1[2] as string } }
}

if (import.meta.main) {
  writeDecisionsIndex(join(import.meta.dir, '..'))
}
