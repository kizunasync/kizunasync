/**
 * Server-under-test contract (content pinned).
 *
 * The corpus stays the oracle: wire types come from ../spec/wire-types.ts
 * (the schemas remain the machine artifact; this contract adds NO wire
 * fields: client identity rides `seed` exactly as transcripts carry it in
 * `context` only, D-client-identity). Control methods exist solely to reproduce the
 * oracle-side setup the transcripts pin in prose (context.notes) but cannot
 * encode in step bytes: Logical timestamp grammar logical-step timestamps (setStep), the supastash
 * late-commit race (txn/commitTxn, fencing/001), and elided pre-transcript
 * history (history/next_seq, lifecycle/001 + fencing seq gaps).
 *
 * Determinism rule: no Date.now, no Math.random, anywhere in executor/.
 */

import type { TColumnValues, TPullRequest, TPullResponse, TPushRequest, TPushResponse, TSeq, TUuid } from '../spec/wire-types'

// MARK: - Fencing mechanism

/**
 * Fencing mechanism a transcript declares. `visibility-horizon` bounds the pull
 * high-water mark with the Postgres transaction snapshot's visibility horizon
 * (D-visibility-horizon; P:keyset-pagination-and-delivery-bound; SQL:visibility-horizon).
 */
export const EFencing = {
  shared: 'shared',
  visibilityHorizon: 'visibility-horizon',
} as const
export type TFencing = (typeof EFencing)[keyof typeof EFencing]

// MARK: - Gated-decision typed error

/**
 * A reference-server gate for an open decision whose wire bytes are
 * unspecified: the corpus prescribes none, so fabricating a response would
 * resolve it (@../../../CONVENTIONS.md). No decision is gated (D-schema-version-handshake's push-side
 * stale-schema outcome is a typed RESET_REQUIRED, lifecycle/003); the
 * machinery serves any future gate.
 */
export type TGatedDecision = `OD-${number}`
export class OpenDecisionError extends Error {
  readonly decision: TGatedDecision
  constructor(decision: TGatedDecision, message: string) {
    super(message)
    this.name = 'OpenDecisionError'
    this.decision = decision
  }
}

// MARK: - Seeding

/**
 * Per-table conflict resolution mode: 'arrival' (column-LWW by server arrival,
 * conflict/002) or 'hlc' (origin-order by the mutation's HLC, conflict/003).
 * Absent selects 'arrival'.
 */
export type TServerTableConfig = {
  bucket_column: string
  conflict_mode?: 'arrival' | 'hlc'
  conflict_journal?: boolean
}
export type THistoryOp =
  | { op: 'upsert'; table: string; pk: TUuid; columns: TColumnValues }
  | { op: 'delete'; table: string; pk: TUuid }
  | { op: 'reap' }
export type TServerSeed = {
  client_id: TUuid
  user_id: TUuid
  min_schema_version: number
  tables: Record<string, TServerTableConfig>
  tombstone_ttl_days: number
  max_pull_scan?: number // candidates one pull page examines at most; absent selects the pack default (pull/005)
  fencing: TFencing
  next_seq: TSeq // first seq to stamp; '1' default, '5' for fencing/001 (Decimal seq and cursor token gaps by design)
  history: THistoryOp[] // state elided before the transcript starts, applied at seed time with arrived_step 0
}

// MARK: - Out-of-band server change

/** Another actor's committed write or delete, set up out of band. */
export type TServerRowChange = {
  actor: TUuid
  op: 'upsert' | 'delete'
  table: string
  pk: TUuid
  columns?: TColumnValues
  hlc?: string // origin HLC the oracle stamps on hlc-mode tables, setting each masked column's high-water mark (conflict/003)
  txn?: string // stamp the seq immediately and hold visibility until commitTxn (the supastash late-commit race, P:keyset-pagination-and-delivery-bound)
}

/** A `reap` server step: every tombstone recorded so far is reaped and the reap horizon rises to the highest reaped seq (lifecycle/006). It carries no table, pk, or row. */
export type TServerReap = { op: 'reap' }

export type TServerChange = TServerRowChange | TServerReap

// MARK: - The contract

export interface IProtocolServer {
  seed(seed: TServerSeed): void // full reset + seed
  setStep(n: number): void // logical clock: the step number deleted_at encodes
  applyServerChange(change: TServerChange): void
  commitTxn(txn: string): void
  pull(request: TPullRequest): TPullResponse
  push(request: TPushRequest): TPushResponse
}
