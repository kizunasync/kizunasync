import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { buildJsDoc, loadSchemas, resolvePointer, resolveRef, assertEnumDrift, renderBody, tsTypeOf } from './generate-wire-types'
import enumCfg from './wire-enums.json'

const SCHEMAS = join(import.meta.dir, '..', 'schemas')

describe('generate-wire-types helpers', () => {
  test('resolvePointer reaches a nested enum', () => {
    const schemas = loadSchemas(SCHEMAS)
    const node = resolvePointer(schemas.get('common.schema.json'), '/$defs/mutation/properties/op')

    expect((node as { enum: string[] }).enum).toEqual(['insert', 'update', 'delete'])
  })

  test('resolveRef handles file-qualified refs ($id-based)', () => {
    const schemas = loadSchemas(SCHEMAS)
    const { file, node } = resolveRef(schemas, 'pull-response.schema.json', 'common.schema.json#/$defs/uuid')

    expect(file).toBe('common.schema.json')
    expect((node as { type: string }).type).toBe('string')
  })

  test('resolveRef throws on a remote/http ref (no fallback)', () => {
    const schemas = loadSchemas(SCHEMAS)

    expect(() => resolveRef(schemas, 'common.schema.json', 'https://example.com/x#/$defs/y')).toThrow()
  })

  test('buildJsDoc derives @status/@cites/@open from annotations', () => {
    const node = { kizunaStatus: 'normative', kizunaCites: ['P:mutations-and-column-masked-conflict-resolution', 'P:verdict-completeness-transforms-and-conflict-rejection'], kizunaOpen: ['D-verdict-correlation'], kizunaNote: 'A note.' }
    const doc = buildJsDoc(node, 'TVerdict')

    expect(doc).toContain('@status normative')
    expect(doc).toContain('@cites P:mutations-and-column-masked-conflict-resolution, P:verdict-completeness-transforms-and-conflict-rejection')
    expect(doc).toContain('@open D-verdict-correlation')
    expect(doc).toContain('A note.')
  })

  test('assertEnumDrift passes for the committed schemas', () => {
    const schemas = loadSchemas(SCHEMAS)

    expect(() => assertEnumDrift(schemas, enumCfg.enums as never)).not.toThrow()
  })

  test('assertEnumDrift throws on drift', () => {
    const schemas = loadSchemas(SCHEMAS)
    // Tamper EOp (an enum-array location): a config member absent from the schema enum.
    const tamperedMember = structuredClone(enumCfg.enums)
    const eop = tamperedMember.find((e) => e.name === 'EOp')!

    eop.members = [...eop.members, 'upsert']
    expect(() => assertEnumDrift(schemas, tamperedMember as never)).toThrow()

    // Tamper EVerdictKind (const arms): drop a member so the collected const set {applied,rejected} != config members {applied}.
    const tamperedConst = structuredClone(enumCfg.enums)
    const everdict = tamperedConst.find((e) => e.name === 'EVerdictKind')!

    everdict.members = ['applied']
    expect(() => assertEnumDrift(schemas, tamperedConst as never)).toThrow()
  })

  test('assertEnumDrift throws when schema enum has a value absent from config (superset direction)', () => {
    // The enum-array guard requires exact equality between the schema enum and wire-enums.json: a value present in the schema enum but NOT in wire-enums.json config would otherwise be silently dropped from the generated E-object. We simulate this by patching the schema map so EOp gains an extra value.
    const schemas = loadSchemas(SCHEMAS)
    const tamperedSchemas = new Map(schemas)
    const common = structuredClone(schemas.get('common.schema.json')) as Record<string, unknown>
    // Inject 'upsert' into the schema enum: config still has only [delete, insert, update].
    const opEnum = (common.$defs as { mutation: { properties: { op: { enum: string[] } } } }).mutation.properties.op
      .enum

    opEnum.push('upsert')
    tamperedSchemas.set('common.schema.json', common)
    const err = expect(() => assertEnumDrift(tamperedSchemas, enumCfg.enums as never))

    err.toThrow(/schema-only/)
  })
})

describe('generate-wire-types emitters', () => {
  test('emits EOp as an as-const object with byte-sorted members', () => {
    const schemas = loadSchemas(SCHEMAS)
    const body = renderBody(schemas)

    expect(body).toContain("export const EOp = {")
    expect(body).toContain("  delete: 'delete',")
    expect(body).toContain("  insert: 'insert',")
    expect(body).toContain("  update: 'update',")
    expect(body).toContain('export type TOp = (typeof EOp)[keyof typeof EOp]')
  })

  test('emits the scalar union for TColumnValue', () => {
    const schemas = loadSchemas(SCHEMAS)

    expect(renderBody(schemas)).toContain(
      'export type TColumnValue = string | number | boolean | null | (boolean | number | string)[]',
    )
  })

  test('emits TPushResponse as a union of the three arms (verdicts | batch abort | stale-schema signal)', () => {
    const schemas = loadSchemas(SCHEMAS)
    const body = renderBody(schemas)

    expect(body).toContain(
      'export type TPushResponse = { verdicts: TVerdict[] } | { batch: TBatchAbort } | { signal: { type: TSignalType } }',
    )
  })

  test('emits TSignal as { type: TSignalType } | null', () => {
    const schemas = loadSchemas(SCHEMAS)

    expect(renderBody(schemas)).toContain('export type TSignal = { type: TSignalType } | null')
  })

  test('tsTypeOf maps a $ref to uuid as TUuid', () => {
    const schemas = loadSchemas(SCHEMAS)

    expect(tsTypeOf({ $ref: 'common.schema.json#/$defs/uuid' }, 'common.schema.json', schemas)).toBe('TUuid')
  })

  test('enum props reference named aliases, not inline literal unions', () => {
    const schemas = loadSchemas(SCHEMAS)
    const body = renderBody(schemas)

    expect(body).toContain('  op: TOp')
    expect(body).toContain('  reason: TRejectReason')
    expect(body).toContain('  verdict: typeof EVerdictKind.rejected')
  })
})
