import { describe, expect, test } from 'bun:test'
import { WIRE_TYPE_REGISTRY } from './wire-types.config'

describe('wire-types.config', () => {
  test('non-enum registry lists the 22 non-E-object exports in order', () => {
    expect(WIRE_TYPE_REGISTRY.map((e) => e.tsName)).toEqual([
      'TCursor', 'TSeq', 'TUuid', 'TIsoTimestamp', 'TColumnValue', 'TColumnValues',
      'TBucket', 'TPullRequest', 'TRowChange', 'TTombstone', 'TSignal', 'TPullResponse',
      'TMutation', 'TTransform', 'TConflict', 'TPushBatch', 'TPushRequest', 'TVerdictApplied', 'TVerdictRejected',
      'TVerdict', 'TBatchAbort', 'TPushResponse',
    ])
  })

  test('every source file is one of the 5 schema files', () => {
    const allowed = new Set([
      'common.schema.json', 'pull-request.schema.json', 'pull-response.schema.json',
      'push-request.schema.json', 'push-response.schema.json',
    ])

    for (const e of WIRE_TYPE_REGISTRY) {
      if (e.kind !== 'enum-ref') expect(allowed.has(e.source.file)).toBe(true)
    }
  })
})
