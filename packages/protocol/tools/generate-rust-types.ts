/**
 * Reads wire-enums.json, the standardized schemas and the golden transcripts, emits
 * DETERMINISTIC Rust to crates/kizunasync-protocol/src/generated.rs. No fallback.
 *
 * Twin of generate-wire-types.ts (TS mirrors); the two share the schema loader, the
 * pointer resolver and the enum drift assertion so one source of truth feeds both.
 */
// MARK: - generate-rust-types: schema-driven Rust emitter (Bun, devtool only).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENUM_CONFIG, assertEnumDrift, loadSchemas, resolvePointer, type TWireEnumConfig } from './generate-wire-types'

/** The request/response surface a Rust client has to spell; the rest of schemas/ is tooling metadata. */
export const WIRE_SCHEMA_FILES = [
  'common.schema.json',
  'pull-request.schema.json',
  'pull-response.schema.json',
  'push-request.schema.json',
  'push-response.schema.json',
] as const

/**
 * Wire enum -> Rust type name. `Wire` marks a vocabulary whose plain name is already taken
 * by a broader hand-written type in the crate: `VerdictKind` also carries the reconcile-only
 * `merged`/`superseded` kinds, and `BatchOutcome` is the abort envelope struct, not the
 * `outcome` vocabulary. Both relations are documented in `crates/kizunasync-protocol/WIRE_ENUM_PARITY.md`.
 */
export const RUST_ENUM_NAME: Record<string, string> = {
  EBatchOutcome: 'WireBatchOutcome',
  EConflictMode: 'ConflictMode',
  EOp: 'Op',
  ERejectReason: 'RejectReason',
  ESignalType: 'SignalType',
  EVerdictKind: 'WireVerdictKind',
}

/**
 * Wire scalar `$defs` of `common.schema.json` -> Rust type alias. A pk field typed as the
 * row key reads as the key text of any primary key (D-row-key), where `Uuid` would mislead.
 */
export const RUST_SCALAR_NAME: Record<string, string> = {
  rowKey: 'RowKey',
}

type TCorpusNode = { rpc: 'pull' | 'push'; path: string; file: string; pointer: string }

/**
 * Where each schema node materializes inside an rpc step of a transcript. `*` walks an array.
 * Hand-maintained: the corpus step shape is not derivable from the wire schemas, which
 * describe only the request and response bodies.
 */
export const CORPUS_NODES: TCorpusNode[] = [
  { rpc: 'pull', path: 'request', file: 'pull-request.schema.json', pointer: '' },
  { rpc: 'pull', path: 'request/buckets/*', file: 'pull-request.schema.json', pointer: '/properties/buckets/items' },
  { rpc: 'pull', path: 'response', file: 'pull-response.schema.json', pointer: '' },
  { rpc: 'pull', path: 'response/conflicts/*', file: 'pull-response.schema.json', pointer: '/properties/conflicts/items' },
  { rpc: 'pull', path: 'response/rows/*', file: 'common.schema.json', pointer: '/$defs/row_change' },
  { rpc: 'pull', path: 'response/signal', file: 'common.schema.json', pointer: '/$defs/signal' },
  { rpc: 'pull', path: 'response/tombstones/*', file: 'common.schema.json', pointer: '/$defs/tombstone' },
  { rpc: 'push', path: 'request', file: 'push-request.schema.json', pointer: '' },
  { rpc: 'push', path: 'request/batch', file: 'push-request.schema.json', pointer: '/properties/batch' },
  { rpc: 'push', path: 'request/batch/mutations/*', file: 'common.schema.json', pointer: '/$defs/mutation' },
  { rpc: 'push', path: 'response', file: 'push-response.schema.json', pointer: '' },
  { rpc: 'push', path: 'response/batch', file: 'push-response.schema.json', pointer: '/oneOf/1/properties/batch' },
  { rpc: 'push', path: 'response/signal', file: 'push-response.schema.json', pointer: '/oneOf/2/properties/signal' },
  { rpc: 'push', path: 'response/verdicts/*', file: 'common.schema.json', pointer: '/$defs/verdict' },
]

