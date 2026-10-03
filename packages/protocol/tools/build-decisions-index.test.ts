import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../harness/canonical'
import { buildDecisionsIndex } from './build-decisions-index'

const ROOT = join(import.meta.dir, '..')

/** The capitalized word the register pages spell a decided count with, indexed by the count. */
const DECIDED_COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty', 'Twenty-one', 'Twenty-two', 'Twenty-three', 'Twenty-four', 'Twenty-five'] as const

describe('build-decisions-index', () => {
  test('every markdown record has an index entry whose file matches the key', () => {
    const index = buildDecisionsIndex(ROOT)
    const ids = Object.keys(index)

    expect(ids.length).toBeGreaterThan(0)
    const seen = new Set<string>()

    for (const id of ids) {
      expect(seen.has(id)).toBe(false)
      seen.add(id)
      const entry = index[id]!

      expect(entry.file).toBe(`decisions/${id}.md`)
      expect(['decided', 'open', 'superseded']).toContain(entry.status)
      expect(entry.title.length).toBeGreaterThan(0)
    }
  })

  test('index is byte-canonical when serialized', () => {
    const index = buildDecisionsIndex(ROOT)

    expect(() => canonicalize(index)).not.toThrow()
  })

  test('regeneration is deterministic (run twice, identical bytes)', () => {
    expect(canonicalize(buildDecisionsIndex(ROOT))).toBe(canonicalize(buildDecisionsIndex(ROOT)))
  })

  test('the four open records are present', () => {
    const index = buildDecisionsIndex(ROOT)
    const open = Object.entries(index)
      .filter(([, record]) => record.status === 'open')
      .map(([id]) => id)
      .sort()

    expect(open).toEqual([
      'D-base-hint',
      'D-dedup-storage-model',
      'D-transport-error-codes',
      'D-wakeup-channel',
    ])
  })

  test('verdict ownership is a decided record', () => {
    expect(buildDecisionsIndex(ROOT)['D-verdict-ownership']?.status).toBe('decided')
  })

  test('the register README lists every record with its status and title', () => {
    const readme = readFileSync(join(ROOT, 'decisions', 'README.md'), 'utf8')
    const rows = [...readme.matchAll(/^\| `(D-[a-z0-9-]+)` \| (\w+) \|/gm)].map((match) => `${match[1]}:${match[2]}`).sort()
    const index = Object.entries(buildDecisionsIndex(ROOT)).map(([id, record]) => `${id}:${record.status}`).sort()

    expect(rows).toEqual(index)
  })

  test('the pages that count the register match the index', () => {
    const records = Object.values(buildDecisionsIndex(ROOT))
    const decided = `${DECIDED_COUNT_WORDS[records.filter((record) => record.status === 'decided').length]} records`
    const total = `holds ${records.length} records`
    const pages: Record<string, string[]> = {
      'README.md': [`| \`decided\` | ${decided}.`],
      '../../docs/reference/protocol.md': [total, `| \`decided\` | ${decided} covering`],
      '../../docs/reference/status-taxonomy.md': [total, `| ${decided} |`],
    }

    for (const [rel, phrases] of Object.entries(pages)) {
      const text = readFileSync(join(ROOT, rel), 'utf8')

      for (const phrase of phrases) {
        expect(text, rel).toContain(phrase)
      }
    }
  })
})
