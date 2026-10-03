/**
 * The explanation column is the changelog log's only prose cell, so every op
 * the pack's CHECK constraint permits is pinned to its exact sentence here: a
 * future edit cannot silently drift the meaning while still returning "a
 * string". The unrecognized-op path is pinned too: it degrades, never throws,
 * and never claims a delivery it cannot know about.
 */

import { describe, expect, test } from 'bun:test'
import { describeChange, ECHANGE_OP, type TChangeOp } from './describe-change'
import type { IChangelogRow } from './inspector-data'

// MARK: - Helpers

function rowOf(op: string): IChangelogRow {
  return {
    seq: 6024,
    table_name: 'todos',
    pk: 'f4a473af-8ee8-4897-8ed0-418ff2b2b06e',
    op,
    arrived_at: '2026-08-06T08:15:34.608248+00:00',
  }
}

// MARK: - Every op the pack allows

describe('describeChange', () => {
  test('upsert teaches when clients pull the write', () => {
    expect(describeChange(rowOf(ECHANGE_OP.UPSERT))).toBe(
      'a write landed on todos: clients pull it once their cursor passes step 6024',
    )
  })

  test('delete teaches that clients drop the row, not receive it', () => {
    expect(describeChange(rowOf(ECHANGE_OP.DELETE))).toBe(
      'a delete landed on todos: clients drop the row when their cursor passes step 6024',
    )
  })

  test('an unrecognized op degrades to a sentence rather than throwing', () => {
    expect(describeChange(rowOf('truncate'))).toBe(
      'an unrecognized operation "truncate" landed on todos: clients see it once their cursor passes step 6024',
    )
  })

  test('no sentence restates the row or the arrival time: both have their own columns', () => {
    const ops: TChangeOp[] = [ECHANGE_OP.UPSERT, ECHANGE_OP.DELETE]

    for (const op of ops) {
      const sentence = describeChange(rowOf(op))

      expect(sentence).not.toContain('f4a473af')
      expect(sentence).not.toContain('2026-08-06')
    }
  })
})
