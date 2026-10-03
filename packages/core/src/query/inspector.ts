// MARK: - Inspector

/**
 * The local command queue, read straight from the engine. No new tables, no
 * tracking: every snapshot field comes from the engine's `inspect()`, and
 * `verdicts()` is a bounded in-memory ring fed by the engine event bus
 * (rejections, batch aborts and column overwrites are otherwise transient).
 * Gated off in production unless explicitly enabled.
 */

import { EEngineEventType, type TEngineEvent, type TOutboxEntry, type TRejectReason } from '../wire/types'

export interface IInspectorSnapshot {
  queued: TOutboxEntry[]
  depth: number
  lastMutationId: string | null
  cursor: string

  /** The identity the next pull and push register under. `reset()` mints a new one. */
  clientId: string
}

export const EInspectorVerdictKind = {
  rejected: 'rejected',
  aborted: 'aborted',
  overwritten: 'overwritten',
} as const
export type TInspectorVerdictKind = (typeof EInspectorVerdictKind)[keyof typeof EInspectorVerdictKind]

export interface IInspectorVerdict {
  mutationId: string
  kind: TInspectorVerdictKind
  reason: TRejectReason | string
  at: string
}

export interface IInspector {
  snapshot(): Promise<IInspectorSnapshot>
  verdicts(): IInspectorVerdict[]
  subscribe(onChange: () => void): () => void

  /** Drop the verdict ring (the examples' "reset local" wipes devtools state too). */
  clear(): void
}

const RING_CAP = 50

/**
 * What devtools need from an engine: the verdict feed and one coherent read of
 * the command queue. The Rust engine implements it (see select-engine.ts), so
 * the inspector needs no engine-specific code of its own.
 */
interface IInspectorSource {
  subscribe(onEvent: (event: TEngineEvent) => void): () => void
  inspect(): Promise<IInspectorSnapshot>
}

export const createInspector = (
  engine: IInspectorSource,
  now: () => string,
): IInspector => {
  const ring: IInspectorVerdict[] = []
  const listeners = new Set<() => void>()

  const record = (verdict: IInspectorVerdict): void => {
    ring.push(verdict)

    if (ring.length > RING_CAP) {
      ring.shift()
    }
  }

  engine.subscribe((event: TEngineEvent) => {
    if (event.type === EEngineEventType.MUTATION_REJECTED) {
      record({
        mutationId: event.mutationId,
        kind: EInspectorVerdictKind.rejected,
        reason: event.reason,
        at: now(),
      })
    } else if (event.type === EEngineEventType.BATCH_ABORTED) {
      record({
        mutationId: event.offenderMutationId,
        kind: EInspectorVerdictKind.aborted,
        reason: event.reason,
        at: now(),
      })
    } else if (event.type === EEngineEventType.COLUMN_OVERWRITTEN) {
      // The write survived, one of its columns did not, so the id in the ring is the WINNER's: this device has no mutation left to point at, and the winner is what a reader has to look up to see what replaced it. The ring names the column and stops there; the row and the value it lost are read through `overwrites()`, which is durable.
      record({
        mutationId: event.winnerMutationId,
        kind: EInspectorVerdictKind.overwritten,
        reason: `${event.table}.${event.column}`,
        at: now(),
      })
    }
    for (const listener of listeners) {
      listener()
    }
  })

  return {
    snapshot: () => engine.inspect(),
    verdicts: () => ring.slice(),
    clear: () => {
      ring.length = 0

      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (onChange) => {
      listeners.add(onChange)

      return () => {
        listeners.delete(onChange)
      }
    },
  }
}
