/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { EScenarioRole } from '../runtime/demo-config'
import { deriveScenarioRowId } from './scenario-row-id'

/**
 * The three properties the scripted scenarios depend on so that two visitors
 * never contend one pk: stable per visitor, distinct across visitors, distinct
 * across scenarios, and always a well-formed uuid, because the column is
 * `uuid`.
 */
const VISITOR = '6f1b6a4e-0f9c-4a1e-9a4f-2c5d1e8b7a30'
const OTHER_VISITOR = 'b2c9d7a1-4e3f-4b8c-8d21-9f6e5a4c3b21'

const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('deriveScenarioRowId', () => {
  test('the same visitor and role always derive the same id (both panes, and across reloads)', async () => {
    const first = await deriveScenarioRowId(VISITOR, EScenarioRole.conflict)
    const second = await deriveScenarioRowId(VISITOR, EScenarioRole.conflict)

    expect(second).toBe(first)
  })

  test('two visitors never contend the same pk', async () => {
    const mine = await deriveScenarioRowId(VISITOR, EScenarioRole.conflict)
    const theirs = await deriveScenarioRowId(OTHER_VISITOR, EScenarioRole.conflict)

    expect(theirs).not.toBe(mine)
  })

  test("the two scenarios never overwrite each other's row", async () => {
    const conflict = await deriveScenarioRowId(VISITOR, EScenarioRole.conflict)
    const softDelete = await deriveScenarioRowId(VISITOR, EScenarioRole.softDelete)

    expect(softDelete).not.toBe(conflict)
  })

  test('the derived id is a well-formed v4-shaped uuid', async () => {
    for (const role of Object.values(EScenarioRole)) {
      expect(await deriveScenarioRowId(OTHER_VISITOR, role)).toMatch(UUID_V4_SHAPE)
    }
  })
})
