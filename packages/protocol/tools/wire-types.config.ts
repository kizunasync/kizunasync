/**
 * The ordered map from TS export name to schema source, consumed by
 * tools/generate-wire-types.ts. Order IS the emitted file order.
 */

// MARK: - Wire-type registry

export type TSchemaRef = { file: string; pointer: string }

export type TWireTypeEntry =
  | { kind: 'scalar'; tsName: string; source: TSchemaRef }
  | { kind: 'object'; tsName: string; source: TSchemaRef }
  | { kind: 'union'; tsName: string; source: TSchemaRef }
  | { kind: 'enum-ref'; tsName: string; enumName: string }

const COMMON = 'common.schema.json'
const PULL_REQ = 'pull-request.schema.json'
const PULL_RES = 'pull-response.schema.json'
const PUSH_REQ = 'push-request.schema.json'
const PUSH_RES = 'push-response.schema.json'

export const WIRE_TYPE_REGISTRY: TWireTypeEntry[] = [
  { kind: 'scalar', source: { file: COMMON, pointer: '/$defs/cursor' }, tsName: 'TCursor' },
  { kind: 'scalar', source: { file: COMMON, pointer: '/$defs/seq' }, tsName: 'TSeq' },
  { kind: 'scalar', source: { file: COMMON, pointer: '/$defs/uuid' }, tsName: 'TUuid' },
  { kind: 'scalar', source: { file: COMMON, pointer: '/$defs/iso_timestamp' }, tsName: 'TIsoTimestamp' },
  { kind: 'scalar', source: { file: COMMON, pointer: '/$defs/column_values/additionalProperties' }, tsName: 'TColumnValue' },
  { kind: 'object', source: { file: COMMON, pointer: '/$defs/column_values' }, tsName: 'TColumnValues' },
  /**
   * E-objects (emitted from wire-enums.json, in that file's order) are spliced here
   * by the generator: the registry lists only the non-enum types below.
   */
  { kind: 'object', source: { file: PULL_REQ, pointer: '/properties/buckets/items' }, tsName: 'TBucket' },
  { kind: 'object', source: { file: PULL_REQ, pointer: '' }, tsName: 'TPullRequest' },
  { kind: 'object', source: { file: COMMON, pointer: '/$defs/row_change' }, tsName: 'TRowChange' },
  { kind: 'object', source: { file: COMMON, pointer: '/$defs/tombstone' }, tsName: 'TTombstone' },
  { kind: 'union', source: { file: COMMON, pointer: '/$defs/signal' }, tsName: 'TSignal' },
  { kind: 'object', source: { file: PULL_RES, pointer: '' }, tsName: 'TPullResponse' },
  { kind: 'object', source: { file: COMMON, pointer: '/$defs/mutation' }, tsName: 'TMutation' },
  { kind: 'union', source: { file: COMMON, pointer: '/$defs/transform' }, tsName: 'TTransform' },
  { kind: 'object', source: { file: PULL_RES, pointer: '/properties/conflicts/items' }, tsName: 'TConflict' },
  { kind: 'object', source: { file: PUSH_REQ, pointer: '/properties/batch' }, tsName: 'TPushBatch' },
  { kind: 'object', source: { file: PUSH_REQ, pointer: '' }, tsName: 'TPushRequest' },
  { kind: 'object', source: { file: COMMON, pointer: '/$defs/verdict/oneOf/0' }, tsName: 'TVerdictApplied' },
  { kind: 'object', source: { file: COMMON, pointer: '/$defs/verdict/oneOf/1' }, tsName: 'TVerdictRejected' },
  { kind: 'union', source: { file: COMMON, pointer: '/$defs/verdict' }, tsName: 'TVerdict' },
  { kind: 'object', source: { file: PUSH_RES, pointer: '/oneOf/1/properties/batch' }, tsName: 'TBatchAbort' },
  { kind: 'union', source: { file: PUSH_RES, pointer: '' }, tsName: 'TPushResponse' },
]