type TCorpusEnumPath = { name: string; rpc: 'pull' | 'push'; path: string }

/** Corpus positions whose literal must be a member of a closed wire vocabulary. */
const CORPUS_ENUM_PATHS: TCorpusEnumPath[] = [
  { name: 'EBatchOutcome', rpc: 'push', path: 'response/batch/outcome' },
  { name: 'EConflictMode', rpc: 'pull', path: 'response/conflicts/*/conflict_mode' },
  { name: 'EOp', rpc: 'push', path: 'request/batch/mutations/*/op' },
  { name: 'ERejectReason', rpc: 'push', path: 'response/batch/reason' },
  { name: 'ERejectReason', rpc: 'push', path: 'response/verdicts/*/reason' },
  { name: 'ESignalType', rpc: 'pull', path: 'response/signal/type' },
  { name: 'ESignalType', rpc: 'push', path: 'response/signal/type' },
  { name: 'EVerdictKind', rpc: 'push', path: 'response/verdicts/*/verdict' },
]

// MARK: - Corpus loading

type TTranscript = { path: string; doc: unknown }

/** Every transcript under `dir`, byte-sorted by its slash path so the emit order is stable. */
export const loadTranscripts = (dir: string): TTranscript[] => {
  const out: TTranscript[] = []
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`

      if (entry.isDirectory()) {
        walk(join(abs, entry.name), childRel)
        continue
      }
      if (!entry.name.endsWith('.json')) {
        continue
      }
      out.push({ path: childRel, doc: JSON.parse(readFileSync(join(abs, entry.name), 'utf8')) })
    }
  }
  walk(dir, '')

  return out
}

function splitPathHead(path: string): { head: string; rest: string } {
  const slash = path.indexOf('/')

  return slash < 0 ? { head: path, rest: '' } : { head: path.slice(0, slash), rest: path.slice(slash + 1) }
}

/** Resolves a slash path, walking arrays at `*`; a missing or null node yields nothing. */
export const selectPath = (value: unknown, path: string): unknown[] => {
  if (path === '') {
    return value === null || value === undefined ? [] : [value]
  }
  const { head, rest } = splitPathHead(path)

  if (head === '*') {
    return Array.isArray(value) ? value.flatMap((item) => selectPath(item, rest)) : []
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }
  return selectPath((value as Record<string, unknown>)[head], rest)
}

/** rpc steps of a transcript, in step order. */
const rpcSteps = (doc: unknown): Record<string, unknown>[] => {
  const steps = (doc as { steps?: unknown }).steps

  if (!Array.isArray(steps)) {
    throw new Error('transcript has no steps array')
  }
  return steps.filter(
    (s): s is Record<string, unknown> =>
      s !== null && typeof s === 'object' && (s as Record<string, unknown>).kind === 'rpc',
  )
}

// MARK: - Schema structure extraction

type TRequiredNode = { file: string; pointer: string; keys: string[] }
type TOneOfNode = { file: string; pointer: string; arms: string[] }

const escapeToken = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1')

/** The `required` keys of a subschema, or null when it declares none. */
const requiredKeys = (node: unknown): string[] | null => {
  if (node === null || typeof node !== 'object') {
    return null
  }
  const required = (node as Record<string, unknown>).required

  return Array.isArray(required) && required.every((k) => typeof k === 'string') ? (required as string[]) : null
}

/** Visit every object subschema with its JSON pointer; child keys are visited byte-sorted. */
const walkSchema = (doc: unknown, visit: (node: Record<string, unknown>, pointer: string) => void): void => {
  const walk = (node: unknown, pointer: string): void => {
    if (node === null || typeof node !== 'object') {
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${pointer}/${index}`))

      return
    }
    const object = node as Record<string, unknown>

    visit(object, pointer)

    for (const key of Object.keys(object).sort()) {
      walk(object[key], `${pointer}/${escapeToken(key)}`)
    }
  }
  walk(doc, '')
}

