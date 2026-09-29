/**
 * Query log (examples devtools): a small ring buffer of the reads and writes an
 * example issues explicitly, the read buttons plus add/toggle/edit/delete, shown
 * on the Cache tab. The kernel owns the store on every platform, so the SQL it
 * runs never crosses the page and the log holds app-level entries alone.
 */

export type TQueryOp = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'PRAGMA' | 'TX' | 'OTHER'

export interface IQueryLogEntry {
  readonly seq: number
  readonly op: TQueryOp
  readonly label: string
  readonly rows: number | null
  readonly ms: number
}

export interface IQueryLog {
  entries(): readonly IQueryLogEntry[]

  /** Record an operation. Examples call this at their read and write sites. */
  record(entry: { op: TQueryOp; label: string; rows?: number | null; ms?: number }): void

  subscribe(listener: () => void): () => void
  clear(): void
}

const DEFAULT_CAPACITY = 300

export function createQueryLog(capacity: number = DEFAULT_CAPACITY): IQueryLog {
  let buffer: IQueryLogEntry[] = []
  let seq = 0
  const listeners = new Set<() => void>()

  return {
    entries: () => buffer,
    record({ op, label, rows = null, ms = 0 }) {
      seq += 1
      buffer = [...buffer.slice(-(capacity - 1)), { seq, op, label, rows, ms }]

      for (const listener of listeners) {
        listener()
      }
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    clear() {
      buffer = []

      for (const listener of listeners) {
        listener()
      }
    },
  }
}
