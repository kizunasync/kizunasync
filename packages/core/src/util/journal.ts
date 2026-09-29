/**
 * The durable-journal observation protocol, owned once here so the React hooks
 * and the Vue composables are adapters over it. Both journals (rejections and
 * column overwrites) read the same way: one read when the subscription starts,
 * another on every engine event that can add or change a row, with a monotonic
 * sequence token discarding a stale resolution. `dismiss` acknowledges one
 * entry and only then re-reads, so the promise settles once the list reflects
 * the acknowledgement.
 *
 * The two predicates below are the single owner of which events matter.
 */
// MARK: - Journal session

import { EEngineEventType, type TEngineEvent } from '../wire/types'
import type { IKizunaSync } from '../query/kizunasync'

/**
 * The events that can add or change a rejection-journal row. A SUPERSEDED-kind
 * entry still rides MUTATION_REJECTED, per the engine's push loop.
 */
export function isRejectionEvent(event: TEngineEvent): boolean {
  return (
    event.type === EEngineEventType.MUTATION_REJECTED ||
    event.type === EEngineEventType.BATCH_ABORTED ||
    event.type === EEngineEventType.DEAD_LETTER
  )
}

/** The only event that can add an overwrite-journal row. */
export function isOverwriteEvent(event: TEngineEvent): boolean {
  return event.type === EEngineEventType.COLUMN_OVERWRITTEN
}

export interface IJournalSessionOptions<TRow> {
  client: Pick<IKizunaSync, 'on'>
  read: () => Promise<readonly TRow[]>
  isRelevant: (event: TEngineEvent) => boolean
  onRows: (rows: readonly TRow[]) => void

  /**
   * A failed read is a reported state, never a silent empty list: this journal
   * is the surface that explains lost writes, so a reader that cannot load it
   * must be able to say so instead of rendering "no problems".
   */
  onError: (error: Error) => void
}

export interface IJournalSession {
  /** Re-read the journal. Never rejects: a failure lands in `onError`. */
  refresh(): Promise<void>

  /**
   * Acknowledge one entry, then re-read. A failed acknowledgement REJECTS; a
   * failed refresh still resolves, with the failure in `onError`.
   */
  dismiss(run: () => Promise<void>): Promise<void>

  /** Unsubscribe and invalidate any in-flight read. */
  dispose(): void
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export const createJournalSession = <TRow>(options: IJournalSessionOptions<TRow>): IJournalSession => {
  const { client, read, isRelevant, onRows, onError } = options

  let seq = 0

  const refresh = (): Promise<void> => {
    const token = (seq += 1)

    return read()
      .then((rows) => {
        if (token !== seq) {
          return
        }
        onRows(rows)
      })
      .catch((cause: unknown) => {
        if (token !== seq) {
          return
        }
        onError(toError(cause))
      })
  }

  void refresh()
  const unsubscribe = client.on((event) => {
    if (isRelevant(event)) {
      void refresh()
    }
  })

  const dismiss = async (run: () => Promise<void>): Promise<void> => {
    await run()
    await refresh()
  }

  const dispose = (): void => {
    unsubscribe()
    seq += 1
  }

  return { refresh, dismiss, dispose }
}
