/**
 * React adapter over `createAttachmentSession`: the per-ref watch protocol, the
 * once-per-ref auto-fetch, and the stale-continuation guards all live in
 * `@kizunasync/core`, so this file only turns the session's status callback into
 * component state and its lifetime into an effect.
 *
 * `permanent` is what separates the two readings of `state: 'failed'`: false
 * means the next sync retries it, true means the transfer budget is spent and
 * only `retry()` puts the row back in the queue.
 */
// MARK: - useAttachment

import { useEffect, useRef, useState } from 'react'
import { createAttachmentSession, toAttachmentBudgetFields, toAttachmentDisplayFields, type IAttachmentClient, type IAttachmentSession, type TAttachmentState, type TAttachmentStatus } from '@kizunasync/core'
import { useKizunaSync, type IClientOption } from './provider'

export interface IUseAttachmentResult {
  state: TAttachmentState | 'idle'
  progress: number
  localUri: string | null
  error: string | null

  /** The transfer budget is spent: nothing moves this reference until `retry`. */
  permanent: boolean

  /** Transfer attempts consumed so far, out of the configured budget. */
  attempts: number

  /** Reset the attempt count, then drive the transfer again. */
  retry: () => void

  /** Stop the transfer now. The row stays retryable. */
  cancel: () => void

  /** Forget the reference and its sandbox bytes. */
  remove: () => void

  /** Fetch a peer's bytes without touching the budget. */
  prefetch: () => void
}

export const useAttachment = (
  ref: string | null | undefined,
  opts?: IClientOption,
): IUseAttachmentResult => {
  const client = useKizunaSync(opts)
  const attachments = client.attachments
  const [status, setStatus] = useState<TAttachmentStatus | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Held in a ref, not a memo: the session owns a live subscription, so losing it between renders would strand a watch. It subscribes to nothing until the effect below hands it a reference, which keeps this creation safe to repeat in a discarded render.
  const sessionRef = useRef<{ attachments: IAttachmentClient; session: IAttachmentSession } | null>(null)

  if (sessionRef.current === null || sessionRef.current.attachments !== attachments) {
    sessionRef.current = {
      attachments,
      session: createAttachmentSession({
        attachments,
        onStatus: setStatus,
        onError: (cause: unknown) => {
          setFailure(cause instanceof Error ? cause.message : String(cause))
        },
      }),
    }
  }
  const { session } = sessionRef.current

  useEffect(() => {
    setFailure(null)
    session.setRef(ref)
  }, [session, ref])

  useEffect(() => () => session.dispose(), [session])

  const budget = toAttachmentBudgetFields(status)

  return {
    ...toAttachmentDisplayFields(status),
    error: failure ?? budget.error,
    permanent: budget.permanent,
    attempts: budget.attempts,
    retry: session.retry,
    cancel: session.cancel,
    remove: session.remove,
    prefetch: session.prefetch,
  }
}
