/**
 * `useOverwrites` and `useRejections` are the same hook over `createJournalSession`
 * with a different reader, relevance predicate, and acknowledgement call; this
 * internal hook carries that shared state, effect, and dismiss logic once. Not
 * exported from the package index: `useOverwrites`/`useRejections` are the public
 * surface, this is their shared implementation.
 */
// MARK: - useJournal

import { useCallback, useEffect, useRef, useState } from 'react'
import { createJournalSession, type IJournalSession, type IKizunaSync, type TEngineEvent } from '@kizunasync/core'

export interface IUseJournalOptions<TRow, TKey> {
  client: IKizunaSync
  read: () => Promise<readonly TRow[]>
  isRelevant: (event: TEngineEvent) => boolean
  acknowledge: (key: TKey) => Promise<void>

  /** Passed straight through to the session-creating effect. */
  deps: readonly unknown[]
}

export interface IUseJournalResult<TRow, TKey> {
  rows: TRow[]
  error: Error | null
  isLoading: boolean
  dismiss: (key: TKey) => Promise<void>
}

export const useJournal = <TRow, TKey>(opts: IUseJournalOptions<TRow, TKey>): IUseJournalResult<TRow, TKey> => {
  const { client, read, isRelevant, acknowledge, deps } = opts

  const [rows, setRows] = useState<TRow[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const sessionRef = useRef<IJournalSession | null>(null)

  useEffect(() => {
    const session = createJournalSession<TRow>({
      client,
      read,
      isRelevant,
      onRows: (nextRows) => {
        setRows([...nextRows])
        setError(null)
        setIsLoading(false)
      },
      onError: (cause) => {
        setError(cause)
        setIsLoading(false)
      },
    })

    sessionRef.current = session

    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, deps)

  const dismiss = useCallback(
    (key: TKey): Promise<void> => {
      const run = (): Promise<void> => acknowledge(key)

      // Before the subscription mounts there is no list to re-read, only the write.
      return sessionRef.current?.dismiss(run) ?? run()
    },
    [client],
  )

  return { rows, error, isLoading, dismiss }
}
