import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './docs'

// MARK: - Protocol corpus stats

const MANIFEST_PATH = 'packages/protocol/cases/manifest.json'

interface IManifestCase {
  file: string | null
}

interface IManifest {
  cases: IManifestCase[]
}

function readManifest(): IManifest {
  const raw = readFileSync(join(repoRoot(), MANIFEST_PATH), 'utf8')

  return JSON.parse(raw) as IManifest
}

/** Total entries declared in the protocol conformance corpus manifest. */
export function corpusCaseCount(): number {
  return readManifest().cases.length
}

/** Corpus entries with a transcript file on disk (not blocked on an open decision). */
export function executedCaseCount(): number {
  return readManifest().cases.filter((entry) => entry.file !== null).length
}
