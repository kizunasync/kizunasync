/**
 * Every engine event, every kizunasync.pull/push round trip, and every server
 * verdict from both panes, in one time-ordered ring tagged with the pane that
 * produced it. A per-pane log would hide the ordering that decides who wins a
 * contested column.
 *
 * UI ring, not diagnostics: wire-viewer.tsx renders the entries; nothing is
 * written to the console. In memory only. A reload starts empty.
 */

import { EEngineEventType, EWireEntryKind, type TEngineEvent, type TRpcKind, type TWireEntryKind } from 'kizunasync'
import { summarizeEngineEvent } from '@kizunasync/utilities'
import type { TPaneId } from '@/runtime/demo-config'

// MARK: - The wire log

export const WIRE_RING_CAP = 100

/**
 * An RPC round trip observed at the fetch layer. `bytesOut`/`bytesIn` are the
 * serialized request and response body lengths. `ok` is false for a
 * transport-level or PostgREST-level failure; a rejected MUTATION inside a
 * 200 response is a verdict, not a failed call.
 */
export type TRpcCall = {
  rpc: TRpcKind
  bytesOut: number
  bytesIn: number
  durationMs: number
  ok: boolean
}

/**
 * A per-mutation server verdict lifted out of a push response. `applied` false
 * means the server refused the write: the reason is the protocol's closed
 * reason union (RLS_DENIED, PRECONDITION, CONSTRAINT, DELETE_WINS, SUPERSEDED,
 * COLUMN_DENIED), never free text.
 */
export type TWireVerdict = {
  mutationId: string
  applied: boolean
  reason: string | null
}

/** The pane-agnostic half of an entry: what happened, without who or when. */
export type TWireDetail =
  | { kind: typeof EWireEntryKind.engine; event: TEngineEvent }
  | { kind: typeof EWireEntryKind.rpc; call: TRpcCall }
  | { kind: typeof EWireEntryKind.verdict; verdict: TWireVerdict }
  | { kind: typeof EWireEntryKind.note; text: string }

export type TWireEntry = TWireDetail & {
  id: number
  pane: TPaneId
  at: number
}

export type { TWireEntryKind }

// MARK: - Public API

export interface IWireLog {
  entries(): readonly TWireEntry[]
  subscribe(listener: () => void): () => void
  record(pane: TPaneId, detail: TWireDetail): void
  clear(): void
}

export const createWireLog = (): IWireLog => {
  let entries: readonly TWireEntry[] = []
  let nextId = 0
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    entries: () => entries,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    record: (pane, detail) => {
      nextId += 1
      entries = [...entries, { id: nextId, pane, at: Date.now(), ...detail }].slice(-WIRE_RING_CAP)
      notify()
    },
    clear: () => {
      entries = []
      notify()
    },
  }
}

// MARK: - Entry summaries

/**
 * `@kizunasync/utilities`'s `summarizeEngineEvent`, with the mutation ids it
 * carries shortened to match every other id the ring renders (one line per
 * entry). MUTATION_REJECTED, BATCH_ABORTED, and DEAD_LETTER are re-rendered
 * here only to shorten their id; every other variant is the utilities
 * summary unchanged.
 */
export function summarizeEngineEventShort(event: TEngineEvent): string {
  switch (event.type) {
    case EEngineEventType.MUTATION_REJECTED:
      return `${shortId(event.mutationId)} · ${event.reason}`
    case EEngineEventType.BATCH_ABORTED:
      return `${shortId(event.offenderMutationId)} · ${event.reason}`
    case EEngineEventType.DEAD_LETTER:
      return `${shortId(event.mutationId)} · ${event.reason}`
    default:
      return summarizeEngineEvent(event)
  }
}

export function summarizeEntry(entry: TWireEntry): string {
  switch (entry.kind) {
    case EWireEntryKind.engine:
      return summarizeEngineEventShort(entry.event)
    case EWireEntryKind.rpc:
      return `${formatBytes(entry.call.bytesOut)} out · ${formatBytes(entry.call.bytesIn)} in · ${String(Math.round(entry.call.durationMs))}ms${entry.call.ok ? '' : ' · failed'}`
    case EWireEntryKind.verdict:
      return `${shortId(entry.verdict.mutationId)} · ${entry.verdict.reason ?? 'applied'}`
    case EWireEntryKind.note:
      return entry.text
    default:
      return assertNeverEntry(entry)
  }
}

function assertNeverEntry(value: never): never {
  throw new Error(`summarizeEntry: unhandled wire entry ${JSON.stringify(value)}`)
}

/** Kind label on the wire-viewer chip. */
export function labelEntry(entry: TWireEntry): string {
  switch (entry.kind) {
    case EWireEntryKind.engine:
      return entry.event.type
    case EWireEntryKind.rpc:
      return `kizunasync.${entry.call.rpc}`
    case EWireEntryKind.verdict:
      return entry.verdict.applied ? 'APPLIED' : 'REJECTED'
    case EWireEntryKind.note:
      return 'DEMO'
    default:
      return assertNeverEntry(entry)
  }
}

/**
 * True for the entries the viewer highlights: a write the server refused, and
 * the engine events that carry the same news.
 */
export function isRejection(entry: TWireEntry): boolean {
  if (entry.kind === EWireEntryKind.verdict) {
    return !entry.verdict.applied
  }
  if (entry.kind === EWireEntryKind.engine) {
    return (
      entry.event.type === EEngineEventType.MUTATION_REJECTED ||
      entry.event.type === EEngineEventType.BATCH_ABORTED ||
      entry.event.type === EEngineEventType.DEAD_LETTER
    )
  }
  return false
}

// MARK: - Formatting helpers

/**
 * UUIDs are 36 characters and the ring is one line per entry; the first segment
 * is enough to correlate a verdict with the mutation that earned it.
 */
function shortId(id: string): string {
  return id.slice(0, 8)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)}B`
  }
  return `${(bytes / 1024).toFixed(1)}KB`
}