/** Every subschema carrying a `required` array, in document order. */
export const collectRequiredNodes = (file: string, doc: unknown): TRequiredNode[] => {
  const out: TRequiredNode[] = []

  walkSchema(doc, (node, pointer) => {
    const keys = requiredKeys(node)

    if (keys !== null) {
      out.push({ file, pointer, keys: [...keys].sort() })
    }
  })

  return out
}

/** Every subschema whose `oneOf` arms are distinguishable by a required-key set. */
export const collectOneOfNodes = (file: string, doc: unknown): TOneOfNode[] => {
  const out: TOneOfNode[] = []

  walkSchema(doc, (node, pointer) => {
    if (!Array.isArray(node.oneOf)) {
      return
    }
    const arms = (node.oneOf as unknown[])
      .map((arm, index) => ({ arm, index }))
      .filter(({ arm }) => requiredKeys(arm) !== null)
      .map(({ index }) => `${pointer}/oneOf/${index}`)

    if (arms.length > 0) {
      out.push({ file, pointer, arms })
    }
  })

  return out
}

// MARK: - Rust naming

/** `RLS_DENIED` -> `RlsDenied`, `delete` -> `Delete`. */
export const toUpperCamel = (member: string): string =>
  member
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join('')

/** `REQ_` plus the file slug plus the pointer slug, with `$defs` and `properties` dropped: they carry no information. */
export const constName = (file: string, pointer: string): string => {
  const fileSlug = file.replace(/\.schema\.json$/, '').replace(/-/g, '_').toUpperCase()
  const tokens = pointer
    .split('/')
    .filter((t) => t !== '' && t !== '$defs' && t !== 'properties')
    .map((t) => t.replace(/-/g, '_').toUpperCase())

  return ['REQ', fileSlug, ...tokens].join('_')
}

export const armsConstName = (file: string, pointer: string): string =>
  constName(file, pointer).replace(/^REQ_/, 'ARMS_')

/** `EVerdictKind` -> `CORPUS_VERDICT_KIND`. */
export const corpusConstName = (wireName: string): string =>
  `CORPUS_${wireName.replace(/^E/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`

// MARK: - Rust emission

/** Default rustfmt budgets; the emitter reproduces them so `cargo fmt --check` stays clean. */
const MAX_WIDTH = 100
const ARRAY_WIDTH = 60
const FN_CALL_WIDTH = 60

/** rustfmt's shape ladder for `<decl> = &[<items>];`: one line, broken RHS, one item per line. */
export const emitSliceConst = (decl: string, items: string[]): string => {
  const inner = `[${items.join(', ')}]`
  const array = `&${inner}`

  if (inner.length <= ARRAY_WIDTH) {
    const inline = `${decl} = ${array};`

    return inline.length <= MAX_WIDTH ? inline : `${decl} =\n    ${array};`
  }
  return `${decl} = &[\n${items.map((i) => `    ${i},`).join('\n')}\n];`
}

/** rustfmt's shape ladder for a call/macro: one line while the argument list fits its budget. */
export const emitCall = (indent: string, head: string, args: string[], tail = ';'): string => {
  const list = args.join(', ')
  const inline = `${indent}${head}(${list})${tail}`

  if (list.length <= FN_CALL_WIDTH && inline.length <= MAX_WIDTH) {
    return inline
  }
  return `${indent}${head}(\n${args.map((a) => `${indent}    ${a}`).join(',\n')}\n${indent})${tail}`
}

/**
 * A macro whose only argument is a string literal may overflow the call budget; rustfmt
 * only breaks it once the whole line exceeds `max_width`.
 */
