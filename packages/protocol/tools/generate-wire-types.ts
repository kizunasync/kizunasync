/**
 * Reads the schemas ($schema/$id + file-qualified $refs) and the two config
 * files, emits DETERMINISTIC TS to both mirrors. No fallback.
 */
// MARK: - generate-wire-types: schema-driven TS emitter (Bun, devtool only).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import enumConfig from './wire-enums.json'
import { WIRE_TYPE_REGISTRY, type TWireTypeEntry, type TSchemaRef } from './wire-types.config'

export type TWireEnumConfig = {
  name: string
  tsName: string
  members: string[]
  verify: { file: string; pointer: string }[]
}

export const loadSchemas = (schemasDir: string): Map<string, unknown> => {
  const out = new Map<string, unknown>()

  for (const name of readdirSync(schemasDir).sort()) {
    if (!name.endsWith('.schema.json')) {
      continue
    }
    out.set(name, JSON.parse(readFileSync(join(schemasDir, name), 'utf8')))
  }
  return out
}

const unescapeToken = (t: string): string => t.replace(/~1/g, '/').replace(/~0/g, '~')

export const resolvePointer = (doc: unknown, pointer: string): unknown => {
  if (pointer === '') {
    return doc
  }
  let cur: unknown = doc

  for (const rawTok of pointer.split('/').slice(1)) {
    const tok = unescapeToken(rawTok)

    if (cur === null || typeof cur !== 'object') {
      throw new Error(`resolvePointer: cannot descend into ${JSON.stringify(tok)} of ${pointer}`)
    }
    cur = (cur as Record<string, unknown>)[tok]

    if (cur === undefined) {
      throw new Error(`resolvePointer: missing ${pointer}`)
    }
  }
  return cur
}

/**
 * Every $id is https://schemas.kizunasync.dev/<name>.schema.json, so a
 * file-qualified $ref's left side is exactly the schema filename.
 */
export const resolveRef = (
  schemas: Map<string, unknown>,
  fromFile: string,
  ref: string,
): { file: string; node: unknown } => {
  const hash = ref.indexOf('#')

  if (hash < 0) {
    throw new Error(`resolveRef: ref must contain '#': ${ref}`)
  }
  const left = ref.slice(0, hash)
  const pointer = ref.slice(hash + 1)
  let file: string

  if (left === '') {
    file = fromFile
  } else if (schemas.has(left)) {
    file = left
  } else {
    throw new Error(`resolveRef: unsupported $ref (no remote/http refs): ${ref}`)
  }
  const doc = schemas.get(file)

  if (doc === undefined) {
    throw new Error(`resolveRef: unknown schema file ${file}`)
  }
  return { file, node: resolvePointer(doc, pointer) }
}

const annOf = (node: unknown, key: string): unknown =>
  node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined

export const buildJsDoc = (node: unknown, tsName: string): string => {
  const lines: string[] = []
  const note = annOf(node, 'kizunaNote')

  if (typeof note === 'string') {
    lines.push(note)
  }
  const status = annOf(node, 'kizunaStatus')

  if (typeof status === 'string') {
    lines.push(`@status ${status}`)
  }
  const cites = annOf(node, 'kizunaCites')

  if (Array.isArray(cites) && cites.length > 0) {
    lines.push(`@cites ${cites.join(', ')}`)
  }
  const open = annOf(node, 'kizunaOpen')

  if (Array.isArray(open) && open.length > 0) {
    lines.push(`@open ${open.join(', ')}`)
  }
  if (lines.length === 0) {
    return `/** ${tsName} */`
  }
  return ['/**', ...lines.map((l) => ` * ${l}`), ' */'].join('\n')
}

/** One `verify` location of a wire enum with the schema node its pointer resolves to. */
type TVerifySite = { config: TWireEnumConfig; location: TWireEnumConfig['verify'][number]; target: unknown }

