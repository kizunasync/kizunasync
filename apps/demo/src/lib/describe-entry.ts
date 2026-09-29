import { EEngineEventType, ERejectReason, ERpcKind, EWireEntryKind, type TEngineEvent, type TRejectReason } from '@kizunasync/core'
import type { TPaneId } from '@/runtime/demo-config'
/**
 * Relative, not the `@/` alias: `bun test` (unlike Vite) does not resolve that
 * alias for a real value import: only for the type-only imports the rest of
 * this file's `@/runtime/demo-config` line gets away with, since those are erased
 * before anything needs to resolve them. formatBytes is a runtime import.
 */
import { formatBytes, type TRpcCall, type TWireEntry, type TWireVerdict } from '../runtime/wire-log'

// MARK: - Wire entry → plain-English explanation

/**
 * Maps one wire entry to ONE short sentence stating what the event MEANS,
 * built only from fields the entry itself carries: nothing inferred, nothing
 * guessed. The rpc/verdict/engine columns already show the raw numbers and
 * codes; this sentence is the reading of them. Every TWireEntry kind and every
 * TEngineEvent variant is covered, so a future variant fails to narrow to
 * `never` here rather than rendering a blank cell (no silent fallback; @../../../../CONVENTIONS.md).
 */

/**
 * English for the closed reject-reason union: the same six codes a push
 * verdict and a MUTATION_REJECTED/BATCH_ABORTED event carry. Record<TRejectReason,
 * string> keeps this exhaustive: a seventh ERejectReason literal fails to compile
 * here until it gets a phrase.
 */
const REJECT_REASON_TEXT: Record<TRejectReason, string> = {
  [ERejectReason.RLS_DENIED]: 'its policies do not allow it',
  [ERejectReason.PRECONDITION]: 'the row changed on the server first',
  [ERejectReason.CONSTRAINT]: 'it violated a database constraint',
  [ERejectReason.DELETE_WINS]: 'the row was hard-deleted first',
  [ERejectReason.SUPERSEDED]: 'a later write to the same columns already won',
  [ERejectReason.COLUMN_DENIED]: 'a column is not writable by this role',
}

/**
 * DEAD_LETTER's reason and a server verdict's reason arrive as plain strings
 * (not the closed TRejectReason type), so an unrecognized one degrades to
 * itself rather than throwing: this is a display surface, the same
 * graceful-degrade rule supabase-client.ts's readVerdicts already follows.
 */
function reasonPhrase(reason: string): string {
  return REJECT_REASON_TEXT[reason as TRejectReason] ?? reason
}

export function describeEntry(entry: TWireEntry): string {
  switch (entry.kind) {
    case EWireEntryKind.engine:
      return describeEngineEvent(entry.pane, entry.event)
    case EWireEntryKind.rpc:
      return describeRpc(entry.pane, entry.call)
    case EWireEntryKind.verdict:
      return describeVerdict(entry.pane, entry.verdict)
    case EWireEntryKind.note:
      return entry.text
    default:
      return assertNeverEntry(entry)
  }
}

// MARK: - Per-kind sentences

function describeEngineEvent(pane: TPaneId, event: TEngineEvent): string {
  switch (event.type) {
    case EEngineEventType.LOCAL_CHANGED:
      return `Pane ${pane}'s local database changed; the UI re-reads.`
    case EEngineEventType.MUTATION_REJECTED:
      return `Pane ${pane} reverted the refused write (${reasonPhrase(event.reason)}) and journaled it.`
    case EEngineEventType.BATCH_ABORTED:
      return `Pane ${pane}'s atomic batch aborted (${reasonPhrase(event.reason)}); every write in it reverted too.`
    case EEngineEventType.CHECKPOINT_EXPIRED:
      return `Pane ${pane}'s cursor is older than the server's retained history; it re-hydrates via keyset pagination.`
    case EEngineEventType.RESET_REQUIRED:
      return `Pane ${pane}'s local schema is behind the server's minimum; sync is soft-blocked until it resets.`
    case EEngineEventType.DEAD_LETTER:
      return `Pane ${pane}'s write exhausted its retry budget (${reasonPhrase(event.reason)}) and moved to the dead letter.`
    case EEngineEventType.QUEUE_DEPTH:
      return `Pane ${pane} has ${String(event.depth)} write${event.depth === 1 ? '' : 's'} queued.`
    case EEngineEventType.COLUMN_OVERWRITTEN:
      return `Pane ${pane} recorded an overwritten column ${event.table}.${event.column} (${event.conflictMode}).`
    default:
      return assertNeverEngineEvent(event)
  }
}

function describeRpc(pane: TPaneId, call: TRpcCall): string {
  if (!call.ok) {
    return call.rpc === ERpcKind.push
      ? `Pane ${pane}'s push failed in transit; the write stays queued.`
      : `Pane ${pane}'s pull failed in transit.`
  }
  return call.rpc === ERpcKind.pull
    ? `Pane ${pane} asked the server for changes and got ${formatBytes(call.bytesIn)} back.`
    : `Pane ${pane} pushed ${formatBytes(call.bytesOut)} of queued writes to the server.`
}

function describeVerdict(pane: TPaneId, verdict: TWireVerdict): string {
  if (verdict.applied) {
    return `The server applied pane ${pane}'s write.`
  }
  return verdict.reason === null
    ? `The server refused pane ${pane}'s write.`
    : `The server refused pane ${pane}'s write: ${reasonPhrase(verdict.reason)}.`
}

// MARK: - Exhaustiveness guards

function assertNeverEngineEvent(value: never): never {
  throw new Error(`describeEntry: unhandled engine event ${JSON.stringify(value)}`)
}

function assertNeverEntry(value: never): never {
  throw new Error(`describeEntry: unhandled wire entry ${JSON.stringify(value)}`)
}
