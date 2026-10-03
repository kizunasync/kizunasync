/**
 * Corpus loader.
 *
 * node:fs/node:path only: packages/protocol/ ships zero runtime deps; dev tooling is devDependencies [CONV:repository-layout].
 * Map keys and returned paths are POSIX-style, relative to the packages/protocol/
 * root (e.g. 'transcripts/pull/001-bootstrap-empty.json'). The loader is
 * deliberately tolerant of absent directories: the harness validates whatever
 * JSON files are present.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// MARK: - Types

export type TCorpusFile = { raw: string; json: unknown }

export type TCorpus = {
  transcripts: Map<string, TCorpusFile>
  manifest: unknown
  properties: unknown[]
}

// MARK: - Discovery

const CORPUS_DIRS = ['cases', 'decisions', 'fixtures', 'properties', 'schemas', 'spec', 'transcripts']

const collectJson = (dir: string, prefix: string, out: string[]): void => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      collectJson(full, `${prefix}${entry}/`, out)
    } else if (entry.endsWith('.json')) {
      out.push(`${prefix}${entry}`)
    }
  }
}

/** Every JSON artifact subject to the canonical-bytes invariant I-1 (schemas/, fixtures/, cases/, transcripts/, properties/index.json, spec/*.json). */
export const listJsonFiles = (root: string): string[] => {
  const out: string[] = []

  for (const dir of CORPUS_DIRS) {
    const full = join(root, dir)

    if (existsSync(full) && statSync(full).isDirectory()) {
      collectJson(full, `${dir}/`, out)
    }
  }
  return out
}

export const readCorpusFile = (root: string, rel: string): TCorpusFile => {
  const raw = readFileSync(join(root, ...rel.split('/')), 'utf8')

  return { json: JSON.parse(raw) as unknown, raw }
}

// MARK: - Public API

export const loadCorpus = (root: string): TCorpus => {
  const transcripts = new Map<string, TCorpusFile>()

  for (const rel of listJsonFiles(root)) {
    if (rel.startsWith('transcripts/')) {
      transcripts.set(rel, readCorpusFile(root, rel))
    }
  }
  const manifestPath = join(root, 'cases', 'manifest.json')
  const manifest: unknown = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
    : null
  const indexPath = join(root, 'properties', 'index.json')
  const index: unknown = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, 'utf8')) as unknown)
    : null
  const properties: unknown[] =
    index !== null && typeof index === 'object' && !Array.isArray(index)
      ? Object.values(index as Record<string, unknown>)
      : []

  return { manifest, properties, transcripts }
}