export const emitLiteralMacro = (indent: string, head: string, literal: string, tail: string): string => {
  const inline = `${indent}${head}(${literal})${tail}`

  if (inline.length <= MAX_WIDTH) {
    return inline
  }
  return `${indent}${head}(\n${indent}    ${literal}\n${indent})${tail}`
}

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const emitEnum = (cfg: TWireEnumConfig): string => {
  const rustName = RUST_ENUM_NAME[cfg.name]

  if (rustName === undefined) {
    throw new Error(`generate-rust-types: no Rust name for wire enum ${cfg.name}`)
  }
  const members = [...cfg.members].sort()
  const provenance = cfg.verify.map((v) => `/// Provenance: \`${v.file}#${v.pointer}\`.`)
  const variants = members.flatMap((m) => [
    `    /// Wire member \`${m}\` of \`${cfg.name}\`.`,
    `    #[serde(rename = ${quote(m)})]`,
    `    ${toUpperCamel(m)},`,
  ])

  return [
    `/// Closed wire vocabulary \`${cfg.name}\`.`,
    '///',
    ...provenance,
    `// wire-enum: ${cfg.name}`,
    '#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]',
    `pub enum ${rustName} {`,
    ...variants,
    '}',
  ].join('\n')
}

/** One `pub type` alias for a string scalar of `common.schema.json`. A def that is absent or not a string fails loud. */
export function emitScalarAlias(schemas: Map<string, unknown>, def: string): string {
  const pointer = `/$defs/${def}`
  const rustName = RUST_SCALAR_NAME[def]
  const node = resolvePointer(schemas.get('common.schema.json'), pointer)

  if (rustName === undefined || node === null || typeof node !== 'object' || !('type' in node) || node.type !== 'string') {
    throw new Error(`generate-rust-types: common.schema.json#${pointer} is not a string scalar with a Rust name`)
  }
  return [
    `/// Wire scalar \`${def}\`, carried as a JSON string.`,
    '///',
    `/// Provenance: \`common.schema.json#${pointer}\`.`,
    `pub type ${rustName} = String;`,
  ].join('\n')
}

const emitCorpusNode = (
  node: TCorpusNode,
  required: Map<string, TRequiredNode>,
  oneOf: Map<string, TOneOfNode>,
): string => {
  const key = `${node.file}#${node.pointer}`
  const arm = oneOf.get(key)
  const req = required.get(key)

  if (arm === undefined && req === undefined) {
    throw new Error(`generate-rust-types: corpus node ${key} has neither required keys nor oneOf arms`)
  }
  return [
    '    CorpusNode {',
    `        rpc: ${quote(node.rpc)},`,
    `        path: ${quote(node.path)},`,
    `        schema: ${quote(node.file)},`,
    `        pointer: ${quote(node.pointer)},`,
    `        required: ${req === undefined ? '&[]' : constName(node.file, node.pointer)},`,
    `        arms: ${arm === undefined ? '&[]' : armsConstName(node.file, node.pointer)},`,
    '    },',
  ].join('\n')
}

type TSchemaNodes = { required: TRequiredNode[]; oneOf: TOneOfNode[] }

function collectSchemaNodes(schemas: Map<string, unknown>): TSchemaNodes {
  const required: TRequiredNode[] = []
  const oneOf: TOneOfNode[] = []

  for (const file of WIRE_SCHEMA_FILES) {
    const doc = schemas.get(file)

    if (doc === undefined) {
      throw new Error(`generate-rust-types: missing schema ${file}`)
    }
    required.push(...collectRequiredNodes(file, doc))
    oneOf.push(...collectOneOfNodes(file, doc))
  }
  return { required, oneOf }
}

function assertUniqueConstNames(required: TRequiredNode[]): void {
  const names = new Set<string>()

  for (const node of required) {
    const name = constName(node.file, node.pointer)

    if (names.has(name)) {
      throw new Error(`generate-rust-types: duplicate const name ${name}`)
    }
    names.add(name)
  }
}

function emitRequiredManifests({ required, oneOf }: TSchemaNodes): string[] {
  const blocks: string[] = []

  for (const node of required) {
    const decl = `pub const ${constName(node.file, node.pointer)}: &[&str]`

    blocks.push(
      `/// Required properties of \`${node.file}#${node.pointer}\`.\n` +
        emitSliceConst(decl, node.keys.map(quote)),
    )
  }
  for (const node of oneOf) {
    // An arm without its own `required` (the bare `null` signal arm) carries no obligation.
    const decl = `pub const ${armsConstName(node.file, node.pointer)}: &[&[&str]]`

    blocks.push(
      `/// Required properties per \`oneOf\` arm of \`${node.file}#${node.pointer}\`.\n` +
        emitSliceConst(decl, node.arms.map((arm) => constName(node.file, arm))),
    )
  }
  return blocks
}

