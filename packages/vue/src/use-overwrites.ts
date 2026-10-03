/**
 * Vue adapter over `createJournalSession` for the durable client-local
 * overwrite journal (kizunasync.overwrites()): every column a peer's write replaced
 * under column-LWW, newest first, surviving reloads until dismissed. The
 * read-on-mount, re-read-on-event, stale-discard, and dismiss-then-read
 * protocol lives in `@kizunasync/core`; which events count is `isOverwriteEvent`.
 * onScopeDispose unsubscribes and invalidates any in-flight read.
 *
 * A rejection is a write that never landed; an overwrite is a write that
 * landed and lost one of its columns, so this is a second composable, not a
 * filter on useRejections.
 *
 * A failed read lands in `error` (useQuery's contract). A failed dismiss
 * REJECTS; a dismiss whose refresh fails still resolves, with the failure in
 * `error`.
 */
// MARK: - useOverwrites

import { type Ref } from 'vue'
import { isOverwriteEvent, type TOverwriteRecord } from '@kizunasync/core'
import { type IUseKizunaSyncOptions, useKizunaSync } from './provide'
import { useJournal } from './use-journal'

export interface IUseOverwritesOptions extends IUseKizunaSyncOptions {
  includeDismissed?: boolean
}

export interface IUseOverwritesResult {
  overwrites: Ref<TOverwriteRecord[]>
  error: Ref<Error | null>
  isLoading: Ref<boolean>
  dismiss: (id: number) => Promise<void>
}

export const useOverwrites = (opts?: IUseOverwritesOptions): IUseOverwritesResult => {
  const client = useKizunaSync(opts)
  const includeDismissed = opts?.includeDismissed

  const { rows, error, isLoading, dismiss } = useJournal<TOverwriteRecord, number>({
    client,
    read: () => client.overwrites({ includeDismissed }),
    isRelevant: isOverwriteEvent,
    acknowledge: (id) => client.dismissOverwrite(id),
  })

  return { overwrites: rows, error, isLoading, dismiss }
}
