// MARK: - Conformance suite

/**
 * Manifest-driven: every executing case replays against the in-memory
 * reference under the fencing mechanism D-visibility-horizon decided, the Postgres
 * transaction-visibility horizon. Each entry with bytes runs once, and blocked
 * entries skip visibly with the OD gate named. The import is STATIC: a
 * reference load failure fails this suite loudly instead of draining the
 * executing tests into skips. This suite doubles as the global
 * anti-vacuous-green guard for the harness-bites mutations.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readCorpusFile } from '../harness/load'
import { runTranscript } from './executor'
import { makeReferenceServer } from './reference'
import { SCENARIOS } from './scenarios'
import { EFencing } from './server-contract'
import type { TFencing } from './server-contract'

// MARK: - Manifest iteration

const ROOT = join(import.meta.dir, '..')

type TJsonObject = Record<string, unknown>

const asObject = (value: unknown): TJsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TJsonObject) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const strings = (value: unknown): string[] =>
  asArray(value).filter((item): item is string => typeof item === 'string')

const manifest = asObject(readCorpusFile(ROOT, 'cases/manifest.json').json)

const conformanceTest = (name: string, file: string, fencing: TFencing, id: string): void => {
  test(name, () => {
    const result = runTranscript(makeReferenceServer(), readCorpusFile(ROOT, file).json, fencing, SCENARIOS[id])

    if (result.status === 'fail') {
      expect(result.failures).toEqual([])
    }
    expect(result.status).toBe('pass')
  })
}

// MARK: - Suite

describe('conformance: golden transcripts × reference server', () => {
  for (const raw of asArray(manifest?.cases)) {
    const entry = asObject(raw)

    if (entry === null) {
      continue
    }
    const id = typeof entry.id === 'string' ? entry.id : ''

    if (entry.file === null) {
      // A manifest entry with no transcript file is blocked on an open decision, so the case surfaces as a visible skip.
      const gates = strings(entry.blocked_on).join(', ')
      const notes = strings(entry.notes).join(' · ')

      test.skip(`${id}: blocked on ${gates}: ${notes}`, () => {})
      continue
    }

    if (typeof entry.file === 'string') {
      const transcript = asObject(readCorpusFile(ROOT, entry.file).json)
      const fencing =
        transcript?.fencing === EFencing.visibilityHorizon
          ? EFencing.visibilityHorizon
          : EFencing.shared

      conformanceTest(id, entry.file, fencing, id)
    }
  }
})
