/**
 * Scenario registry (content pinned).
 *
 * Keyed by transcript `case` id. Every entry is derived verbatim from the
 * transcript's own context.notes: the corpus stays the oracle; this registry
 * only machine-encodes prose the corpus already pins, and each entry carries
 * a comment citing its source note. All other cases need no scenario
 * (defaults: next_seq '1', history [], no held txns, Decimal seq and cursor token
 * 'seqs dense from 1 per transcript'). Scenarios stay TS, not JSON, on
 * purpose: harness/load.ts scans only the corpus dirs, so this registry is
 * outside I-1 canonical-bytes and I-12 bijection.
 */

import type { TSeq } from '../spec/wire-types'
import type { THistoryOp } from './server-contract'

// MARK: - Types

export type THeldTxn = { step: number; txn: string; commit_after_step: number }

export type TScenario = {
  next_seq?: TSeq
  history?: THistoryOp[]
  held_txns?: THeldTxn[]
}

// MARK: - Registry

export const SCENARIOS: Record<string, TScenario> = {
  // fencing/001 context.notes: the cursor starts at '4' (elided history); t1 stamps seq 5 at step 1 and commits after step 5
  'fencing/001-late-commit-delivered': {
    next_seq: '5',
    held_txns: [{ step: 1, txn: 't1', commit_after_step: 5 }],
  },
  // fencing/003 context.notes: the cursor starts at '4' (elided history); t1 stamps seq 5 at step 1 and t2 seq 6 at step 2, both commit after step 6
  'fencing/003-two-holes-both-delivered': {
    next_seq: '5',
    held_txns: [
      { step: 1, txn: 't1', commit_after_step: 6 },
      { step: 2, txn: 't2', commit_after_step: 6 },
    ],
  },
  // lifecycle/001 notes: seq1 insert e1 · seq2 delete e1, tombstone reaped (SQL:tombstone-reaping) · seq3 insert e2
  'lifecycle/001-checkpoint-expired-rehydrate': {
    history: [
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000001',
        columns: {
          done: false,
          owner_id: '00000000-0000-4000-8000-a10000000001',
          title: 'pre-transcript row',
        },
      },
      { op: 'delete', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001' },
      { op: 'reap' },
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000002',
        columns: {
          done: false,
          owner_id: '00000000-0000-4000-8000-a10000000001',
          title: 'created while the client was offline',
        },
      },
    ],
  },
  // lifecycle/005 context.notes: seq 1 inserts e1 · seq 2 inserts e2 · seq 3 inserts e3 · seq 4 deletes e3, tombstone reaped (SQL:tombstone-reaping), so the reap horizon is 4
  'lifecycle/005-bootstrap-after-reap-pages-to-completion': {
    history: [
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000001',
        columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'row one' },
      },
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000002',
        columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'row two' },
      },
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000003',
        columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'row three' },
      },
      { op: 'delete', table: 'todos', pk: '00000000-0000-4000-8000-e10000000003' },
      { op: 'reap' },
    ],
  },
  // rebase/004 context.notes: lifecycle/001's elided history, plus a client-pending insert of e3
  'rebase/004-rehydration-replays': {
    history: [
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000001',
        columns: {
          done: false,
          owner_id: '00000000-0000-4000-8000-a10000000001',
          title: 'pre-transcript row',
        },
      },
      { op: 'delete', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001' },
      { op: 'reap' },
      {
        op: 'upsert',
        table: 'todos',
        pk: '00000000-0000-4000-8000-e10000000002',
        columns: {
          done: false,
          owner_id: '00000000-0000-4000-8000-a10000000001',
          title: 'created while the client was offline',
        },
      },
    ],
  },
}
