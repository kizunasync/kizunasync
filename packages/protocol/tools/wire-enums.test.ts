import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertCanonicalFile } from '../harness/canonical'

const HERE = import.meta.dir

describe('wire-enums.json', () => {
  test('is byte-canonical (C-1..C-9)', () => {
    const path = join(HERE, 'wire-enums.json')
    const raw = readFileSync(path, 'utf8')

    expect(() => assertCanonicalFile(path, raw)).not.toThrow()
  })

  test('reproduces the 6 wire E-objects in emission order', () => {
    const cfg = JSON.parse(readFileSync(join(HERE, 'wire-enums.json'), 'utf8'))

    expect(cfg.enums.map((e: { name: string }) => e.name)).toEqual([
      'EOp',
      'ESignalType',
      'ERejectReason',
      'EVerdictKind',
      'EBatchOutcome',
      'EConflictMode',
    ])
  })
})
