/**
 * React adapter over `createJournalSession` for the durable client-local
 * rejection journal (kizunasync.rejections()): every rejected, superseded,
 * batch-aborted, and dead-lettered write, surviving reloads until dismissed.
 * The read-on-mount, re-read-on-event, stale-discard, and dismiss-then-read
 * protocol lives in `@kizunasync/core`; which events count is `isRejectionEvent`.
 *
 * A failed read lands in `error` (useQuery's contract): this journal is the
 * surface that explains lost writes, so a UI that cannot read it must be able
 * to say so instead of rendering "no problems". A failed dismiss REJECTS; a
 * dismiss whose refresh fails still resolves, with the failure in `error`.
 */
// MARK: - useRejections

import { isRejectionEvent, type TRejectionRecord, type TUuid } from '@kizunasync/core'
import { useKizunaSync, type IClientOption } from './provider'
import { useJournal } from './use-journal'

export interface IRejectionsOption extends IClientOption {
  includeDismissed?: boolean
}

export interface IRejectionsResult {
  rejections: TRejectionRecord[]
  error: Error | null
  isLoading: boolean
  dismiss: (mutationId: TUuid) => Promise<void>
}

export const useRejections = (opts?: IRejectionsOption): IRejectionsResult => {
  const client = useKizunaSync(opts)
  const includeDismissed = opts?.includeDismissed

  const { rows, error, isLoading, dismiss } = useJournal<TRejectionRecord, TUuid>({
    client,
    read: () => client.rejections({ includeDismissed }),
    isRelevant: isRejectionEvent,
    acknowledge: (mutationId) => client.dismissRejection(mutationId),
    deps: [client, includeDismissed],
  })

  return { rejections: rows, error, isLoading, dismiss }
}