function readConstArm({ config, location, target }: TVerifySite): string {
  if (typeof target !== 'string') {
    throw new Error(`drift: ${config.name} const at ${location.file}${location.pointer} is not a string`)
  }
  return target
}

function assertEnumArrayMatches({ config, location, target }: TVerifySite): void {
  if (!Array.isArray(target)) {
    throw new Error(`drift: ${config.name} enum at ${location.file}${location.pointer} is not an array`)
  }
  const schemaSet = new Set(target as string[])
  const configSet = new Set(config.members)
  const onlyInSchema = [...schemaSet].filter((m) => !configSet.has(m))
  const onlyInConfig = [...configSet].filter((m) => !schemaSet.has(m))

  if (onlyInSchema.length > 0 || onlyInConfig.length > 0) {
    throw new Error(
      `drift: ${config.name} at ${location.file}${location.pointer}: schema has {${[...schemaSet].sort().join(',')}} but config has {${[...configSet].sort().join(',')}}` +
      (onlyInSchema.length > 0 ? `; schema-only: [${onlyInSchema.join(',')}]` : '') +
      (onlyInConfig.length > 0 ? `; config-only: [${onlyInConfig.join(',')}]` : ''),
    )
  }
}

function assertConstArmsCover(config: TWireEnumConfig, constValues: Set<string>): void {
  const members = new Set(config.members)

  // The const arms COLLECTIVELY must reproduce exactly the config member set.
  if (config.verify.some((v) => v.pointer.endsWith('/const'))) {
    if (constValues.size !== members.size || [...constValues].some((c) => !members.has(c))) {
      throw new Error(
        `drift: ${config.name} const arms {${[...constValues].sort().join(',')}} != members {${[...members].sort().join(',')}}`,
      )
    }
  }
}

export const assertEnumDrift = (schemas: Map<string, unknown>, enums: TWireEnumConfig[]): void => {
  for (const e of enums) {
    const constValues = new Set<string>()

    for (const v of e.verify) {
      const doc = schemas.get(v.file)

      if (doc === undefined) {
        throw new Error(`drift: ${e.name} verify file ${v.file} missing`)
      }
      const site: TVerifySite = { config: e, location: v, target: resolvePointer(doc, v.pointer) }

      if (v.pointer.endsWith('/const')) {
        // A const arm pins exactly one member; collect them for a collective set check.
        constValues.add(readConstArm(site))
      } else {
        // An enum-array location must match the config members EXACTLY (set equality). wire-enums.json is the sole source of E-object names and member ordering. This exact-equality check prevents a value added to the schema enum but missing from wire-enums.json from being silently dropped in the generated E-object.
        assertEnumArrayMatches(site)
      }
    }
    assertConstArmsCover(e, constValues)
  }
}

export const ENUM_CONFIG = enumConfig.enums as TWireEnumConfig[]
export { WIRE_TYPE_REGISTRY, type TWireTypeEntry }

// MARK: - Type emission

// $ref target $defs name -> exported TS name. table_name has NO export (inline string).
const DEF_TO_TS: Record<string, string> = {
  uuid: 'TUuid',
  rowKey: 'TRowKey',
  seq: 'TSeq',
  cursor: 'TCursor',
  iso_timestamp: 'TIsoTimestamp',
  column_values: 'TColumnValues',
  mutation: 'TMutation',
  transform: 'TTransform',
  row_change: 'TRowChange',
  tombstone: 'TTombstone',
  signal: 'TSignal',
  verdict: 'TVerdict',
}

