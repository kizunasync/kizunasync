/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { validateAgainst } from './ajv-validate'

const PULL_REQUEST = {
  buckets: [{ params: { owner_id: '00000000-0000-4000-8000-a10000000001' }, table: 'todos' }],
  cursor: '0',
  limit: 500,
  schema_version: 1,
}

describe('ajv-validate', () => {
  test('a valid pull request returns no issues', () => {
    expect(validateAgainst('pull-request', PULL_REQUEST)).toEqual([])
  })

  test('a JSON-number cursor is rejected', () => {
    expect(validateAgainst('pull-request', { ...PULL_REQUEST, cursor: 0 })).not.toEqual([])
  })

  test('kizuna* annotation keywords do not error the build', () => {
    // common.schema.json is dense with kizunaCites/kizunaNote/kizunaStatus/kizunaOpen; if ajv strict-mode rejected them, every validateAgainst call would throw.
    expect(Array.isArray(validateAgainst('pull-response', { cursor: '0' }))).toBe(true)
  })
})
