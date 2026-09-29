/**
 * React adapter over `createJournalSession` for the durable client-local
 * overwrite journal (kizunasync.overwrites()): every column a peer's write replaced
 * under column-LWW, newest first, surviving reloads until dismissed. The
 * read-on-mount, re-read-on-event, stale-discard, and dismiss-then-read
 * protocol lives in `@kizunasync/core`; which events count is `isOverwriteEvent`.
 *
 * A rejection is a write that never landed; an overwrite is a write that
 * landed and lost one of its columns, so this is a second hook, not a filter
 * on useRejections.
 *
 * A failed read lands in `error` (useQuery's contract). A failed dismiss
 * REJECTS; a dismiss whose refresh fails still resolves, with the failure in
 * `error`.
 */
// MARK: - useOverwrites

import { isOverwriteEvent, type TOverwriteRecord } from '@kizunasync/core'
import { useKizunaSync, type IClientOption } from './provider'
import { useJournal } from './use-journal'

export interface IOverwritesOption extends IClientOption {
  includeDismissed?: boolean
}

export interface IOverwritesResult {
  overwrites: TOverwriteRecord[]
  error: Error | null
  isLoading: boolean
  dismiss: (id: number) => Promise<void>
}

export const useOverwrites = (opts?: IOverwritesOption): IOverwritesResult => {
  const client = useKizunaSync(opts)
  const includeDismissed = opts?.includeDismissed

  const { rows, error, isLoading, dismiss } = useJournal<TOverwriteRecord, number>({
    client,
    read: () => client.overwrites({ includeDismissed }),
    isRelevant: isOverwriteEvent,
    acknowledge: (id) => client.dismissOverwrite(id),
    deps: [client, includeDismissed],
  })

  return { overwrites: rows, error, isLoading, dismiss }
}