const refDefName = (ref: string): string => {
  const m = ref.match(/#\/\$defs\/([A-Za-z0-9_.-]+)$/)

  if (!m) {
    throw new Error(`refDefName: not a $defs ref: ${ref}`)
  }
  return m[1]!
}

const scalarOfType = (t: string): string => {
  switch (t) {
    case 'string': return 'string'
    case 'integer': return 'number'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    default: throw new Error(`scalarOfType: unsupported type ${t}`)
  }
}

/**
 * Sorted-member key -> E-object tsName, so an enum node resolves to its named alias
 * (op -> TOp, reason -> TRejectReason) instead of an inline literal union.
 */
const ENUM_BY_MEMBERS = new Map(ENUM_CONFIG.map((c) => [[...c.members].sort().join(' '), c.tsName]))

/**
 * Canonical scalar-union order (drop absent, keep relative order). Pins TColumnValue to
 * `boolean | number | string | null` regardless of the schema's oneOf order.
 */
const SCALAR_UNION_ORDER = ['boolean', 'number', 'string', 'null']
const isScalarUnion = (parts: string[]): boolean => parts.every((p) => SCALAR_UNION_ORDER.includes(p))

function emitRefType(ref: string): string {
  const def = refDefName(ref)

  if (def === 'table_name') {
    return 'string'
  }
  const mapped = DEF_TO_TS[def]

  if (!mapped) {
    throw new Error(`tsTypeOf: no TS name for $defs/${def}`)
  }
  return mapped
}

function emitEnumType(members: string[]): string {
  const key = [...members].sort().join(' ')
  const alias = ENUM_BY_MEMBERS.get(key)

  if (alias) {
    return alias
  }
  return members.map((v) => `'${v}'`).join(' | ')
}

/** A schema fragment to render as a TS type, the file its `$ref`s resolve from, and every loaded schema. */
type TTypeFragment<T> = { fragment: T; fromFile: string; schemas: Map<string, unknown> }

function emitOneOfType({ fragment: arms, fromFile, schemas }: TTypeFragment<unknown[]>): string {
  const parts = [...new Set(arms.map((b) => tsTypeOf(b, fromFile, schemas)))]

  // A pure-scalar oneOf emits in the canonical fixed order (boolean|number|string|null).
  if (isScalarUnion(parts)) {
    return SCALAR_UNION_ORDER.filter((s) => parts.includes(s)).join(' | ')
  }
  return parts.join(' | ')
}

function emitArrayType({ fragment: items, fromFile, schemas }: TTypeFragment<unknown>): string {
  if (items === undefined) {
    throw new Error('tsTypeOf: array without items')
  }
  const itemType = tsTypeOf(items, fromFile, schemas)

  return itemType.includes('|') ? `(${itemType})[]` : `${itemType}[]`
}

function emitObjectType({ fragment: n, fromFile, schemas }: TTypeFragment<Record<string, unknown>>): string {
  // A bare object with additionalProperties = a value schema -> Record<string, V>.
  const ap = n.additionalProperties

  if (ap !== undefined && ap !== false && typeof ap === 'object') {
    return `Record<string, ${tsTypeOf(ap, fromFile, schemas)}>`
  }
  // An object with explicit properties is emitted inline (used by sub-arms).
  return emitInlineObject(n, fromFile, schemas)
}

export const tsTypeOf = (node: unknown, fromFile: string, schemas: Map<string, unknown>): string => {
  if (node === null || typeof node !== 'object') {
    throw new Error('tsTypeOf: non-object node')
  }
  const n = node as Record<string, unknown>

  if (typeof n.$ref === 'string') {
    return emitRefType(n.$ref)
  }
  if (Array.isArray(n.oneOf)) {
    return emitOneOfType({ fragment: n.oneOf, fromFile, schemas })
  }
  if (Array.isArray(n.enum)) {
    return emitEnumType(n.enum as string[])
  }
  if (typeof n.const === 'string') {
    return `'${n.const}'`
  }
  const t = n.type

  if (t === 'array') {
    return emitArrayType({ fragment: n.items, fromFile, schemas })
  }
  if (t === 'object') {
    return emitObjectType({ fragment: n, fromFile, schemas })
  }
  if (typeof t === 'string') {
    return scalarOfType(t)
  }
  throw new Error(`tsTypeOf: cannot map node ${JSON.stringify(n).slice(0, 80)}`)
}

const propOptional = (n: Record<string, unknown>, key: string): boolean => {
  const required = Array.isArray(n.required) ? (n.required as string[]) : []

  return !required.includes(key)
}

const emitInlineObject = (n: Record<string, unknown>, fromFile: string, schemas: Map<string, unknown>): string => {
  const props = (n.properties ?? {}) as Record<string, unknown>
  const keys = Object.keys(props).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const fields = keys.map((k) => {
    const opt = propOptional(n, k) ? '?' : ''
    // base_hint is the lone any-shaped slot (no type/$ref) -> unknown.
    const child = props[k] as Record<string, unknown>
    const ty = child.$ref === undefined && child.type === undefined && child.oneOf === undefined && child.enum === undefined && child.const === undefined
      ? 'unknown'
      : tsTypeOf(child, fromFile, schemas)

    return `${k}${opt}: ${ty}`
  })

  return `{ ${fields.join('; ')} }`
}

const emitBlockObject = (entry: TWireTypeEntry, schemas: Map<string, unknown>): string => {
  const src = (entry as { source: TSchemaRef }).source
  const doc = schemas.get(src.file)
  const node = resolvePointer(doc, src.pointer) as Record<string, unknown>
  const props = (node.properties ?? {}) as Record<string, unknown>
  const keys = Object.keys(props).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const lines = keys.map((k) => {
    const opt = propOptional(node, k) ? '?' : ''
    const child = props[k] as Record<string, unknown>
    const ty = child.$ref === undefined && child.type === undefined && child.oneOf === undefined && child.enum === undefined && child.const === undefined
      ? 'unknown'
      : // const verdict discriminators emit `typeof EX.member` to match the hand-written mirror
        emitPropType(child, src.file, schemas)

    return `  ${k}${opt}: ${ty}`
  })

  return `${buildJsDoc(node, entry.tsName)}\nexport type ${entry.tsName} = {\n${lines.join('\n')}\n}`
}

// Discriminator const props render as `typeof EX.member` (matches the hand-written mirror).
const CONST_TO_EREF: Record<string, string> = {
  applied: 'EVerdictKind.applied',
  rejected: 'EVerdictKind.rejected',
  aborted: 'EBatchOutcome.aborted',
}
const emitPropType = (child: Record<string, unknown>, fromFile: string, schemas: Map<string, unknown>): string => {
  if (typeof child.const === 'string' && CONST_TO_EREF[child.const]) {
    return `typeof ${CONST_TO_EREF[child.const]}`
  }
  return tsTypeOf(child, fromFile, schemas)
}

const emitScalar = (entry: TWireTypeEntry, schemas: Map<string, unknown>): string => {
  const src = (entry as { source: TSchemaRef }).source
  const node = resolvePointer(schemas.get(src.file), src.pointer) as Record<string, unknown>
  const ty = tsTypeOf(node, src.file, schemas)

  return `${buildJsDoc(node, entry.tsName)}\nexport type ${entry.tsName} = ${ty}`
}

const emitUnion = (entry: TWireTypeEntry, schemas: Map<string, unknown>): string => {
  const src = (entry as { source: TSchemaRef }).source
  const node = resolvePointer(schemas.get(src.file), src.pointer) as Record<string, unknown>
  let ty: string

  if (entry.tsName === 'TVerdict') {
    ty = 'TVerdictApplied | TVerdictRejected'
  } else if (entry.tsName === 'TSignal') {
    ty = '{ type: TSignalType } | null'
  } else if (entry.tsName === 'TPushResponse') {
    ty = '{ verdicts: TVerdict[] } | { batch: TBatchAbort } | { signal: { type: TSignalType } }'
  } else {
    ty = tsTypeOf(node, src.file, schemas)
  }
  return `${buildJsDoc(node, entry.tsName)}\nexport type ${entry.tsName} = ${ty}`
}

const emitEnum = (cfg: TWireEnumConfig, schemas: Map<string, unknown>): string => {
  const sorted = [...cfg.members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const lines = sorted.map((m) => `  ${m}: '${m}',`)
  // JSDoc from the first verify location's node, when it carries annotations.
  const v0 = cfg.verify[0]!
  const node = resolvePointer(schemas.get(v0.file), v0.pointer.replace(/\/(enum|const)$/, ''))

  return [
    buildJsDoc(node, cfg.name),
    `export const ${cfg.name} = {`,
    ...lines,
    `} as const`,
    `export type ${cfg.tsName} = (typeof ${cfg.name})[keyof typeof ${cfg.name}]`,
  ].join('\n')
}

// TColumnValues is the one entry in the scalar slice whose kind is 'object', emitted as a Record<string, TColumnValue>.
const emitBlockRecord = (entry: TWireTypeEntry, schemas: Map<string, unknown>): string => {
  const src = (entry as { source: TSchemaRef }).source
  const node = resolvePointer(schemas.get(src.file), src.pointer) as Record<string, unknown>

  return `${buildJsDoc(node, entry.tsName)}\nexport type ${entry.tsName} = Record<string, TColumnValue>`
}

export const renderBody = (schemas: Map<string, unknown>): string => {
  assertEnumDrift(schemas, ENUM_CONFIG)
  const blocks: string[] = []

  // (1) scalars: first 7 registry entries
  for (const e of WIRE_TYPE_REGISTRY.slice(0, 7)) {
    blocks.push(e.tsName === 'TColumnValues' ? emitBlockRecord(e, schemas) : emitScalar(e, schemas))
  }
  // (2) E-objects in config order
  for (const c of ENUM_CONFIG) {
    blocks.push(emitEnum(c, schemas))
  }
  // (3) object/union types: remaining registry entries (index 7..)
  for (const e of WIRE_TYPE_REGISTRY.slice(7)) {
    if (e.kind === 'union') {
      blocks.push(emitUnion(e, schemas))
    } else {
      blocks.push(emitBlockObject(e, schemas))
    }
  }
  return blocks.join('\n\n') + '\n'
}

// MARK: - File writer

const PROTO_BANNER = [
  '/**',
  ' * @kizunasync/protocol: wire message types.',
  ' * GENERATED by tools/generate-wire-types.ts from schemas/*.schema.json: DO NOT EDIT.',
  ' * Run `bun run generate`; drift is caught by `bun run check:gen`.',
  ' * Open decisions (@open D-<slug>) are recorded under decisions/ (index: decisions/index.json).',
  ' */',
].join('\n')

const CORE_BANNER = [
  '/**',
  ' * @kizunasync/core engine: wire message types.',
  ' * GENERATED by @kizunasync/protocol tools/generate-wire-types.ts: DO NOT EDIT.',
  ' * Committed copy so the engine imports NO @kizunasync/protocol at runtime (one-way oracle/engine boundary).',
  ' * Run `bun run generate` in packages/protocol; drift is caught by `check:gen`.',
  ' */',
].join('\n')

export const renderFile = (banner: string, body: string): string => `${banner}\n\n${body}`

/** Both mirrors rendered in memory: identical body, distinct banner. */
export const renderWireTypes = (schemasDir: string): { proto: string; core: string } => {
  const body = renderBody(loadSchemas(schemasDir))

  return { proto: renderFile(PROTO_BANNER, body), core: renderFile(CORE_BANNER, body) }
}

export const main = (): void => {
  const root = join(import.meta.dir, '..')
  const rendered = renderWireTypes(join(root, 'schemas'))

  writeFileSync(join(root, 'spec', 'wire-types.ts'), rendered.proto)
  writeFileSync(join(root, '..', 'core', 'src', 'wire', 'wire-types.generated.ts'), rendered.core)
}

if (import.meta.main) {
  main()
}

