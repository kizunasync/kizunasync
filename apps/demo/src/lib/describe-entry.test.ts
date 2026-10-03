/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { EConflictMode, EEngineEventType, ERejectReason, ERpcKind, EWireEntryKind } from 'kizunasync'
import { describeEntry } from './describe-entry'
import type { TWireDetail, TWireEntry } from '@/runtime/wire-log'

/**
 * The explanation column is the wire table's only prose cell, so every entry
 * kind and every TEngineEvent variant is pinned here: each renders a non-empty
 * sentence, and the ones with a fixed register (the demo's own worked examples)
 * are pinned to their exact text so a future edit cannot silently drift the
 * meaning while still returning "a string".
 */
// MARK: - Helpers

let nextId = 0

function entryOf(pane: TWireEntry['pane'], detail: TWireDetail): TWireEntry {
  nextId += 1

  return { id: nextId, pane, at: Date.now(), ...detail }
}

// MARK: - rpc

describe('describeEntry: rpc', () => {
  test('a successful pull reports the bytes it got back', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.pull, bytesOut: 96, bytesIn: 501, durationMs: 8, ok: true } })

    expect(describeEntry(entry)).toBe("Pane A asked the server for changes and got 501B back.")
  })

  test('a successful push reports the bytes it sent', () => {
    const entry = entryOf('B', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.push, bytesOut: 210, bytesIn: 64, durationMs: 12, ok: true } })

    expect(describeEntry(entry)).toBe('Pane B pushed 210B of queued writes to the server.')
  })

  test('a failed push says the write stays queued', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.push, bytesOut: 128, bytesIn: 0, durationMs: 3, ok: false } })

    expect(describeEntry(entry)).toBe("Pane A's push failed in transit; the write stays queued.")
  })

  test('a failed pull is reported without inventing an outbox claim', () => {
    const entry = entryOf('B', { kind: EWireEntryKind.rpc, call: { rpc: ERpcKind.pull, bytesOut: 96, bytesIn: 0, durationMs: 3, ok: false } })

    expect(describeEntry(entry)).toBe("Pane B's pull failed in transit.")
  })
})

// MARK: - verdict

describe('describeEntry: verdict', () => {
  test('an applied verdict', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.verdict, verdict: { mutationId: 'm-1', applied: true, reason: null } })

    expect(describeEntry(entry)).toBe("The server applied pane A's write.")
  })

  test('a DELETE_WINS rejection names the row as hard-deleted first', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.verdict, verdict: { mutationId: 'm-2', applied: false, reason: ERejectReason.DELETE_WINS } })

    expect(describeEntry(entry)).toBe("The server refused pane A's write: the row was hard-deleted first.")
  })

  test('a COLUMN_DENIED rejection names the role as unable to write the column', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.verdict, verdict: { mutationId: 'm-5', applied: false, reason: ERejectReason.COLUMN_DENIED } })

    expect(describeEntry(entry)).toBe("The server refused pane A's write: a column is not writable by this role.")
  })

  test('every closed reject reason gets an English phrase', () => {
    const reasons = Object.values(ERejectReason)

    for (const reason of reasons) {
      const entry = entryOf('B', { kind: EWireEntryKind.verdict, verdict: { mutationId: 'm-3', applied: false, reason } })
      const text = describeEntry(entry)

      expect(text.startsWith("The server refused pane B's write:")).toBe(true)
      expect(text).not.toContain(reason) // the raw code is not what ships in the sentence
    }
  })

  test('an unrecognized reason degrades to the raw string rather than throwing', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.verdict, verdict: { mutationId: 'm-4', applied: false, reason: 'SOMETHING_NEW' } })

    expect(describeEntry(entry)).toBe("The server refused pane A's write: SOMETHING_NEW.")
  })

  test('a null reason on a rejection still renders', () => {
    const entry = entryOf('B', { kind: EWireEntryKind.verdict, verdict: { mutationId: 'm-5', applied: false, reason: null } })

    expect(describeEntry(entry)).toBe("The server refused pane B's write.")
  })
})

// MARK: - note

describe('describeEntry: note', () => {
  test('a note is passed through as-is: it is already prose', () => {
    const entry = entryOf('A', { kind: EWireEntryKind.note, text: "staged mary@kizunasync.local's row" })

    expect(describeEntry(entry)).toBe("staged mary@kizunasync.local's row")
  })
})

// MARK: - engine

describe('describeEntry: engine', () => {
  test('LOCAL_CHANGED', () => {
    const entry = entryOf('B', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.LOCAL_CHANGED } })

    expect(describeEntry(entry)).toBe("Pane B's local database changed; the UI re-reads.")
  })

  test('MUTATION_REJECTED reverts and journals, naming the reason', () => {
    const entry = entryOf('A', {
      kind: EWireEntryKind.engine,
      event: { type: EEngineEventType.MUTATION_REJECTED, mutationId: 'abcdef01-0000-4000-8000-000000000000', reason: ERejectReason.RLS_DENIED },
    })

    expect(describeEntry(entry)).toBe(
      "Pane A reverted the refused write (its policies do not allow it) and journaled it.",
    )
  })

  test('BATCH_ABORTED reverts every member of the batch', () => {
    const entry = entryOf('A', {
      kind: EWireEntryKind.engine,
      event: { type: EEngineEventType.BATCH_ABORTED, offenderMutationId: 'abcdef02-0000-4000-8000-000000000000', reason: ERejectReason.CONSTRAINT },
    })

    expect(describeEntry(entry)).toBe(
      "Pane A's atomic batch aborted (it violated a database constraint); every write in it reverted too.",
    )
  })

  test('CHECKPOINT_EXPIRED', () => {
    const entry = entryOf('B', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.CHECKPOINT_EXPIRED } })

    expect(describeEntry(entry).length).toBeGreaterThan(0)
  })

  test('RESET_REQUIRED', () => {
    const entry = entryOf('B', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.RESET_REQUIRED } })

    expect(describeEntry(entry).length).toBeGreaterThan(0)
  })

  test('DEAD_LETTER names the retry-budget exhaustion and the reason', () => {
    const entry = entryOf('A', {
      kind: EWireEntryKind.engine,
      event: { type: EEngineEventType.DEAD_LETTER, mutationId: 'abcdef03-0000-4000-8000-000000000000', reason: 'transport' },
    })

    expect(describeEntry(entry)).toBe(
      "Pane A's write exhausted its retry budget (transport) and moved to the dead letter.",
    )
  })

  test('QUEUE_DEPTH pluralizes correctly', () => {
    const one = entryOf('A', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.QUEUE_DEPTH, depth: 1 } })
    const many = entryOf('A', { kind: EWireEntryKind.engine, event: { type: EEngineEventType.QUEUE_DEPTH, depth: 3 } })

    expect(describeEntry(one)).toBe('Pane A has 1 write queued.')
    expect(describeEntry(many)).toBe('Pane A has 3 writes queued.')
  })

  test('COLUMN_OVERWRITTEN', () => {
    const entry = entryOf('A', {
      kind: EWireEntryKind.engine,
      event: {
        type: EEngineEventType.COLUMN_OVERWRITTEN,
        table: 'todos',
        pk: 'p1',
        column: 'title',
        loserValue: 'old',
        winnerMutationId: 'm1',
        conflictMode: EConflictMode.arrival,
      },
    })

    expect(describeEntry(entry)).toBe(
      'Pane A recorded an overwritten column todos.title (arrival).',
    )
  })
})