const CORPUS_NODE_STRUCT = [
  '// MARK: - Corpus structure',
  '',
  '/// One structural checkpoint inside an rpc step of the golden transcript corpus.',
  'pub struct CorpusNode {',
  '    /// The rpc the step invokes: `pull` or `push`.',
  '    pub rpc: &\'static str,',
  '    /// Slash path inside the step object; `*` walks an array.',
  '    pub path: &\'static str,',
  '    /// The schema file that owns the node.',
  '    pub schema: &\'static str,',
  '    /// JSON pointer of the node inside that schema.',
  '    pub pointer: &\'static str,',
  '    /// Required keys, empty when the node is a `oneOf`.',
  '    pub required: &\'static [&\'static str],',
  '    /// Required keys per `oneOf` arm, empty when the node is a plain object.',
  '    pub arms: &\'static [&\'static [&\'static str]],',
  '}',
].join('\n')

function emitCorpusNodes({ required, oneOf }: TSchemaNodes): string {
  const requiredByKey = new Map(required.map((n) => [`${n.file}#${n.pointer}`, n]))
  const oneOfByKey = new Map(oneOf.map((n) => [`${n.file}#${n.pointer}`, n]))

  return [
    '/// Where each wire schema node appears inside an rpc step.',
    'pub const CORPUS_NODES: &[CorpusNode] = &[',
    ...CORPUS_NODES.map((n) => emitCorpusNode(n, requiredByKey, oneOfByKey)),
    '];',
  ].join('\n')
}

function collectCorpusLiterals(transcript: TTranscript, entry: TCorpusEnumPath): string[] {
  const literals: string[] = []

  for (const step of rpcSteps(transcript.doc)) {
    if (step.rpc !== entry.rpc) {
      continue
    }
    for (const value of selectPath(step, entry.path)) {
      if (typeof value !== 'string') {
        throw new Error(`generate-rust-types: ${transcript.path} ${entry.path} is not a string`)
      }
      literals.push(value)
    }
  }
  return literals
}

function emitObservedVocabulary(cfg: TWireEnumConfig, transcripts: TTranscript[]): string {
  const observed = new Set<string>()

  for (const entry of CORPUS_ENUM_PATHS.filter((p) => p.name === cfg.name)) {
    for (const t of transcripts) {
      for (const value of collectCorpusLiterals(t, entry)) {
        observed.add(value)
      }
    }
  }
  const rustName = RUST_ENUM_NAME[cfg.name]!

  return (
    `/// \`${cfg.name}\` literals the golden corpus carries; every one must parse into \`${rustName}\`.\n` +
    emitSliceConst(`pub const ${corpusConstName(cfg.name)}: &[&str]`, [...observed].sort().map(quote))
  )
}

const HEADER = [
  '// GENERATED: do not edit; regenerate with bun packages/protocol/tools/generate-rust-types.ts',
  '',
  '//! Closed wire vocabularies and schema structure mirrored from `packages/protocol`.',
  '//!',
  '//! Sources of truth: `tools/wire-enums.json` (the vocabularies), `schemas/*.schema.json`',
  '//! (the required-field manifests) and `transcripts/**` (the golden corpus the tests below',
  '//! replay). Drift is caught by `check:gen-rust` in `@kizunasync/protocol`, which regenerates',
  '//! this file and fails on a diff.',
].join('\n')

const TEST_OPEN = `#[cfg(test)]
// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::{PullResponse, PushResponse};
    use serde_json::Value;
`

