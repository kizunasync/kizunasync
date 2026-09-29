/**
 * Merges the three error sources ConnectionBar's status line can show (the
 * query, the last mutate, and the sync engine) behind one manual message, so
 * TodoBoard's own body carries none of this branching.
 */

export interface IUseStatusNoteParams {
  message: string | null
  queryError: Error | null
  writeError: Error | null
  lastError: Error | null
}

export function useStatusNote({ message, queryError, writeError, lastError }: IUseStatusNoteParams): string | null {
  const error = queryError ?? writeError ?? lastError

  return message ?? error?.message ?? null
}
