/**
 * The caller hands a fn(kizunasync) that performs the write (insert/update/delete
 * via the local builder). We run it, track isPending, and capture any throw or
 * rejection into { error }. Reactivity for the resulting data is handled by
 * useQuery's event subscription; this hook only owns the write lifecycle.
 */
// MARK: - useMutation

import { useCallback, useState } from 'react'
import type { IKizunaSync } from '@kizunasync/core'
import { useKizunaSync, type IClientOption } from './provider'

export interface IMutationResult {
  mutate: (fn: (kizunasync: IKizunaSync) => unknown) => Promise<void>
  isPending: boolean
  error: Error | null
}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

export const useMutation = (opts?: IClientOption): IMutationResult => {
  const client = useKizunaSync(opts)
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const mutate = useCallback(
    async (fn: (kizunasync: IKizunaSync) => unknown): Promise<void> => {
      setIsPending(true)
      setError(null)

      try {
        await fn(client)
      } catch (cause) {
        setError(toError(cause))
      } finally {
        setIsPending(false)
      }
    },
    [client],
  )

  return { mutate, isPending, error }
}
