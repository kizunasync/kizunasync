/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { reReadsRows } from './re-reads-rows'
import { EConflictMode, EEngineEventType, ERejectReason, ESoftBlockReason, type TEngineEvent } from '../wire/types'

/** One event of every type the engine emits. */
const EVERY_EVENT: Record<TEngineEvent['type'], TEngineEvent> = {
  [EEngineEventType.LOCAL_CHANGED]: { type: EEngineEventType.LOCAL_CHANGED },
  [EEngineEventType.MUTATION_REJECTED]: { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.RLS_DENIED },
  [EEngineEventType.BATCH_ABORTED]: { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'm1', reason: ERejectReason.CONSTRAINT },
  [EEngineEventType.CHECKPOINT_EXPIRED]: { type: EEngineEventType.CHECKPOINT_EXPIRED },
  [EEngineEventType.RESET_REQUIRED]: { type: EEngineEventType.RESET_REQUIRED },
  [EEngineEventType.DEAD_LETTER]: { type: EEngineEventType.DEAD_LETTER, mutationId: 'm1', reason: 'permanent' },
  [EEngineEventType.QUEUE_DEPTH]: { type: EEngineEventType.QUEUE_DEPTH, depth: 2 },
  [EEngineEventType.COLUMN_OVERWRITTEN]: {
    type: EEngineEventType.COLUMN_OVERWRITTEN,
    table: 'todos',
    pk: 'p1',
    column: 'title',
    loserValue: 'mine',
    winnerMutationId: 'm2',
    conflictMode: EConflictMode.hlc,
  },
}

describe('reReadsRows', () => {
  test('a row read re-runs on a committed change and on the two lifecycle signals only', () => {
    const reReading = Object.values(EVERY_EVENT)
      .filter(reReadsRows)
      .map((event) => event.type)

    expect(reReading).toEqual([EEngineEventType.LOCAL_CHANGED, EEngineEventType.CHECKPOINT_EXPIRED, EEngineEventType.RESET_REQUIRED])
  })

  test('a reset carrying its reason re-reads like one without', () => {
    expect(reReadsRows({ type: EEngineEventType.RESET_REQUIRED, reason: ESoftBlockReason.identityChanged })).toBe(true)
  })
})
