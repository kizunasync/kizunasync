import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORPUS_NODES, RUST_ENUM_NAME, RUST_SCALAR_NAME, WIRE_SCHEMA_FILES, armsConstName, collectOneOfNodes, collectRequiredNodes, constName, corpusConstName, emitCall, emitLiteralMacro, emitScalarAlias, emitSliceConst, loadTranscripts, renderFile, selectPath, toUpperCamel } from './generate-rust-types'
import { ENUM_CONFIG, loadSchemas } from './generate-wire-types'

const SCHEMAS = join(import.meta.dir, '..', 'schemas')
const TRANSCRIPTS = join(import.meta.dir, '..', 'transcripts')
const GENERATED = join(import.meta.dir, '..', '..', '..', 'crates', 'kizunasync-protocol', 'src', 'generated.rs')

const render = (): string => renderFile(loadSchemas(SCHEMAS), loadTranscripts(TRANSCRIPTS), ENUM_CONFIG)

describe('generate-rust-types helpers', () => {
  test('toUpperCamel turns a wire member into a Rust variant', () => {
    expect(toUpperCamel('delete')).toBe('Delete')
    expect(toUpperCamel('RLS_DENIED')).toBe('RlsDenied')
    expect(toUpperCamel('CHECKPOINT_EXPIRED')).toBe('CheckpointExpired')
  })

  test('constName drops the $defs and properties noise tokens', () => {
    expect(constName('common.schema.json', '/$defs/row_change')).toBe('REQ_COMMON_ROW_CHANGE')
    expect(constName('push-response.schema.json', '/oneOf/1/properties/batch')).toBe('REQ_PUSH_RESPONSE_ONEOF_1_BATCH')
    expect(constName('pull-request.schema.json', '')).toBe('REQ_PULL_REQUEST')
    expect(armsConstName('common.schema.json', '/$defs/verdict')).toBe('ARMS_COMMON_VERDICT')
    expect(corpusConstName('EVerdictKind')).toBe('CORPUS_VERDICT_KIND')
  })

  test('selectPath walks arrays through the * segment', () => {
    const step = { request: { batch: { mutations: [{ op: 'insert' }, { op: 'delete' }] } } }

    expect(selectPath(step, 'request/batch/mutations/*/op')).toEqual(['insert', 'delete'])
    expect(selectPath(step, 'response/signal')).toEqual([])
  })

  test('collectRequiredNodes finds the nested required arrays', () => {
    const schemas = loadSchemas(SCHEMAS)
    const nodes = collectRequiredNodes('push-response.schema.json', schemas.get('push-response.schema.json'))
    const batch = nodes.find((n) => n.pointer === '/oneOf/1/properties/batch')

    expect(batch?.keys).toEqual(['offender_mutation_id', 'outcome', 'reason', 'server_row'])
  })

  test('collectOneOfNodes registers only arms that carry required keys', () => {
    const schemas = loadSchemas(SCHEMAS)
    const nodes = collectOneOfNodes('common.schema.json', schemas.get('common.schema.json'))

    // The signal union's null arm has no required keys, so only oneOf/1 is registered.
    expect(nodes.find((n) => n.pointer === '/$defs/signal')?.arms).toEqual(['/$defs/signal/oneOf/1'])
    expect(nodes.find((n) => n.pointer === '/$defs/verdict')?.arms).toEqual([
      '/$defs/verdict/oneOf/0',
      '/$defs/verdict/oneOf/1',
    ])
  })
})