const TEST_HELPERS = `    /// Collect every value a \`CorpusNode.path\` addresses inside one rpc step.
    fn select<'a>(value: &'a Value, path: &str, out: &mut Vec<&'a Value>) {
        if path.is_empty() {
            out.push(value);
            return;
        }
        let (head, rest) = path.split_once('/').unwrap_or((path, ""));
        if head == "*" {
            if let Some(items) = value.as_array() {
                for item in items {
                    select(item, rest, out);
                }
            }
            return;
        }
        if let Some(child) = value.get(head) {
            select(child, rest, out);
        }
    }

    fn assert_node(transcript: &str, node: &CorpusNode, value: &Value) {
        if node.arms.is_empty() {
            for key in node.required {
                assert!(
                    value.get(*key).is_some(),
                    "{transcript}: {}{} requires \`{key}\`, absent at step path \`{}\`",
                    node.schema,
                    node.pointer,
                    node.path
                );
            }
            return;
        }
        let matched = node
            .arms
            .iter()
            .any(|arm| arm.iter().all(|key| value.get(*key).is_some()));
        assert!(
            matched,
            "{transcript}: value at step path \`{}\` matches no oneOf arm of {}{}",
            node.path, node.schema, node.pointer
        );
    }

    fn transcript_steps(name: &str, raw: &str) -> Vec<Value> {
        let doc: Value =
            serde_json::from_str(raw).unwrap_or_else(|e| panic!("{name}: not valid JSON: {e}"));
        let steps = doc
            .get("steps")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{name}: no steps array"));
        steps
            .iter()
            .filter(|s| s.get("kind").and_then(Value::as_str) == Some("rpc"))
            .cloned()
            .collect()
    }

    fn rpc_of(name: &str, step: &Value) -> String {
        step.get("rpc")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{name}: rpc step without an \`rpc\` key"))
            .to_string()
    }

    #[test]
    fn corpus_rpc_steps_satisfy_the_schema_manifests() {
        let mut checked = 0usize;
        for (name, raw) in TRANSCRIPTS {
            for step in transcript_steps(name, raw) {
                let rpc = rpc_of(name, &step);
                for node in CORPUS_NODES.iter().filter(|n| n.rpc == rpc) {
                    let mut found = Vec::new();
                    select(&step, node.path, &mut found);
                    for value in found {
                        if value.is_null() {
                            continue;
                        }
                        assert_node(name, node, value);
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 0, "the corpus produced no structural assertion");
    }

    #[test]
    fn corpus_responses_round_trip_through_the_hand_written_types() {
        let mut checked = 0usize;
        for (name, raw) in TRANSCRIPTS {
            for step in transcript_steps(name, raw) {
                let rpc = rpc_of(name, &step);
                let Some(response) = step.get("response") else {
                    continue;
                };
                match rpc.as_str() {
                    "push" => assert_stable::<PushResponse>(name, response),
                    "pull" => assert_stable::<PullResponse>(name, response),
                    other => panic!("{name}: unsupported rpc {other}"),
                }
                checked += 1;
            }
        }
        assert!(checked > 0, "the corpus produced no response round-trip");
    }

    /// A corpus response must parse into the crate's type and survive a re-emit unchanged.
    fn assert_stable<T>(name: &str, response: &Value)
    where
        T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let typed: T = serde_json::from_value(response.clone())
            .unwrap_or_else(|e| panic!("{name}: response does not parse: {e}"));
        let reemitted =
            serde_json::to_value(&typed).unwrap_or_else(|e| panic!("{name}: re-emit failed: {e}"));
        let again: T = serde_json::from_value(reemitted)
            .unwrap_or_else(|e| panic!("{name}: re-emitted response does not parse: {e}"));
        assert_eq!(typed, again, "{name}: response is not serde-stable");
    }

    /// The JSON string a closed vocabulary serializes to.
    fn wire<T: Serialize>(value: T) -> String {
        match serde_json::to_value(value) {
            Ok(Value::String(s)) => s,
            other => panic!("a wire vocabulary must serialize to a string, got {other:?}"),
        }
    }

    /// Parse a wire literal; \`None\` when the closed vocabulary does not cover it.
    fn read<T: serde::de::DeserializeOwned>(literal: &str) -> Option<T> {
        serde_json::from_value(Value::String(literal.to_string())).ok()
    }

    /// A variant must serialize to exactly \`literal\` and parse back from it.
    fn pins<T>(value: T, literal: &str)
    where
        T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug + Copy,
    {
        assert_eq!(wire(value), literal);
        assert_eq!(read::<T>(literal), Some(value));
    }

    /// Every literal the corpus carries at this vocabulary's positions must parse.
    fn covers<T: serde::de::DeserializeOwned>(name: &str, corpus: &[&str]) {
        for literal in corpus {
            assert!(
                read::<T>(literal).is_some(),
                "{name} cannot spell {literal}"
            );
        }
    }
`

