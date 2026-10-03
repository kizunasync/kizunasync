/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { EConflictMode, EEngineEventType, ERejectReason, ERpcKind, EWireEntryKind } from '@kizunasync/core'
import { createWireLog, isRejection, labelEntry, summarizeEngineEventShort, summarizeEntry, WIRE_RING_CAP } from './wire-log'

/**
 * The wire viewer is the demo's only claim to showing "every byte", so pin the
 * ring behind it: the cap holds, both panes interleave in real time
 * order, and every TEngineEvent variant renders (the exhaustiveness guard throws
 * rather than silently printing nothing). No database and no network: this is
 * the pure display layer.
 */
// MARK: - Wire-log ring

describe('the wire ring', () => {
  test('keeps the newest entries and drops the oldest past the cap', () => {
    const log = createWireLog()

    for (let index = 0; index < WIRE_RING_CAP + 25; index += 1) {
      log.record('A', { kind: EWireEntryKind.note, text: `entry ${String(index)}` })
    }
    const entries = log.entries()

    expect(entries).toHaveLength(WIRE_RING_CAP)
    expect(summarizeEntry(entries[0]!)).toBe('entry 25')
    expect(summarizeEntry(entries[entries.length - 1]!)).toBe(`entry ${String(WIRE_RING_CAP + 24)}`)
  })

  test('interleaves both panes in the order they wrote', () => {
    const log = createWireLog()

    log.record('A', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.LOCAL_CHANGED } })
    log.record('B', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.push, bytesOut: 210, bytesIn: 64, durationMs: 12, ok: true } })
    log.record('A', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.pull, bytesOut: 96, bytesIn: 1536, durationMs: 8, ok: true } })

    expect(log.entries().map((entry) => entry.pane)).toEqual(['A', 'B', 'A'])
  })

  test('notifies subscribers and stops after unsubscribe', () => {
    const log = createWireLog()
    let notifications = 0
    const unsubscribe = log.subscribe(() => {
      notifications += 1
    })

    log.record('A', { kind: EWireEntryKind.note, text: 'one' })
    unsubscribe()
    log.record('A', { kind: EWireEntryKind.note, text: 'two' })

    expect(notifications).toBe(1)
    expect(log.entries()).toHaveLength(2)
  })

  test('clear empties the ring', () => {
    const log = createWireLog()

    log.record('B', { kind: EWireEntryKind.note, text: 'something' })
    log.clear()

    expect(log.entries()).toHaveLength(0)
  })
})

// MARK: - Rendering

describe('entry rendering', () => {
  test('a payload-free variant renders an empty cell', () => {
    const events = [{ type: EEngineEventType.LOCAL_CHANGED }, { type: EEngineEventType.CHECKPOINT_EXPIRED }, { type: EEngineEventType.RESET_REQUIRED }] as const

    for (const event of events) {
      expect(summarizeEngineEventShort(event)).toBe('')
    }
  })

  test('summarizes every payload-carrying engine-event variant', () => {
    const events = [
      { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'abcdef01-0000-4000-8000-000000000000', reason: ERejectReason.RLS_DENIED },
      { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'abcdef02-0000-4000-8000-000000000000', reason: ERejectReason.RLS_DENIED },
      { type: EEngineEventType.DEAD_LETTER, mutationId: 'abcdef03-0000-4000-8000-000000000000', reason: 'transport' },
      { type: EEngineEventType.QUEUE_DEPTH, depth: 3 },
      {
        type: EEngineEventType.COLUMN_OVERWRITTEN,
        table: 'todos',
        pk: 'abcdef07-0000-4000-8000-000000000000',
        column: 'title',
        loserValue: 'old',
        winnerMutationId: 'abcdef08-0000-4000-8000-000000000000',
        conflictMode: EConflictMode.arrival,
      },
    ] as const

    for (const event of events) {
      expect(summarizeEngineEventShort(event).length).toBeGreaterThan(0)
    }
  })

  test('shortens the mutation id for the three variants that carry one', () => {
    const rejected = { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'abcdef01-0000-4000-8000-000000000000', reason: ERejectReason.RLS_DENIED } as const
    const aborted = { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'abcdef02-0000-4000-8000-000000000000', reason: ERejectReason.RLS_DENIED } as const
    const deadLettered = { type: EEngineEventType.DEAD_LETTER, mutationId: 'abcdef03-0000-4000-8000-000000000000', reason: 'transport' } as const

    expect(summarizeEngineEventShort(rejected)).toBe('abcdef01 · RLS_DENIED')
    expect(summarizeEngineEventShort(aborted)).toBe('abcdef02 · RLS_DENIED')
    expect(summarizeEngineEventShort(deadLettered)).toBe('abcdef03 · transport')
  })

  test('an rpc line reports both directions in bytes', () => {
    const log = createWireLog()

    log.record('A', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.pull, bytesOut: 96, bytesIn: 2048, durationMs: 9, ok: true } })
    const entry = log.entries()[0]!

    expect(labelEntry(entry)).toBe('kizunasync.pull')
    expect(summarizeEntry(entry)).toContain('96B out')
    expect(summarizeEntry(entry)).toContain('2.0KB in')
  })

  test('a refused verdict is flagged, an applied one is not', () => {
    const log = createWireLog()

    log.record('B', {
      kind: EWireEntryKind.verdict,
      verdict: { mutationId: 'abcdef04-0000-4000-8000-000000000000', applied: false, reason: ERejectReason.RLS_DENIED },
    })
    log.record('B', {
      kind: EWireEntryKind.verdict,
      verdict: { mutationId: 'abcdef05-0000-4000-8000-000000000000', applied: true, reason: null },
    })
    const [refused, applied] = log.entries()

    expect(isRejection(refused!)).toBe(true)
    expect(labelEntry(refused!)).toBe('REJECTED')
    expect(summarizeEntry(refused!)).toContain('RLS_DENIED')
    expect(isRejection(applied!)).toBe(false)
    expect(labelEntry(applied!)).toBe('APPLIED')
  })

  test('the engine events that carry bad news are highlighted too', () => {
    const log = createWireLog()

    log.record('A', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.LOCAL_CHANGED } })
    log.record('A', {
      kind: EWireEntryKind.engine,
      event: { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'abcdef06-0000-4000-8000-000000000000', reason: ERejectReason.RLS_DENIED },
    })
    const [ordinary, rejected] = log.entries()

    expect(isRejection(ordinary!)).toBe(false)
    expect(isRejection(rejected!)).toBe(true)
  })
})
