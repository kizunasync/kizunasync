/**
 * `useOverwrites` and `useRejections` are the same composable over
 * `createJournalSession` with a different reader, relevance predicate, and
 * acknowledgement call; this internal composable carries that shared refs,
 * session, and dismiss logic once. Not exported from the package index:
 * `useOverwrites`/`useRejections` are the public surface, this is their shared
 * implementation.
 */
// MARK: - useJournal

import { type Ref, onScopeDispose, ref } from 'vue'
import { createJournalSession, type IKizunaSync, type TEngineEvent } from '@kizunasync/core'

export interface IUseJournalOptions<TRow, TKey> {
  client: IKizunaSync
  read: () => Promise<readonly TRow[]>
  isRelevant: (event: TEngineEvent) => boolean
  acknowledge: (key: TKey) => Promise<void>
}

export interface IUseJournalResult<TRow, TKey> {
  rows: Ref<TRow[]>
  error: Ref<Error | null>
  isLoading: Ref<boolean>
  dismiss: (key: TKey) => Promise<void>
}

export const useJournal = <TRow, TKey>(opts: IUseJournalOptions<TRow, TKey>): IUseJournalResult<TRow, TKey> => {
  const { client, read, isRelevant, acknowledge } = opts

  const rows = ref<TRow[]>([]) as Ref<TRow[]>
  const error = ref<Error | null>(null)
  const isLoading = ref(true)

  const session = createJournalSession<TRow>({
    client,
    read,
    isRelevant,
    onRows: (nextRows) => {
      rows.value = [...nextRows]
      error.value = null
      isLoading.value = false
    },
    onError: (caught) => {
      error.value = caught
      isLoading.value = false
    },
  })

  onScopeDispose(() => {
    session.dispose()
  })

  const dismiss = (key: TKey): Promise<void> => session.dismiss(() => acknowledge(key))

  return { rows, error, isLoading, dismiss }
}
