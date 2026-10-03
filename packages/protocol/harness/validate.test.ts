// MARK: - Corpus validation entry

/**
 * Runs every transcript × (canonical bytes, schema validity, invariants,
 * manifest bijection). A missing artifact fails the suite: the corpus is the
 * single oracle, so an absent schema, transcript or registry is a corpus
 * defect, never a skip (@../../../CONVENTIONS.md). This harness proves the oracle is well-formed
 * [P:the-golden-corpus-and-deterministic-placeholders] and nothing more (no executor, no mock server, no property
 * runners, DX:test-offline-behavior, DR:the-driver-tck).
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Ajv2020, { type AnySchema } from 'ajv/dist/2020'
import { assertCanonicalFile } from './canonical'
import { CITE_PATTERN, checkCorpus, checkDomainTables, checkIdentifierRegistry, checkOpenDecisionRefs, checkTranscript } from './invariants'
import { listJsonFiles, loadCorpus } from './load'
import { DEFAULT_PAGE_LIMIT } from '../spec/limits'
import type { TValidationIssue } from './ajv-validate'
import { validateAgainst } from './ajv-validate'

// MARK: - Corpus discovery

const ROOT = join(import.meta.dir, '..')

const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, ...rel.split('/')), 'utf8')) as unknown

const jsonFiles = listJsonFiles(ROOT)
const corpus = loadCorpus(ROOT)

const SCHEMA_FILES = [
  'common.schema.json',
  'manifest.schema.json',
  'pull-request.schema.json',
  'pull-response.schema.json',
  'push-request.schema.json',
  'push-response.schema.json',
  'transcript.schema.json',
]

const transcriptEntries = [...corpus.transcripts.entries()]

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

// MARK: - Smoke

describe('corpus loader', () => {
  test('loadCorpus returns a well-formed corpus', () => {
    expect(corpus.transcripts).toBeInstanceOf(Map)
    expect(Array.isArray(corpus.properties)).toBe(true)
  })

  test('every artifact the checks below read is present', () => {
    expect(jsonFiles.length).toBeGreaterThan(0)
    expect(transcriptEntries.length).toBeGreaterThan(0)
    expect(corpus.manifest).not.toBeNull()
    expect(corpus.properties.length).toBeGreaterThan(0)

    for (const name of SCHEMA_FILES) {
      expect(existsSync(join(ROOT, 'schemas', name))).toBe(true)
    }
  })
})

// MARK: - I-1 canonical bytes (C-7) for every JSON artifact

describe('I-1 canonical bytes', () => {
  for (const rel of jsonFiles) {
    test(rel, () => {
      assertCanonicalFile(rel, readFileSync(join(ROOT, ...rel.split('/')), 'utf8'))
    })
  }
})

// MARK: - I-2 schema validity

const MESSAGE_SCHEMAS: Record<string, { request: string; response: string }> = {
  pull: { request: 'pull-request.schema.json', response: 'pull-response.schema.json' },
  push: { request: 'push-request.schema.json', response: 'push-response.schema.json' },
}

const rpcPayloadIssues = (json: unknown): TValidationIssue[] => {
  const issues: TValidationIssue[] = []
  const steps = asObject(json)?.steps

  if (!Array.isArray(steps)) {
    return issues
  }
  steps.forEach((raw, index) => {
    const step = asObject(raw)

    if (step === null || step.kind !== 'rpc' || typeof step.rpc !== 'string') {
      return
    }
    const names = MESSAGE_SCHEMAS[step.rpc]

    if (names === undefined) {
      return
    }
    for (const side of ['request', 'response'] as const) {
      const name = names[side].replace('.schema.json', '')

      for (const issue of validateAgainst(name, step[side])) {
        issues.push({ path: `/steps/${index}/${side}${issue.path}`, message: issue.message })
      }
    }
  })

  return issues
}

describe('I-2 schema validity', () => {
  for (const [rel, entry] of transcriptEntries) {
    test(`${rel} matches transcript.schema.json`, () => {
      expect(validateAgainst('transcript', entry.json)).toEqual([])
    })
  }

  for (const [rel, entry] of transcriptEntries) {
    test(`${rel} rpc payloads match the message schemas`, () => {
      expect(rpcPayloadIssues(entry.json)).toEqual([])
    })
  }

  test('cases/manifest.json matches manifest.schema.json', () => {
    expect(validateAgainst('manifest', corpus.manifest)).toEqual([])
  })

  test('properties/index.json matches property-index.schema.json', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    // Ajv's validate signature cannot express this schema's type.
    const ok = ajv.validate(readJson('schemas/property-index.schema.json') as AnySchema, readJson('properties/index.json'))

    expect(ajv.errorsText(ajv.errors)).toBe('No errors')
    expect(ok).toBe(true)
  })
})

// MARK: - I-3..I-10 per-transcript invariants

describe('I-3..I-10 transcript invariants', () => {
  for (const [rel, entry] of transcriptEntries) {
    test(rel, () => {
      expect(checkTranscript(entry.json)).toEqual([])
    })
  }
})

// MARK: - I-9 page limit accounting clauses

describe('I-9 page limit accounting', () => {
  const USER_A = '00000000-0000-4000-8000-a10000000001'
  const ROW_1 = '00000000-0000-4000-8000-e10000000001'
  const ROW_2 = '00000000-0000-4000-8000-e10000000002'
  const row = (pk: string, seq: string): Record<string, unknown> => ({ pk, row: { done: false, owner_id: USER_A, title: 'synthetic' }, seq, table: 'todos' })
  const tombstone = (pk: string, seq: string): Record<string, unknown> => ({ deleted_at: '2026-01-01T00:00:01.000Z', pk, seq, table: 'todos' })

  type TSyntheticPage = { cursor: string; has_more: boolean; rows: unknown[]; tombstones: unknown[]; signal?: { type: string } }

  // A transcript whose only step is one pull, so I-9 is the invariant under test.
  const onePull = ({ limit, from, page }: { limit: number; from: string; page: TSyntheticPage }): unknown => ({
    case: 'pull/999-synthetic',
    cites: ['D-page-cap-and-checkpoint-boundary'],
    context: {},
    fencing: 'shared',
    postconditions: [],
    priority: 'P1',
    status: 'decided',
    steps: [
      {
        kind: 'rpc',
        n: 1,
        request: { buckets: [{ params: { owner_id: USER_A }, table: 'todos' }], cursor: from, limit, schema_version: 1 },
        response: { signal: null, ...page },
        rpc: 'pull',
      },
    ],
    title: 'synthetic page',
  })

  const clausesOf = (transcript: unknown): string[] =>
    checkTranscript(transcript).flatMap((issue) => {
      const clause = /I-9 page limit accounting, clause ([a-f])/.exec(issue.message)?.[1]

      return clause === undefined ? [] : [clause]
    })

  test('an exact fit, continuation pages, a holed last page, and a signal page that echoes a continuation pass', () => {
    expect(checkTranscript(onePull({ limit: 2, from: '0', page: { cursor: '2', has_more: false, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual([])
    expect(checkTranscript(onePull({ limit: 2, from: '0', page: { cursor: '0:2', has_more: true, rows: [row(ROW_2, '2')], tombstones: [tombstone(ROW_1, '1')] } }))).toEqual([])
    expect(checkTranscript(onePull({ limit: 2, from: '5', page: { cursor: '5:7', has_more: true, rows: [row(ROW_1, '6'), row(ROW_2, '7')], tombstones: [] } }))).toEqual([])
    expect(checkTranscript(onePull({ limit: 2, from: '0:2', page: { cursor: '0:4', has_more: true, rows: [row(ROW_1, '3'), row(ROW_2, '4')], tombstones: [] } }))).toEqual([])
    expect(checkTranscript(onePull({ limit: 2, from: '0', page: { cursor: '3~1', has_more: true, rows: [row(ROW_2, '3')], tombstones: [] } }))).toEqual([])
    expect(checkTranscript(onePull({ limit: 2, from: '4:6', page: { cursor: '4:6', has_more: false, rows: [], tombstones: [], signal: { type: 'CHECKPOINT_EXPIRED' } } }))).toEqual([])
  })

  test('clause a: rows and tombstones together over the limit', () => {
    expect(clausesOf(onePull({ limit: 1, from: '0', page: { cursor: '2', has_more: false, rows: [row(ROW_2, '2')], tombstones: [tombstone(ROW_1, '1')] } }))).toEqual(['a'])
  })

  test('clauses a and b: a continuation page holds exactly the limit, never more', () => {
    expect(clausesOf(onePull({ limit: 1, from: '0', page: { cursor: '0:2', has_more: true, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['a', 'b'])
  })

  test('clauses b and c: a short page keeps has_more:true without holes', () => {
    expect(clausesOf(onePull({ limit: 3, from: '0', page: { cursor: '0:2', has_more: true, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['b', 'c'])
    expect(clausesOf(onePull({ limit: 3, from: '0', page: { cursor: '2', has_more: true, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['c', 'f'])
  })

  test('clause b: a final page never carries a start', () => {
    expect(clausesOf(onePull({ limit: 2, from: '0', page: { cursor: '0:2', has_more: false, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['b'])
  })

  test('clause f: a has_more:true page with a hole-free cursor carries a start', () => {
    expect(clausesOf(onePull({ limit: 2, from: '0', page: { cursor: '2', has_more: true, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['f'])
  })

  test('clause d: a continuation cursor pairs the highest entry seq with the transfer start', () => {
    expect(clausesOf(onePull({ limit: 2, from: '0', page: { cursor: '0:3', has_more: true, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['d'])
    expect(clausesOf(onePull({ limit: 2, from: '0', page: { cursor: '1:2', has_more: true, rows: [row(ROW_1, '1'), row(ROW_2, '2')], tombstones: [] } }))).toEqual(['d'])
    expect(clausesOf(onePull({ limit: 2, from: '4:6', page: { cursor: '6:8', has_more: true, rows: [row(ROW_1, '7'), row(ROW_2, '8')], tombstones: [] } }))).toEqual(['d'])
  })
})

// MARK: - D-corpus-soft-delete-and-refusal expect_error vocabulary

/**
 * `expect_error` on a `local` step names an engine error code. The schema keeps
 * it a plain string so a code added to the catalog needs no schema edit, which
 * puts the closed-vocabulary check here: a typo or a code outside the catalog must fail
 * loudly rather than pin an obligation no engine can raise (@../../../CONVENTIONS.md).
 */