describe('generate-rust-types rustfmt shapes', () => {
  test('emitSliceConst keeps a short array inline and explodes a wide one', () => {
    expect(emitSliceConst('pub const A: &[&str]', ['"a"', '"b"'])).toBe('pub const A: &[&str] = &["a", "b"];')
    const wide = emitSliceConst('pub const LONG: &[&str]', [`"${'x'.repeat(70)}"`])

    expect(wide.split('\n').length).toBe(3)
  })

  test('emitSliceConst measures rustfmt array_width on the bracketed list, not the & prefix', () => {
    const items = ['REQ_COMMON_TRANSFORM_ONEOF_0', 'REQ_COMMON_TRANSFORM_ONEOF_1']
    const emitted = emitSliceConst('pub const ARMS_COMMON_TRANSFORM: &[&[&str]]', items)

    expect(emitted).toBe(
      'pub const ARMS_COMMON_TRANSFORM: &[&[&str]] =\n    &[REQ_COMMON_TRANSFORM_ONEOF_0, REQ_COMMON_TRANSFORM_ONEOF_1];',
    )
  })

  test('emitCall breaks once the argument list passes the call budget', () => {
    expect(emitCall('    ', 'pins', ['Op::Delete', '"delete"'])).toBe('    pins(Op::Delete, "delete");')
    expect(emitCall('    ', 'pins', [`"${'y'.repeat(70)}"`, 'x'])).toContain('\n')
  })

  test('emitLiteralMacro lets a lone string literal overflow the call budget', () => {
    const short = emitLiteralMacro('    ', 'include_str!', '"./a.json"', ',')

    expect(short).toBe('    include_str!("./a.json"),')
    expect(emitLiteralMacro('    ', 'include_str!', `"${'z'.repeat(120)}"`, ',')).toContain('\n')
  })
})

describe('generate-rust-types emitter', () => {
  test('emits one closed enum per wire vocabulary with exact serde renames', () => {
    const body = render()

    for (const cfg of ENUM_CONFIG) {
      expect(body).toContain(`// wire-enum: ${cfg.name}`)
      expect(body).toContain(`pub enum ${RUST_ENUM_NAME[cfg.name]} {`)

      for (const member of cfg.members) {
        expect(body).toContain(`#[serde(rename = "${member}")]`)
      }
    }
  })

  test('carries the GENERATED banner and derives no silent catch-all variant', () => {
    const body = render()

    expect(body.split('\n')[0]).toBe(
      '// GENERATED: do not edit; regenerate with bun packages/protocol/tools/generate-rust-types.ts',
    )
    expect(body).not.toContain('serde(other)')
  })

  test('emits a required-field manifest for every node the schemas declare', () => {
    const body = render()
    const schemas = loadSchemas(SCHEMAS)

    for (const file of WIRE_SCHEMA_FILES) {
      for (const node of collectRequiredNodes(file, schemas.get(file))) {
        expect(body).toContain(`pub const ${constName(file, node.pointer)}: &[&str]`)
      }
    }
  })

  test('names the row key scalar RowKey, a String alias the pk fields share', () => {
    expect(RUST_SCALAR_NAME).toEqual({ rowKey: 'RowKey' })
    expect(render()).toContain('pub type RowKey = String;')
  })

  test('refuses a scalar alias whose def is absent or not a string', () => {
    expect(emitScalarAlias(new Map([['common.schema.json', { $defs: { rowKey: { type: 'string' } } }]]), 'rowKey')).toContain('pub type RowKey = String;')
    expect(() => emitScalarAlias(new Map([['common.schema.json', { $defs: {} }]]), 'rowKey')).toThrow('$defs/rowKey')
    expect(() => emitScalarAlias(new Map([['common.schema.json', { $defs: { rowKey: { type: 'integer' } } }]]), 'rowKey')).toThrow('$defs/rowKey')
  })

  test('every corpus node resolves to a manifest the emitter also declared', () => {
    const body = render()

    for (const node of CORPUS_NODES) {
      expect(body).toContain(`        path: "${node.path}",`)
    }
    expect(body).toContain('pub const CORPUS_NODES: &[CorpusNode] = &[')
  })
})

describe('generate-rust-types output', () => {
  test('two consecutive renders are byte-identical', () => {
    expect(render()).toBe(render())
  })

  test('the committed generated.rs is fresh', () => {
    expect(readFileSync(GENERATED, 'utf8')).toBe(render())
  })
})
