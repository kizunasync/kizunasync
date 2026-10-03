/**
 * The engine-event ring the Cache tab's "Engine events" section reads and the
 * one-line summary it renders each entry with.
 *
 * The ring is a plain bounded buffer: an example's single `client.on()`
 * subscription calls `record` for every `TEngineEvent`, so it reflects the
 * full stream rather than only the toast-worthy subset. In memory only: a
 * reload starts an empty ring.
 */

import { EEngineEventType, type TEngineEvent } from 'kizunasync'

// MARK: - Engine event log

export type TEngineEventLogEntry = { event: TEngineEvent; at: number }

export interface IEngineEventLog {
  record(event: TEngineEvent): void
  entries(): readonly TEngineEventLogEntry[]
  subscribe(listener: () => void): () => void
}

const DEFAULT_CAP = 50

/** A bounded ring of every `TEngineEvent`, oldest first, capped at `cap`. */
export function createEngineEventLog(cap: number = DEFAULT_CAP): IEngineEventLog {
  let entries: readonly TEngineEventLogEntry[] = []
  const listeners = new Set<() => void>()

  return {
    record: (event) => {
      entries = [...entries, { event, at: Date.now() }].slice(-cap)

      for (const listener of listeners) {
        listener()
      }
    },
    entries: () => entries,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// MARK: - One-line summary

/**
 * Exhaustiveness guard (@../../../CONVENTIONS.md): discriminated unions stay
 * exhaustive. A new `TEngineEvent` variant fails to narrow to `never` here, so
 * the ring cannot silently render an event it does not describe.
 */
function assertNever(value: never): never {
  throw new Error(`summarizeEngineEvent: unhandled engine event ${JSON.stringify(value)}`)
}

/**
 * One-line payload summary for an "Engine events" row: the fields the
 * variant carries, joined, deliberately mechanical rather than prose. A
 * variant with no extra payload renders an empty cell, matching every other
 * no-detail row in the example apps.
 */
export function summarizeEngineEvent(event: TEngineEvent): string {
  switch (event.type) {
    case EEngineEventType.LOCAL_CHANGED:
    case EEngineEventType.CHECKPOINT_EXPIRED:
    case EEngineEventType.RESET_REQUIRED:
      return ''
    case EEngineEventType.MUTATION_REJECTED:
      return `${event.mutationId} · ${event.reason}`
    case EEngineEventType.BATCH_ABORTED:
      return `${event.offenderMutationId} · ${event.reason}`
    case EEngineEventType.DEAD_LETTER:
      return `${event.mutationId} · ${event.reason}`
    case EEngineEventType.QUEUE_DEPTH:
      return `depth ${String(event.depth)}`
    case EEngineEventType.COLUMN_OVERWRITTEN:
      return `${event.table}.${event.column} · ${event.conflictMode}`
    default:
      return assertNever(event)
  }
}