describe('D-corpus-soft-delete-and-refusal expect_error names a catalog code', () => {
  const catalog = readJson('spec/engine-errors.json')
  const codes = new Set(
    (Array.isArray(catalog) ? catalog : [])
      .map((entry) => asObject(entry)?.code)
      .filter((code): code is string => typeof code === 'string')
  )

  test('the engine error catalog is not empty', () => {
    expect(codes.size).toBeGreaterThan(0)
  })

  test('default page limit matches the pack _pull_impl signature', () => {
    const sql = readFileSync(join(ROOT, '../supabase-pack/supabase/migrations/0001_kizuna_init.sql'), 'utf8')

    expect(sql).toMatch(new RegExp(`"limit"\\s+integer\\s+default ${DEFAULT_PAGE_LIMIT}`))
  })

  test('every expect_error is a member of the engine error catalog', () => {
    const unknown: string[] = []

    for (const [rel, entry] of transcriptEntries) {
      const steps = asObject(entry.json)?.steps

      for (const raw of Array.isArray(steps) ? steps : []) {
        const expected = asObject(raw)?.expect_error

        if (typeof expected === 'string' && !codes.has(expected)) {
          unknown.push(`${rel}: ${expected}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })
})

// MARK: - I-12 manifest bijection + case-id/path coherence

describe('I-12 corpus coherence', () => {
  test('case ids and the manifest bijection hold', () => {
    expect(checkCorpus(corpus.transcripts, corpus.manifest)).toEqual([])
  })
})

// MARK: - I-6 fixture discipline

describe('I-6 fixture discipline', () => {
  test('every placeholder UUID is registered', () => {
    expect(checkIdentifierRegistry(corpus.transcripts, readJson('fixtures/identifiers.json'))).toEqual([])
  })

  test('registry kind matches the placeholder code', () => {
    const empty = new Map<string, { raw: string; json: unknown }>()
    const mismatched = {
      '00000000-0000-4000-8000-a10000000001': { kind: 'client', label: 'user-a' },
    }
    const issues = checkIdentifierRegistry(empty, mismatched)

    expect(issues.some((issue) => issue.message.includes('does not match code a1'))).toBe(true)
  })

  test('every table and column exists in the fixture domain', () => {
    expect(checkDomainTables(corpus.transcripts, readJson('fixtures/domain.json'))).toEqual([])
  })

  test('the fixture domain keys every table by columns it has, and a transcript declares the same key columns (D-row-key)', () => {
    const domain = readJson('fixtures/domain.json') as { tables: Record<string, { key_columns?: unknown }> }
    const declaring = (keyColumns: unknown): Map<string, { raw: string; json: unknown }> =>
      new Map([['transcripts/synthetic.json', { raw: '', json: { context: { server: { tables: { seats: { bucket_column: 'owner_id', key_columns: keyColumns } } } } } }]])
    const unknownKey = { tables: { ...domain.tables, seats: { ...domain.tables.seats, key_columns: ['hall', 'row_no'] } } }

    expect(domain.tables.seats?.key_columns).toEqual(['hall', 'seat'])
    expect(checkDomainTables(declaring(['hall', 'seat']), domain)).toEqual([])
    expect(checkDomainTables(declaring(['seat', 'hall']), domain).map((issue) => issue.message)).toEqual([
      'key_columns ["seat","hall"] does not match fixtures/domain.json (["hall","seat"]) (I-6)',
    ])
    expect(checkDomainTables(declaring(['hall', 'row_no']), unknownKey).map((issue) => issue.message)).toContain(
      'key column "row_no" is not a column of table "seats" (I-6)',
    )
  })
})

// MARK: - I-7 decision registry + property citation grammar

describe('I-7 decision registry', () => {
  const registry = readJson('decisions/index.json')

  test('every referenced decision id exists in the registry', () => {
    expect(checkOpenDecisionRefs(corpus.transcripts, corpus.manifest, registry)).toEqual([])
  })

  test('kizunaOpen ids are open keys of the decision register', () => {
    const open = new Set(
      Object.entries(asObject(registry) ?? {})
        .filter(([, value]) => asObject(value)?.status === 'open')
        .map(([id]) => id),
    )
    const ids: string[] = []
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item)
        }
        return
      }
      if (node === null || typeof node !== 'object') {
        return
      }
      const record = node as Record<string, unknown>

      if (Array.isArray(record.kizunaOpen)) {
        for (const id of record.kizunaOpen) {
          if (typeof id === 'string') {
            ids.push(id)
          }
        }
      }
      if (record.kizunaStatus === 'open-decision' && Array.isArray(record.kizunaOpen)) {
        for (const id of record.kizunaOpen) {
          if (typeof id === 'string' && !open.has(id)) {
            ids.push(`stale-open-status:${id}`)
          }
        }
      }
      for (const value of Object.values(record)) {
        visit(value)
      }
    }
    for (const name of SCHEMA_FILES) {
      visit(readJson(`schemas/${name}`))
    }
    expect(ids.filter((id) => id.startsWith('stale-open-status:'))).toEqual([])

    for (const id of ids) {
      expect(open.has(id), id).toBe(true)
    }
  })

  test('kizunaNote harness/*.ts paths exist', () => {
    const missing: string[] = []
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item)
        }
        return
      }
      if (typeof node === 'string') {
        const match = node.match(/harness\/[A-Za-z0-9._-]+\.ts/g) ?? []

        for (const rel of match) {
          if (!existsSync(join(ROOT, rel))) {
            missing.push(rel)
          }
        }
        return
      }
      if (node === null || typeof node !== 'object') {
        return
      }
      for (const value of Object.values(node)) {
        visit(value)
      }
    }
    for (const name of SCHEMA_FILES) {
      visit(readJson(`schemas/${name}`))
    }
    expect(missing).toEqual([])
  })

  test('an unknown blocked_on decision id is rejected (I-12 ⊆ I-7)', () => {
    const syntheticManifest = {
      cases: [
        {
          blocked_on: ['D-dedup-storage-model99'],
          cites: ['P:schema-version-signalling'],
          fencing: 'shared',
          file: null,
          id: 'lifecycle/999-synthetic',
          priority: 'P1',
          status: 'open-decision',
          title: 'synthetic blocked case for the negative test',
        },
      ],
      future_flows: [],
    }
    const issues = checkOpenDecisionRefs(new Map(), syntheticManifest, registry)

    expect(issues).not.toEqual([])
    const first = issues[0]

    expect(first?.message).toContain('blocked_on D-dedup-storage-model99 is not in the decision registry')
  })

  corpus.properties.forEach((property, index) => {
    test(`properties[${index}] cites match the authority grammar`, () => {
      const cites = asObject(property)?.cites

      expect(Array.isArray(cites)).toBe(true)

      for (const cite of Array.isArray(cites) ? cites : []) {
        expect(typeof cite === 'string' && CITE_PATTERN.test(cite)).toBe(true)
      }
    })
  })
})
