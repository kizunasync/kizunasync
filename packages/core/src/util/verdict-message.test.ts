/// <reference types="bun" />
/**
 * verdictToMessage proves every current TEngineEvent variant maps to its
 * documented user-facing message (or null for internal/observability
 * events), and that a variant outside the closed union throws instead of
 * silently returning null (the exhaustiveness guard a future variant would
 * otherwise be absorbed by).
 */

import { describe, expect, test } from 'bun:test'
import { EVerdictLevel, verdictToMessage } from './verdict-message'
import { EConflictMode, EEngineEventType, ERejectReason, type TEngineEvent } from '../wire/types'

describe('verdictToMessage', () => {
  test('MUTATION_REJECTED maps to an error message naming the reason', () => {
    const event: TEngineEvent = { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.RLS_DENIED }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.error,
      title: 'Write rejected',
      message: 'You do not have permission to write this row.',
    })
  })

  test('MUTATION_REJECTED with COLUMN_DENIED names the writable-column refusal', () => {
    const event: TEngineEvent = { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'm1', reason: ERejectReason.COLUMN_DENIED }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.error,
      title: 'Write rejected',
      message: 'The server refused this write: your role cannot change one of the columns it touched.',
    })
  })

  test('BATCH_ABORTED maps to an error message naming the reason', () => {
    const event: TEngineEvent = { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'm1', reason: ERejectReason.PRECONDITION }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.error,
      title: 'Batch aborted',
      message: 'The row changed on the server first, so your edit was reverted.',
    })
  })

  test('DEAD_LETTER maps to an error message naming the raw reason', () => {
    const event: TEngineEvent = { type: EEngineEventType.DEAD_LETTER, mutationId: 'm1', reason: 'PERMANENT_TRANSPORT' }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.error,
      title: 'Sync gave up',
      message: 'Permanent failure: PERMANENT_TRANSPORT',
    })
  })

  test('CHECKPOINT_EXPIRED maps to an error message', () => {
    const event: TEngineEvent = { type: EEngineEventType.CHECKPOINT_EXPIRED }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.error,
      title: 'Checkpoint expired',
      message: 'The cursor fell behind the server, so the next sync rehydrates the local database.',
    })
  })

  test('RESET_REQUIRED maps to an error message', () => {
    const event: TEngineEvent = { type: EEngineEventType.RESET_REQUIRED }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.error,
      title: 'Reset required',
      message: 'The server refused this client, so sync is blocked until reset() runs.',
    })
  })

  test('LOCAL_CHANGED is not a verdict and maps to null', () => {
    const event: TEngineEvent = { type: EEngineEventType.LOCAL_CHANGED }

    expect(verdictToMessage(event)).toBeNull()
  })

  test('QUEUE_DEPTH is not a verdict and maps to null', () => {
    const event: TEngineEvent = { type: EEngineEventType.QUEUE_DEPTH, depth: 3 }

    expect(verdictToMessage(event)).toBeNull()
  })

  test('COLUMN_OVERWRITTEN names the table, the column and the losing value', () => {
    const event: TEngineEvent = {
      type: EEngineEventType.COLUMN_OVERWRITTEN,
      table: 'todos',
      pk: 'p1',
      column: 'title',
      loserValue: 'old',
      winnerMutationId: 'm1',
      conflictMode: EConflictMode.arrival,
    }

    expect(verdictToMessage(event)).toEqual({
      level: EVerdictLevel.warning,
      title: 'Column overwritten',
      message: 'Another device won todos.title, so your "old" was replaced.',
    })
  })

  test('an overwritten value too long to read is named rather than shown', () => {
    const event: TEngineEvent = {
      type: EEngineEventType.COLUMN_OVERWRITTEN,
      table: 'todos',
      pk: 'p1',
      column: 'notes',
      loserValue: 'x'.repeat(200),
      winnerMutationId: 'm1',
      conflictMode: EConflictMode.hlc,
    }

    expect(verdictToMessage(event)?.message).toBe(
      'Another device won todos.notes, so your value was replaced.',
    )
  })

  test('an overwritten null reads as an empty value rather than the word null', () => {
    const event: TEngineEvent = {
      type: EEngineEventType.COLUMN_OVERWRITTEN,
      table: 'todos',
      pk: 'p1',
      column: 'archived_at',
      loserValue: null,
      winnerMutationId: 'm1',
      conflictMode: EConflictMode.arrival,
    }

    expect(verdictToMessage(event)?.message).toBe(
      'Another device won todos.archived_at, so your empty value was replaced.',
    )
  })

  test('an overwrite is a warning, so the bindings do not latch it as lastError', () => {
    const event: TEngineEvent = {
      type: EEngineEventType.COLUMN_OVERWRITTEN,
      table: 'todos',
      pk: 'p1',
      column: 'title',
      loserValue: 'old',
      winnerMutationId: 'm1',
      conflictMode: EConflictMode.arrival,
    }

    expect(verdictToMessage(event)?.level).toBe(EVerdictLevel.warning)
  })

  test('an event type outside the closed union throws instead of silently returning null', () => {
    const bogus = { type: 'SOME_FUTURE_EVENT' } as unknown as TEngineEvent

    expect(() => verdictToMessage(bogus)).toThrow()
  })
})