export const renderBody = (
  schemas: Map<string, unknown>,
  transcripts: TTranscript[],
  enums: TWireEnumConfig[],
): string => {
  assertEnumDrift(schemas, enums)

  const nodes = collectSchemaNodes(schemas)

  assertUniqueConstNames(nodes.required)

  return [
    '// MARK: - Wire scalars',
    ...Object.keys(RUST_SCALAR_NAME).map((def) => emitScalarAlias(schemas, def)),
    '// MARK: - Wire vocabularies',
    ...enums.map((cfg) => emitEnum(cfg)),
    '// MARK: - Schema required-field manifests',
    ...emitRequiredManifests(nodes),
    CORPUS_NODE_STRUCT,
    emitCorpusNodes(nodes),
    '// MARK: - Vocabulary observed in the corpus',
    ...enums.map((cfg) => emitObservedVocabulary(cfg, transcripts)),
  ].join('\n\n')
}

const emitTests = (transcripts: TTranscript[], enums: TWireEnumConfig[]): string => {
  const fixtures = transcripts.map((t) =>
    [
      '        (',
      `            ${quote(t.path)},`,
      emitLiteralMacro('            ', 'include_str!', quote(`../../../packages/protocol/transcripts/${t.path}`), ','),
      '        ),',
    ].join('\n'),
  )
  const pins = enums.flatMap((cfg) =>
    [...cfg.members]
      .sort()
      .map((m) => emitCall('        ', 'pins', [`${RUST_ENUM_NAME[cfg.name]!}::${toUpperCamel(m)}`, quote(m)])),
  )
  const covers = enums.map((cfg) => {
    const rustName = RUST_ENUM_NAME[cfg.name]!

    return emitCall('        ', `covers::<${rustName}>`, [quote(rustName), corpusConstName(cfg.name)])
  })

  return [
    TEST_OPEN,
    '    /// The golden corpus, embedded so a moved or renamed transcript breaks the build.',
    '    const TRANSCRIPTS: &[(&str, &str)] = &[',
    ...fixtures,
    '    ];',
    '',
    TEST_HELPERS,
    '    #[test]',
    '    fn closed_vocabularies_use_the_exact_wire_casing() {',
    ...pins,
    '    }',
    '',
    '    #[test]',
    '    fn closed_vocabularies_cover_the_corpus() {',
    ...covers,
    '    }',
    '}',
    '',
  ].join('\n')
}

const IMPORTS = 'use serde::{Deserialize, Serialize};'

export const renderFile = (
  schemas: Map<string, unknown>,
  transcripts: TTranscript[],
  enums: TWireEnumConfig[],
): string => {
  const body = renderBody(schemas, transcripts, enums)

  return `${HEADER}\n\n${IMPORTS}\n\n${body}\n\n${emitTests(transcripts, enums)}`
}

export const main = (): void => {
  const schemas = loadSchemas(join(import.meta.dir, '..', 'schemas'))
  const transcripts = loadTranscripts(join(import.meta.dir, '..', 'transcripts'))
  const target = join(import.meta.dir, '..', '..', '..', 'crates', 'kizunasync-protocol', 'src', 'generated.rs')

  writeFileSync(target, renderFile(schemas, transcripts, ENUM_CONFIG))
}

if (import.meta.main) {
  main()
}
