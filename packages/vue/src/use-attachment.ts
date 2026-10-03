/**
 * Vue adapter over `createAttachmentSession`: the per-ref watch protocol, the
 * once-per-ref auto-fetch, and the stale-continuation guards all live in
 * `@kizunasync/core`, so this file only spreads the session's status callback into
 * refs and binds its lifetime to the effect scope. The argument is a
 * MaybeRefOrGetter: a ref or getter that changes swaps the subscription; a
 * plain string is read once and never changes.
 *
 * `permanent` distinguishes the two readings of `state: 'failed'`: false means
 * the next sync retries it; true means the transfer budget is spent and only
 * `retry()` puts the row back in the queue.
 */
// MARK: - useAttachment

import { type MaybeRefOrGetter, type Ref, computed, onScopeDispose, ref, toValue, watch } from 'vue'
import { createAttachmentSession, toAttachmentBudgetFields, toAttachmentDisplayFields, type TAttachmentState } from '@kizunasync/core'
import { type IUseKizunaSyncOptions, useKizunaSync } from './provide'

export interface IUseAttachmentResult {
  state: Ref<TAttachmentState | 'idle'>
  progress: Ref<number>
  localUri: Ref<string | null>
  error: Ref<string | null>

  /** The transfer budget is spent: nothing moves this reference until `retry`. */
  permanent: Ref<boolean>

  /** Transfer attempts consumed so far, out of the configured budget. */
  attempts: Ref<number>

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
  attachmentRef: MaybeRefOrGetter<string | null | undefined>,
  opts?: IUseKizunaSyncOptions,
): IUseAttachmentResult => {
  const client = useKizunaSync(opts)
  const state = ref<TAttachmentState | 'idle'>('idle')
  const progress = ref(0)
  const localUri = ref<string | null>(null)
  const statusError = ref<string | null>(null)
  const failure = ref<string | null>(null)
  const permanent = ref(false)
  const attempts = ref(0)

  const session = createAttachmentSession({
    attachments: client.attachments,
    onStatus: (status) => {
      const display = toAttachmentDisplayFields(status)
      const budget = toAttachmentBudgetFields(status)

      state.value = display.state
      progress.value = display.progress
      localUri.value = display.localUri
      statusError.value = budget.error
      permanent.value = budget.permanent
      attempts.value = budget.attempts
    },
    onError: (cause: unknown) => {
      failure.value = cause instanceof Error ? cause.message : String(cause)
    },
  })

  const error = computed<string | null>(() => failure.value ?? statusError.value)

  const readRef = (): string | null => toValue(attachmentRef) ?? null

  session.setRef(readRef())
  const stopRefWatch = watch(readRef, (next) => {
    failure.value = null
    session.setRef(next)
  })

  onScopeDispose(() => {
    stopRefWatch()
    session.dispose()
  })

  return {
    state,
    progress,
    localUri,
    error,
    permanent,
    attempts,
    retry: session.retry,
    cancel: session.cancel,
    remove: session.remove,
    prefetch: session.prefetch,
  }
}
