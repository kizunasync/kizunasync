/**
 * The caller hands a fn(kizunasync) that performs the write (insert/update/delete
 * via the local builder). We run it, track isPending, and capture any throw or
 * rejection into { error }. Reactivity for the resulting data is handled by
 * useQuery's event subscription; this composable only owns the write lifecycle.
 */
// MARK: - useMutation

import { type Ref, ref } from 'vue'
import type { IKizunaSync } from '@kizunasync/core'
import { type IUseKizunaSyncOptions, useKizunaSync } from './provide'

export interface IUseMutationResult {
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  isPending: Ref<boolean>
  error: Ref<Error | null>
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

export const useMutation = (opts?: IUseKizunaSyncOptions): IUseMutationResult => {
  const client = useKizunaSync(opts)
  const isPending = ref(false)
  const error = ref<Error | null>(null)

  const mutate = async (fn: (kizunasync: IKizunaSync) => unknown): Promise<void> => {
    isPending.value = true
    error.value = null

    try {
      await fn(client)
    } catch (cause) {
      error.value = toError(cause)
    } finally {
      isPending.value = false
    }
  }

  return { mutate, isPending, error }
}
