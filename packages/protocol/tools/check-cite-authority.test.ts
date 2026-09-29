import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CITE_PATTERN, CITE_PREFIXES } from '../harness/invariants'
import { checkCiteAuthority } from './check-cite-authority'

const ROOT = join(import.meta.dir, '..')

describe('check-cite-authority', () => {
  test('every distinct corpus cite resolves to a public referent', () => {
    const { results, sources } = checkCiteAuthority(ROOT)
    const fails = results.filter((r) => r.status === 'fail')
    const detail = fails
      .map((r) => `${r.cite}: ${r.detail} [cited in: ${[...(sources.get(r.cite) ?? [])].sort().join(', ')}]`)
      .join('\n')

    expect(detail).toBe('')
    expect(fails.length).toBe(0)
    expect(results.length).toBeGreaterThan(0)
  })

  test('section-bearing cites resolve to a markdown HEADING, not just an existing file', () => {
    const { results } = checkCiteAuthority(ROOT)
    const sectioned = results.filter(
      (r) => r.cite.startsWith('P:') || r.cite.startsWith('A:') || r.cite.startsWith('DR:'),
    )

    expect(sectioned.length).toBeGreaterThan(0)

    for (const r of sectioned) {
      expect(r.detail).toContain('(heading-slug)')
    }
  })

  test('SQL cites resolve to an anchor comment in the migration, not just an existing file', () => {
    const { results } = checkCiteAuthority(ROOT)
    const sql = results.filter((r) => r.cite.startsWith('SQL:'))

    expect(sql.length).toBeGreaterThan(0)

    for (const r of sql) {
      expect(r.cite).toMatch(/^SQL:[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
      expect(r.detail).toContain('(sql-anchor)')
    }
  })

  test('P:attachments-are-out-of-protocol-scope resolves to its heading in the protocol doc', () => {
    const { results } = checkCiteAuthority(ROOT)
    const p10 = results.find((r) => r.cite === 'P:attachments-are-out-of-protocol-scope')

    expect(p10?.status).toBe('ok')
  })

  test('schema cite patterns and docs-authority prefixes equal CITE_PATTERN / CITE_PREFIXES', () => {
    const schemaFiles = [
      'schemas/transcript.schema.json',
      'schemas/manifest.schema.json',
      'schemas/property-index.schema.json',
    ]
    const patterns: string[] = []
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) {
          collect(item)
        }
        return
      }
      if (node === null || typeof node !== 'object') {
        return
      }
      const record = node as Record<string, unknown>

      if (typeof record.pattern === 'string' && record.pattern.includes('SQL:')) {
        patterns.push(record.pattern)
      }
      for (const value of Object.values(record)) {
        collect(value)
      }
    }
    for (const rel of schemaFiles) {
      collect(JSON.parse(readFileSync(join(ROOT, rel), 'utf8')))
    }
    expect(patterns.length).toBeGreaterThan(0)

    for (const pattern of patterns) {
      expect(pattern).toBe(CITE_PATTERN.source)
    }
    const authority = JSON.parse(readFileSync(join(ROOT, 'docs-authority.json'), 'utf8')) as {
      prefixes: Record<string, unknown>
    }

    expect(Object.keys(authority.prefixes).sort()).toEqual([...CITE_PREFIXES].sort())
  })
})
