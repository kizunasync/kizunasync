/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { EConflictMode, EEngineEventType, ERejectReason, type TEngineEvent } from 'kizunasync'
import { createEngineEventLog, summarizeEngineEvent } from './engine-events'

describe('createEngineEventLog', () => {
  test('keeps recorded events in order', () => {
    const log = createEngineEventLog()

    log.record({ type: EEngineEventType.QUEUE_DEPTH, depth: 1 })
    log.record({ type: EEngineEventType.QUEUE_DEPTH, depth: 0 })

    expect(log.entries().map((entry) => entry.event)).toEqual([
      { type: EEngineEventType.QUEUE_DEPTH, depth: 1 },
      { type: EEngineEventType.QUEUE_DEPTH, depth: 0 },
    ])
  })

  test('the ring is capped and drops the oldest entry', () => {
    const log = createEngineEventLog(2)

    for (const depth of [1, 2, 3]) {
      log.record({ type: EEngineEventType.QUEUE_DEPTH, depth })
    }

    expect(log.entries().map((entry) => (entry.event as { depth: number }).depth)).toEqual([2, 3])
  })

  test('a subscriber hears every record until it unsubscribes', () => {
    const log = createEngineEventLog()
    let notified = 0
    const unsubscribe = log.subscribe(() => {
      notified += 1
    })

    log.record({ type: EEngineEventType.LOCAL_CHANGED })
    expect(notified).toBe(1)

    unsubscribe()
    log.record({ type: EEngineEventType.LOCAL_CHANGED })
    expect(notified).toBe(1)
  })
})

describe('summarizeEngineEvent', () => {
  test('a payload-free variant renders an empty cell', () => {
    expect(summarizeEngineEvent({ type: EEngineEventType.LOCAL_CHANGED })).toBe('')
    expect(summarizeEngineEvent({ type: EEngineEventType.CHECKPOINT_EXPIRED })).toBe('')
    expect(summarizeEngineEvent({ type: EEngineEventType.RESET_REQUIRED })).toBe('')
  })

  test('a payload variant joins its fields', () => {
    expect(summarizeEngineEvent({ type: EEngineEventType.QUEUE_DEPTH, depth: 3 })).toBe('depth 3')
    expect(
      summarizeEngineEvent({
        type: EEngineEventType.MUTATION_REJECTED,
        mutationId: 'm-1',
        reason: ERejectReason.RLS_DENIED,
      } satisfies Extract<TEngineEvent, { type: typeof EEngineEventType.MUTATION_REJECTED }>),
    ).toBe('m-1 · RLS_DENIED')
    expect(
      summarizeEngineEvent({
        type: EEngineEventType.COLUMN_OVERWRITTEN,
        table: 'todos',
        pk: 'row-1',
        column: 'title',
        loserValue: 'old title',
        winnerMutationId: 'm-2',
        conflictMode: EConflictMode.hlc,
      } satisfies Extract<TEngineEvent, { type: typeof EEngineEventType.COLUMN_OVERWRITTEN }>),
    ).toBe('todos.title · hlc')
  })
})
