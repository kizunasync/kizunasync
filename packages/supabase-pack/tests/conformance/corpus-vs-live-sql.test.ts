/**
 * Conformance harness: the golden corpus replayed against the live SQL RPCs.
 *
 * It byte-replays each transcript through `PgReferenceServer`, a second
 * `IProtocolServer` that calls the real `kizunasync.pull` / `kizunasync.push` on
 * Postgres under a fresh isolated owner, so the corpus measures the SQL as well
 * as the in-memory TS oracle (`executor/reference.ts`).
 *
 * It does not edit the corpus or the SQL to force a pass. The value is surfacing
 * real SQL-vs-oracle gaps. Comparison runs after a declared translation/rebasing
 * normalization (see `pg-reference-server.ts`): every normalization axis is named
 * in the taxonomy below; a transcript that still diverges is reported as a real
 * divergence, and a transcript the live SQL cannot mechanically run (the held-txn
 * race) is reported as unsupported, never as a pass.
 *
 * Each transcript seeds under throwaway owners and cleans up its own rows; the DB
 * is left as found. Never resets / drops / truncates. Skips loudly with no DB.
 *
 * Run:  `bun test packages/supabase-pack/tests/conformance`
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from '../../../protocol/harness/canonical'
import type { TServerChange, TServerSeed } from '../../../protocol/executor/server-contract'
import type { TColumnValues } from '../../../protocol/spec/wire-types'
import { DB_URL, PgReferenceServer, PgUnsupportedError, dropCorpusFixture, ensureCorpusFixture } from './pg-reference-server'

// MARK: - Connectivity probe

let db: SQL | null = null
let reachable = false

try {
  const probe = new SQL(DB_URL, { max: 2 })

  await probe`select 1`
  // Sanity: the live bodies must be present (0001_kizuna_init.sql applied).
  await probe`select kizunasync.pull('[]'::jsonb, '0', 1, 1)`
  /**
   * The corpus replays against a dedicated strict owner-only-RLS table (the owner-only
   * model the corpus assumes), never the demo's relaxed public.todos.
   */
  await ensureCorpusFixture(probe)
  db = probe
  reachable = true
} catch (error) {
  console.warn(
    `[corpus-vs-live-sql] SKIPPED: no usable Postgres at ${DB_URL}. Run \`bun run db:start\` ` +
      `(and apply migrations) or set SUPABASE_DB_URL. (${error instanceof Error ? error.message : String(error)})`,
  )
}

afterAll(async () => {
  if (db !== null) {
    await dropCorpusFixture(db)
    await db.end()
  }
})

// MARK: - Corpus access

const PROTOCOL_ROOT = join(import.meta.dir, '../../../protocol')
const DOCS_ROOT = join(import.meta.dir, '../../../../docs')
const readTranscript = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PROTOCOL_ROOT, rel), 'utf8')) as Record<string, unknown>

/**
 * The live-SQL integration subset is enumerated explicitly below. A separate
 * evidence lane from the full executable manifest. Completeness is gated against
 * `cases/manifest.json` as well as TRANSCRIPTS vs EXPECTED. A new corpus file
 * cannot ship unreplayed by accident. Families that stay oracle-only must be
 * named in LIVE_SQL_OMITTED.
 */
const TRANSCRIPTS: { id: string; file: string }[] = [
  { id: 'pull/001-bootstrap-empty', file: 'transcripts/pull/001-bootstrap-empty.json' },
  { id: 'pull/002-keyset-pagination', file: 'transcripts/pull/002-keyset-pagination.json' },
  { id: 'pull/003-tombstone-leads-continuation-page', file: 'transcripts/pull/003-tombstone-leads-continuation-page.json' },
  { id: 'pull/004-exact-fit-closes-checkpoint', file: 'transcripts/pull/004-exact-fit-closes-checkpoint.json' },
  { id: 'pull/005-scan-cap-continues-below-the-limit', file: 'transcripts/pull/005-scan-cap-continues-below-the-limit.json' },
  { id: 'pull/006-integer-key-pull-only', file: 'transcripts/pull/006-integer-key-pull-only.json' },
  { id: 'lifecycle/002-reset-required', file: 'transcripts/lifecycle/002-reset-required.json' },
  { id: 'lifecycle/001-checkpoint-expired-rehydrate', file: 'transcripts/lifecycle/001-checkpoint-expired-rehydrate.json' },
  { id: 'lifecycle/005-bootstrap-after-reap-pages-to-completion', file: 'transcripts/lifecycle/005-bootstrap-after-reap-pages-to-completion.json' },
  { id: 'lifecycle/006-continuation-expires-when-its-start-is-reaped', file: 'transcripts/lifecycle/006-continuation-expires-when-its-start-is-reaped.json' },
  { id: 'conflict/001-different-columns-merge', file: 'transcripts/conflict/001-different-columns-merge.json' },
  { id: 'conflict/002-same-column-arrival-wins', file: 'transcripts/conflict/002-same-column-arrival-wins.json' },
  { id: 'conflict/003-hlc-origin-order', file: 'transcripts/conflict/003-hlc-origin-order.json' },
  { id: 'push/001-insert-applied', file: 'transcripts/push/001-insert-applied.json' },
  { id: 'push/002-rls-denied-not-a-wedge', file: 'transcripts/push/002-rls-denied-not-a-wedge.json' },
  { id: 'push/003-replay-returns-recorded-verdicts', file: 'transcripts/push/003-replay-returns-recorded-verdicts.json' },
  { id: 'push/004-precondition-rejected', file: 'transcripts/push/004-precondition-rejected.json' },
  { id: 'push/005-atomic-batch-revert', file: 'transcripts/push/005-atomic-batch-revert.json' },
  { id: 'push/006-constraint-not-a-wedge', file: 'transcripts/push/006-constraint-not-a-wedge.json' },
  { id: 'push/007-replay-renders-current-row', file: 'transcripts/push/007-replay-renders-current-row.json' },
  { id: 'push/008-composite-key-writes', file: 'transcripts/push/008-composite-key-writes.json' },
  { id: 'tombstones/001-delete-propagates', file: 'transcripts/tombstones/001-delete-propagates.json' },
  { id: 'tombstones/002-offline-edit-no-resurrection', file: 'transcripts/tombstones/002-offline-edit-no-resurrection.json' },
  { id: 'tombstones/003-bucket-scoped-delete', file: 'transcripts/tombstones/003-bucket-scoped-delete.json' },
  { id: 'tombstones/004-bucket-move-out', file: 'transcripts/tombstones/004-bucket-move-out.json' },
  { id: 'rebase/001-cursor-advances-with-outbox', file: 'transcripts/rebase/001-cursor-advances-with-outbox.json' },
  { id: 'rebase/002-different-column-visible', file: 'transcripts/rebase/002-different-column-visible.json' },
  { id: 'rebase/003-tombstone-does-not-resurrect', file: 'transcripts/rebase/003-tombstone-does-not-resurrect.json' },
  { id: 'rebase/004-rehydration-replays', file: 'transcripts/rebase/004-rehydration-replays.json' },
  { id: 'wakeup/001-missed-wakeup-poll-converges', file: 'transcripts/wakeup/001-missed-wakeup-poll-converges.json' },
  { id: 'increment/001-concurrent-increments', file: 'transcripts/increment/001-concurrent-increments.json' },
  { id: 'increment/002-increment-then-assign', file: 'transcripts/increment/002-increment-then-assign.json' },
  { id: 'increment/003-assign-then-increment', file: 'transcripts/increment/003-assign-then-increment.json' },
  { id: 'increment/004-server-row', file: 'transcripts/increment/004-server-row.json' },
  { id: 'increment/005-delete-wins', file: 'transcripts/increment/005-delete-wins.json' },
  { id: 'increment/006-non-numeric-constraint', file: 'transcripts/increment/006-non-numeric-constraint.json' },
  { id: 'increment/007-atomic-batch', file: 'transcripts/increment/007-atomic-batch.json' },
  { id: 'increment/008-precondition-mix', file: 'transcripts/increment/008-precondition-mix.json' },
  { id: 'increment/009-rejected-transform-applies-no-column', file: 'transcripts/increment/009-rejected-transform-applies-no-column.json' },
  { id: 'increment/010-hlc-rejected-transform-applies-no-column', file: 'transcripts/increment/010-hlc-rejected-transform-applies-no-column.json' },
  { id: 'array/001-concurrent-union', file: 'transcripts/array/001-concurrent-union.json' },
  { id: 'array/002-union-then-remove', file: 'transcripts/array/002-union-then-remove.json' },
  { id: 'array/003-union-then-assign-lww', file: 'transcripts/array/003-union-then-assign-lww.json' },
  { id: 'conflict/004-journal-on-winning-pull', file: 'transcripts/conflict/004-journal-on-winning-pull.json' },
  { id: 'fencing/001-late-commit-delivered', file: 'transcripts/fencing/001-late-commit-delivered.json' },
  { id: 'fencing/002-overlap-redelivery-idempotent', file: 'transcripts/fencing/002-overlap-redelivery-idempotent.json' },
]

// MARK: - Scenario extras

type THistoryOp =
  | { op: 'upsert'; table: string; pk: string; columns: TColumnValues }
  | { op: 'delete'; table: string; pk: string }
  | { op: 'reap' }
/**
 * `literal_bootstrap` sends every golden bootstrap "0" as the real "0" instead of the seed-time base: a transcript
 * that bootstraps or rehydrates after a reap needs the one token the reap gate exempts, and the bucketed replay
 * fixture still keeps that pull to this transcript's owner. A reap step in the middle of a transcript raises the
 * horizon above the base captured at seed time, so a rehydration from that base would answer CHECKPOINT_EXPIRED.
 */
type TScenario = {
  next_seq?: string
  history?: THistoryOp[]
  held_txns?: { step: number; txn: string; commit_after_step: number }[]
  literal_bootstrap?: boolean
}

const SCENARIOS: Record<string, TScenario> = {
  'fencing/001-late-commit-delivered': {
    next_seq: '5',
    held_txns: [{ step: 1, txn: 't1', commit_after_step: 5 }],
  },
  'lifecycle/001-checkpoint-expired-rehydrate': {
    history: [
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'pre-transcript row' } },
      { op: 'delete', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001' },
      { op: 'reap' },
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000002', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'created while the client was offline' } },
    ],
  },
  'lifecycle/005-bootstrap-after-reap-pages-to-completion': {
    literal_bootstrap: true,
    history: [
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'row one' } },
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000002', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'row two' } },
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000003', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'row three' } },
      { op: 'delete', table: 'todos', pk: '00000000-0000-4000-8000-e10000000003' },
      { op: 'reap' },
    ],
  },
  'lifecycle/006-continuation-expires-when-its-start-is-reaped': {
    literal_bootstrap: true,
  },
  'rebase/004-rehydration-replays': {
    history: [
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'pre-transcript row' } },
      { op: 'delete', table: 'todos', pk: '00000000-0000-4000-8000-e10000000001' },
      { op: 'reap' },
      { op: 'upsert', table: 'todos', pk: '00000000-0000-4000-8000-e10000000002', columns: { done: false, owner_id: '00000000-0000-4000-8000-a10000000001', title: 'created while the client was offline' } },
    ],
  },
}

// MARK: - Build the TServerSeed the contract expects from a transcript context

const seedFromTranscript = (t: Record<string, unknown>, scenario: TScenario): TServerSeed => {
  const ctx = (t.context ?? {}) as Record<string, unknown>
  const server = (ctx.server ?? {}) as Record<string, unknown>
  const rawTables = (server.tables ?? {}) as Record<string, Record<string, unknown>>
  const tables: TServerSeed['tables'] = {}

  for (const [name, raw] of Object.entries(rawTables)) {
    const cfg: TServerSeed['tables'][string] = {
      bucket_column: String(raw.bucket_column ?? ''),
    }

    if (raw.conflict_mode === 'hlc') {
      cfg.conflict_mode = 'hlc'
    }
    if (raw.conflict_journal === true) {
      cfg.conflict_journal = true
    }
    if (Array.isArray(raw.key_columns)) {
      cfg.key_columns = raw.key_columns.map(String)
    }
    tables[name] = cfg
  }
  return {
    client_id: String(ctx.client_id ?? ''),
    user_id: String(ctx.user_id ?? ''),
    min_schema_version: typeof server.min_schema_version === 'number' ? server.min_schema_version : 0,
    tables,
    tombstone_ttl_days: typeof server.tombstone_ttl_days === 'number' ? server.tombstone_ttl_days : 0,
    ...(typeof server.max_pull_scan === 'number' ? { max_pull_scan: server.max_pull_scan } : {}),
    fencing: 'visibility-horizon' as const,
    next_seq: scenario.next_seq ?? '1',
    history: scenario.history ?? [],
  }
}

// MARK: - Collect the declared abstract column keys of the transcript's tables

const collectDeclaredColumns = (t: Record<string, unknown>): Set<string> => {
  const keys = new Set<string>(['owner_id'])
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item)
      }
      return
    }
    if (node !== null && typeof node === 'object') {
      const o = node as Record<string, unknown>

      if (typeof o.table === 'string' && o.columns !== null && typeof o.columns === 'object') {
        for (const k of Object.keys(o.columns as object)) {
          keys.add(k)
        }
      }
      if (o.row !== null && typeof o.row === 'object' && !Array.isArray(o.row)) {
        for (const k of Object.keys(o.row as object)) {
          keys.add(k)
        }
      }
      for (const v of Object.values(o)) {
        walk(v)
      }
    }
  }
  walk(t.steps)
  walk(t.postconditions)

  return keys
}

/**
 * Every (table, pk) the transcript references (for defensive pre-clear of stale
 * rows a crashed prior run may have left under these fixed abstract keys).
 */
const collectPks = (t: Record<string, unknown>): { table: string; pk: string }[] => {
  const pks: { table: string; pk: string }[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item)
      }
      return
    }
    if (node !== null && typeof node === 'object') {
      const o = node as Record<string, unknown>

      if (typeof o.pk === 'string' && typeof o.table === 'string') {
        pks.push({ table: o.table, pk: o.pk })
      }
      for (const v of Object.values(o)) {
        walk(v)
      }
    }
  }
  walk(t.steps)
  walk(t.postconditions)

  return pks
}

// MARK: - Replay one transcript through the live SQL, classified honestly

type TReplay =
  | { status: 'pass' } // byte-equal after translation (seq/cursor lined up too)
  | { status: 'semantic'; step: number; rpc: string } // equal except seq/cursor/deleted_at
  | { status: 'diverged'; step: number; rpc: string; expected: string; actual: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'errored'; detail: string }

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/**
 * TIER 1 (byte): raw canonical equality, the strongest claim.
 * TIER 2 (semantic): equality after masking the three UNREPRODUCIBLE axes:
 *   * seq / cursor / winner_seq: the live tokens track the GLOBAL kizunasync._change_seq,
 *     which carries rollback gaps (the rpc-verdict tests begin/rollback) and
 *     other tenants' allocations, so absolute decimals are unreproducible; the
 *     golden expects a per-stream dense 1,2,3. Presence, count, array order
 *     and has_more stay; only the decimal VALUE is masked. A continuation
 *     cursor keeps its `<start>:` shape, so a page that should close the
 *     checkpoint cannot pass as one that continues, or the reverse.
 *   * tombstone deleted_at: the live track_delete stamps wall-clock now(); the
 *     oracle stamps the Logical timestamp grammar logical-step grammar (2026-01-01T00:00:0N). Masked.
 * A `semantic` pass means: the SQL agrees with the oracle on EVERY rendered row,
 * owner, column, verdict, reason, server_row, signal and has_more: diverging
 * ONLY on the global-sequence cursor bytes and the wall-clock tombstone stamp.
 */
// MARK: - Two-tier comparison

const SEQ_RE = /^(\d+:)?\d+(~\d+(\.\d+)*)?$/
const maskUnreproducible = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(maskUnreproducible)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === 'seq' || k === 'cursor' || k === 'winner_seq') && typeof v === 'string' && SEQ_RE.test(v)) {
        out[k] = v.includes(':') ? '<start>:<seq>' : '<seq>'
      } else if (k === 'deleted_at') {
        out[k] = '<deleted_at>'
      } else {
        out[k] = maskUnreproducible(v)
      }
    }
    return out
  }
  return value
}

async function replay(t: Record<string, unknown>, server: PgReferenceServer): Promise<TReplay> {
  const id = String(t.case ?? '')
  const scenario = SCENARIOS[id] ?? {}
  let firstSemantic: { step: number; rpc: string } | null = null

  try {
    await server.preclearPks(collectPks(t))
    await server.seedAsync(seedFromTranscript(t, scenario))
  } catch (error) {
    if (error instanceof PgUnsupportedError) {
      return { status: 'unsupported', reason: error.reason }
    }
    return { status: 'errored', detail: errText(error) }
  }

  const heldTxns = scenario.held_txns ?? []
  const steps = Array.isArray(t.steps) ? (t.steps as Record<string, unknown>[]) : []

  // Golden↔live cursor map. A real client replays the OPAQUE cursor it last persisted; the golden dense cursors are meaningless to the live DB. A pull request's golden cursor resolves to the live cursor the matching prior response carried. That mapping honors hold-back: the client re-pulls from a PRIOR cursor, not the latest. Bootstrap "0" does NOT map to live "0": the SHARED kizunasync._changelog / `_tombstones` sequences are already advanced by prior runs. A literal "0" can still sweep leftover low seqs (changelog rows, or unbucketed/`{}` tombstones). Bucketed tombstones with a stored snapshot are scoped like live rows. Rebase "0" to the seed-time _change_seq high-water so the fresh owner's pull starts ABOVE leaked seqs.
  const cursorMap = new Map<string, string>([['0', scenario.literal_bootstrap === true ? '0' : server.bootstrapBase]])

  // A transcript whose elided history is seeded (lifecycle/001, rebase/004) opens at a cursor INTO that history, which no response ever carried. The oracle numbers the history densely from 1, so golden seq n is the live token the n-th history op minted: without this the cursor falls back to "0" and the bootstrap path answers a test about the reap horizon.
  server.historyCursors.forEach((live, index) => {
    cursorMap.set(String(index + 1), live)
  })
  const resolveLive = (goldenReq: string): string => cursorMap.get(goldenReq) ?? '0'
  const recordCursor = (goldenResp: string, live: string): void => {
    if (!cursorMap.has(goldenResp)) {
      cursorMap.set(goldenResp, live)
    }
  }
  for (const step of steps) {
    const n = typeof step.n === 'number' ? step.n : 0
    const kind = String(step.kind ?? '')

    server.setStep(n)

    if (kind === 'server') {
      try {
        if (step.op === 'reap') {
          await server.reapAsync()
        } else {
          const change: TServerChange = {
            actor: String(step.actor ?? ''),
            op: step.op === 'delete' ? 'delete' : 'upsert',
            table: String(step.table ?? ''),
            pk: String(step.pk ?? ''),
            columns: (step.columns ?? undefined) as TColumnValues | undefined,
            hlc: typeof step.hlc === 'string' ? step.hlc : undefined,
            txn: heldTxns.find((h) => h.step === n)?.txn,
          }

          await server.applyServerChangeAsync(change)
        }
      } catch (error) {
        if (error instanceof PgUnsupportedError) {
          return { status: 'unsupported', reason: error.reason }
        }
        return { status: 'errored', detail: `server step ${n}: ${errText(error)}` }
      }
    } else if (kind === 'rpc') {
      const rpc = step.rpc === 'push' ? 'push' : 'pull'
      const expected = canonicalize(step.response)

      try {
        let actualValue: unknown

        if (rpc === 'pull') {
          const req = step.request as { cursor: string }
          const out = await server.pullAsync(step.request as never, resolveLive(String(req.cursor)))

          actualValue = out.response
          const goldenResp = (step.response as { cursor?: string }).cursor

          if (typeof goldenResp === 'string') {
            recordCursor(goldenResp, out.liveCursor)
          }
        } else {
          actualValue = await server.pushAsync(step.request as never)
        }
        const actual = canonicalize(actualValue)

        if (actual === expected) {
          // byte-equal: nothing to record, keep replaying the remaining steps
        } else if (
          canonicalize(maskUnreproducible(actualValue)) === canonicalize(maskUnreproducible(step.response))
        ) {
          // Equal after masking unreproducible axes: record first, keep replaying.
          if (firstSemantic === null) {
            firstSemantic = { step: n, rpc }
          }
        } else {
          return { status: 'diverged', step: n, rpc, expected, actual }
        }
      } catch (error) {
        if (error instanceof PgUnsupportedError) {
          return { status: 'unsupported', reason: error.reason }
        }
        // A throw at an rpc step is a real divergence (corpus pins bytes; live RAISE ≠ infra error).
        return { status: 'diverged', step: n, rpc, expected, actual: errText(error) }
      }
    } else if (kind === 'fault') {
      if (step.fault === 'drop-ack') {
        const rpc = step.target === 'push' ? 'push' : 'pull'

        try {
          if (rpc === 'pull') {
            const req = step.request as { cursor: string }

            await server.pullAsync(step.request as never, resolveLive(String(req.cursor)))
          } else {
            await server.pushAsync(step.request as never)
          }
        } catch (error) {
          if (error instanceof PgUnsupportedError) {
            return { status: 'unsupported', reason: error.reason }
          }
          return { status: 'errored', detail: `drop-ack step ${n}: ${errText(error)}` }
        }
      }
      // transport-error: request never applied, no server invocation (P:verdict-completeness-transforms-and-conflict-rejection).
    }
    // local / assert: client-state obligations, recorded, not executed.

    for (const held of heldTxns) {
      if (held.commit_after_step === n) {
        try {
          server.commitTxn(held.txn)
        } catch (error) {
          if (error instanceof PgUnsupportedError) {
            return { status: 'unsupported', reason: error.reason }
          }
          return { status: 'errored', detail: errText(error) }
        }
      }
    }
  }
  return firstSemantic === null ? { status: 'pass' } : { status: 'semantic', ...firstSemantic }
}

/**
 * Every transcript in TRANSCRIPTS has exactly ONE expected outcome pinned here.
 * The per-transcript test asserts the LIVE replay still produces that outcome and
 * FAILS BY NAME otherwise. Pinning is direction-agnostic:
 *   * a CONFORMANT family that REGRESSES (PASS-* → DIVERGED/UNSUPPORTED/ERROR)
 *     fails CI naming that exact transcript. A SQL-vs-oracle regression cannot
 *     re-open silently.
 *   * a known DIVERGED / UNSUPPORTED entry that SILENTLY CHANGES (e.g. the
 *     held-txn race becomes reproducible and fencing/001 converges) ALSO fails:
 *     the allowlist (and its reason) must be edited deliberately; taxonomy must
 *     not drift quietly.
 * A PASS-SEMANTIC pin is also satisfied by PASS-BYTE, the stronger result:
 * byte equality depends on the database's history (a global sequence that was
 * never called), not on the SQL, so a fresh database must not turn a green lock
 * red. Every other pin is exact: a PASS-BYTE pin refuses PASS-SEMANTIC, and the
 * DIVERGED, UNSUPPORTED, and ERROR outcomes match only themselves. Every
 * conformant family is pinned PASS-SEMANTIC (they diverge only on the
 * declared-unreproducible seq/cursor/deleted_at axes).
 *
 * Outcomes: 'PASS-BYTE' | 'PASS-SEMANTIC' | 'DIVERGED' | 'UNSUPPORTED'.
 * `reason` is required on the two non-conformant classes (the documented gap).
 */
// MARK: - The LOCKED conformance allowlist

type TExpected =
  | { outcome: 'PASS-BYTE' | 'PASS-SEMANTIC' }
  | { outcome: 'DIVERGED' | 'UNSUPPORTED'; reason: string }

const EXPECTED: Record<string, TExpected> = {
  /**
   * PASS-SEMANTIC is the tier that holds on every database. The four pull
   * families are byte-equal only when the global sequence has never been called,
   * which no database that has run anything can be. The tier is a property of
   * the database's history, not of the SQL, so it is not pinned here.
   */
  'pull/001-bootstrap-empty': { outcome: 'PASS-SEMANTIC' },
  'pull/002-keyset-pagination': { outcome: 'PASS-SEMANTIC' },
  'pull/003-tombstone-leads-continuation-page': { outcome: 'PASS-SEMANTIC' },
  'pull/004-exact-fit-closes-checkpoint': { outcome: 'PASS-SEMANTIC' },
  'pull/005-scan-cap-continues-below-the-limit': { outcome: 'PASS-SEMANTIC' },
  'pull/006-integer-key-pull-only': { outcome: 'PASS-SEMANTIC' },
  'lifecycle/002-reset-required': { outcome: 'PASS-SEMANTIC' },
  'lifecycle/001-checkpoint-expired-rehydrate': { outcome: 'PASS-SEMANTIC' },
  'lifecycle/005-bootstrap-after-reap-pages-to-completion': { outcome: 'PASS-SEMANTIC' },
  'lifecycle/006-continuation-expires-when-its-start-is-reaped': { outcome: 'PASS-SEMANTIC' },
  'conflict/001-different-columns-merge': { outcome: 'PASS-SEMANTIC' },
  'conflict/002-same-column-arrival-wins': { outcome: 'PASS-SEMANTIC' },
  'conflict/003-hlc-origin-order': { outcome: 'PASS-SEMANTIC' },
  'push/001-insert-applied': { outcome: 'PASS-SEMANTIC' },
  /**
   * server_row null is a genuine RLS-invisibility outcome: the replay runs against
   * a dedicated STRICT owner-only-RLS table (see pg-reference-server.ts), the owner-only
   * model the corpus assumes, so a cross-owner row is invoker-invisible on read and
   * the rejection carries null. The pack itself imposes no ownership opinion; RLS
   * alone authorizes the read.
   */
  'push/002-rls-denied-not-a-wedge': { outcome: 'PASS-SEMANTIC' },
  'push/003-replay-returns-recorded-verdicts': { outcome: 'PASS-SEMANTIC' },
  'push/004-precondition-rejected': { outcome: 'PASS-SEMANTIC' },
  'push/005-atomic-batch-revert': { outcome: 'PASS-SEMANTIC' },
  /**
   * A non-insert op against a never-inserted/never-tombstoned pk is RLS_DENIED,
   * not CONSTRAINT (D-rejection-reasons): under the strict owner-only-RLS fixture
   * the live SQL cannot distinguish "absent" from "RLS-hidden" without leaking
   * existence, so the reject carries null. This pins the live SQL and the TS
   * oracle together on RLS_DENIED (@../../../../CONVENTIONS.md).
   */
  'push/006-constraint-not-a-wedge': { outcome: 'PASS-SEMANTIC' },
  'push/007-replay-renders-current-row': { outcome: 'PASS-SEMANTIC' },
  'push/008-composite-key-writes': { outcome: 'PASS-SEMANTIC' },
  'tombstones/001-delete-propagates': { outcome: 'PASS-SEMANTIC' },
  'tombstones/002-offline-edit-no-resurrection': { outcome: 'PASS-SEMANTIC' },
  'tombstones/003-bucket-scoped-delete': { outcome: 'PASS-SEMANTIC' },
  'tombstones/004-bucket-move-out': { outcome: 'PASS-SEMANTIC' },
  'rebase/001-cursor-advances-with-outbox': { outcome: 'PASS-SEMANTIC' },
  'rebase/002-different-column-visible': { outcome: 'PASS-SEMANTIC' },
  'rebase/003-tombstone-does-not-resurrect': { outcome: 'PASS-SEMANTIC' },
  'rebase/004-rehydration-replays': { outcome: 'PASS-SEMANTIC' },
  'wakeup/001-missed-wakeup-poll-converges': { outcome: 'PASS-SEMANTIC' },
  'increment/001-concurrent-increments': { outcome: 'PASS-SEMANTIC' },
  'increment/002-increment-then-assign': { outcome: 'PASS-SEMANTIC' },
  'increment/003-assign-then-increment': { outcome: 'PASS-SEMANTIC' },
  'increment/004-server-row': { outcome: 'PASS-SEMANTIC' },
  'increment/005-delete-wins': { outcome: 'PASS-SEMANTIC' },
  'increment/006-non-numeric-constraint': { outcome: 'PASS-SEMANTIC' },
  'increment/007-atomic-batch': { outcome: 'PASS-SEMANTIC' },
  'increment/008-precondition-mix': { outcome: 'PASS-SEMANTIC' },
  'increment/009-rejected-transform-applies-no-column': { outcome: 'PASS-SEMANTIC' },
  'increment/010-hlc-rejected-transform-applies-no-column': { outcome: 'PASS-SEMANTIC' },
  'array/001-concurrent-union': { outcome: 'PASS-SEMANTIC' },
  'array/002-union-then-remove': { outcome: 'PASS-SEMANTIC' },
  'array/003-union-then-assign-lww': { outcome: 'PASS-SEMANTIC' },
  'conflict/004-journal-on-winning-pull': { outcome: 'PASS-SEMANTIC' },
  'fencing/001-late-commit-delivered': {
    outcome: 'UNSUPPORTED',
    reason:
      'held-txn race: the supastash late-commit needs a second in-flight connection orchestrated against the puller snapshot, not reproducible in synchronous single-connection replay',
  },
  'fencing/002-overlap-redelivery-idempotent': { outcome: 'PASS-SEMANTIC' },
}

/** Manifest cases that are not in TRANSCRIPTS. Keys use the same id as the manifest. */
const LIVE_SQL_OMITTED: Record<string, string> = {
  'wakeup/002-wakeup-payload': 'blocked on D-wakeup-channel; no transcript bytes',
  'lifecycle/003-push-stale-schema':
    'push schema handshake stays on the TypeScript oracle; not in this synchronous live-SQL subset',
  'fencing/003-two-holes-both-delivered':
    'multi-hole composite cursor is oracle + TLA; live SQL pins fencing/001 (unsupported held-txn) and fencing/002',
  'lifecycle/004-soft-delete-violation':
    'a client-local refusal (SOFT_DELETE_VIOLATION) with no server round trip; nothing for live SQL to replay',
}

/**
 * Exhaustiveness guard (@../../../../CONVENTIONS.md). Every `TReplay` status is
 * listed explicitly, so a future status without a matching case fails to
 * narrow to `never`: a compile error, not a silently absorbed default.
 */
const assertNever = (value: never): never => {
  throw new Error(`outcomeOf: unhandled TReplay status ${JSON.stringify(value)}`)
}

/**
 * Map a TReplay status to the allowlist's outcome vocabulary (semantic-vs-byte
 * preserved; errored has no expected slot: it always fails the lock).
 */
const outcomeOf = (r: TReplay): string => {
  switch (r.status) {
    case 'pass':
      return 'PASS-BYTE'
    case 'semantic':
      return 'PASS-SEMANTIC'
    case 'diverged':
      return 'DIVERGED'
    case 'unsupported':
      return 'UNSUPPORTED'
    case 'errored':
      return 'ERROR'
    default:
      return assertNever(r)
  }
}

/** Whether a replay outcome satisfies its pinned lock (see the EXPECTED allowlist for the rule). */
const lockHolds = (expected: TExpected | undefined, actual: string): boolean =>
  expected !== undefined && (actual === expected.outcome || (expected.outcome === 'PASS-SEMANTIC' && actual === 'PASS-BYTE'))

// MARK: - Suite

const summary: { id: string; outcome: string; note: string }[] = []

/**
 * Curated one-line characterization of each KNOWN divergence family (the
 * "expected … actual …" block is also logged for every diverged step). These are
 * REAL SQL-vs-oracle gaps surfaced by the live replay: none is force-passed.
 * Empty: push/002 stays conformant because the replay uses a strict
 * owner-only-RLS table (the corpus owner-only model), not the demo's relaxed todos.
 */
const DIVERGENCE_NOTE: Record<string, string> = {}

type TManifestFile = {
  cases: { id: string; file: string | null }[]
}

describe('live-SQL allowlist completeness (no Postgres required)', () => {
  test('TRANSCRIPTS and EXPECTED name exactly the same set', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...TRANSCRIPTS.map((x) => x.id)].sort())
  })

  test('every manifest case is either replayed or explicitly omitted', () => {
    const manifest = JSON.parse(
      readFileSync(join(PROTOCOL_ROOT, 'cases/manifest.json'), 'utf8'),
    ) as TManifestFile
    const live = TRANSCRIPTS.map((x) => x.id).sort()
    const omitted = Object.keys(LIVE_SQL_OMITTED).sort()

    expect(
      live.filter((id) => omitted.includes(id)),
      'a family cannot be both replayed and omitted',
    ).toEqual([])
    expect(live).toContain('tombstones/003-bucket-scoped-delete')
    expect([...live, ...omitted].sort()).toEqual(manifest.cases.map((c) => c.id).sort())
  })

  test('a PASS-SEMANTIC lock accepts PASS-BYTE, and every other lock is exact', () => {
    const outcomes = ['PASS-BYTE', 'PASS-SEMANTIC', 'DIVERGED', 'UNSUPPORTED', 'ERROR']
    const pins: TExpected[] = [
      { outcome: 'PASS-BYTE' },
      { outcome: 'PASS-SEMANTIC' },
      { outcome: 'DIVERGED', reason: 'unit' },
      { outcome: 'UNSUPPORTED', reason: 'unit' },
    ]
    const accepted = Object.fromEntries(pins.map((pin) => [pin.outcome, outcomes.filter((actual) => lockHolds(pin, actual))]))

    expect(accepted).toEqual({
      'PASS-BYTE': ['PASS-BYTE'],
      'PASS-SEMANTIC': ['PASS-BYTE', 'PASS-SEMANTIC'],
      DIVERGED: ['DIVERGED'],
      UNSUPPORTED: ['UNSUPPORTED'],
    })
    expect(outcomes.filter((actual) => lockHolds(undefined, actual)), 'a family with no allowlist entry never holds').toEqual([])
  })

  test('the public pages state the allowlist counts', () => {
    const outcomes = Object.values(EXPECTED).map((entry) => entry.outcome)
    const families = outcomes.length
    const semantic = outcomes.filter((outcome) => outcome === 'PASS-SEMANTIC').length
    const conformant = semantic + outcomes.filter((outcome) => outcome === 'PASS-BYTE').length
    const diverged = outcomes.filter((outcome) => outcome === 'DIVERGED').length
    const unsupported = outcomes.filter((outcome) => outcome === 'UNSUPPORTED').length
    const phrases: Record<string, string[]> = {
      'getting-started/agent-setup.md': [
        `It pins ${families} families. ${semantic} of them replay as \`PASS-SEMANTIC\`, zero diverge, and ${unsupported} is \`UNSUPPORTED\`.`,
      ],
      'getting-started/status.md': [
        `pins ${families} replayable transcript families:`,
        `- ${semantic} families replay as \`PASS-SEMANTIC\`.`,
        `- ${diverged} families replay as \`DIVERGED\`.`,
        `- ${unsupported} family is \`UNSUPPORTED\``,
        '- 0 families end in `ERROR`.',
      ],
      'operations/ci-cd.md': [
        `The current allowlist contains ${families} replay families:`,
        `- ${semantic} pinned \`PASS-SEMANTIC\`;`,
        `- ${diverged} pinned \`DIVERGED\`;`,
        `- ${unsupported} pinned \`UNSUPPORTED\`;`,
        '- 0 errors.',
        `\`${conformant} / ${diverged} / ${unsupported} / 0\``,
        `This ${families}-family live replay`,
      ],
      'resources/roadmap.md': [
        `pinned at ${families} replayable transcript families: ${conformant} pass, ${unsupported} is unsupported by a single-connection replay, and none diverge or error.`,
      ],
    }

    expect(diverged, 'the pages say no family diverges').toBe(0)

    for (const [rel, expected] of Object.entries(phrases)) {
      const text = readFileSync(join(DOCS_ROOT, rel), 'utf8')

      for (const phrase of expected) {
        expect(text, rel).toContain(phrase)
      }
    }
  })
})

describe.skipIf(!reachable)('golden corpus × LIVE kizunasync SQL RPCs', () => {
  for (const { id, file } of TRANSCRIPTS) {
    test(id, async () => {
      const t = readTranscript(file)
      const server = new PgReferenceServer(db!, DB_URL)

      server.declareColumns(collectDeclaredColumns(t))
      let result: TReplay

      try {
        result = await replay(t, server)
      } finally {
        await server.cleanup()
      }

      if (result.status === 'pass') {
        summary.push({ id, outcome: 'PASS-BYTE', note: 'byte-equal (incl. seq/cursor) after owner/column/pk translation' })
      } else if (result.status === 'semantic') {
        summary.push({
          id,
          outcome: 'PASS-SEMANTIC',
          note: `equal except seq/cursor/deleted_at (first at step ${result.step} ${result.rpc})`,
        })
      } else if (result.status === 'unsupported') {
        summary.push({ id, outcome: 'UNSUPPORTED', note: result.reason })
      } else if (result.status === 'diverged') {
        const note = DIVERGENCE_NOTE[id] ?? `step ${result.step} ${result.rpc}`

        summary.push({ id, outcome: 'DIVERGED', note: `step ${result.step} ${result.rpc}: ${note}` })
        console.log(
          `\n[DIVERGENCE] ${id}: step ${result.step} ${result.rpc}\n  expected: ${result.expected.trim()}\n  actual:   ${result.actual.trim()}\n`,
        )
      } else {
        summary.push({ id, outcome: 'ERROR', note: result.detail })
      }

      // THE GATE: lock this family to its pinned outcome and FAIL BY NAME on drift.
      const expected = EXPECTED[id]
      const actual = outcomeOf(result)
      const detail = result.status === 'errored' ? `: ${result.detail}` : ''
      const explanation =
        expected !== undefined && expected.outcome !== 'PASS-BYTE' && expected.outcome !== 'PASS-SEMANTIC'
          ? `\n  pinned reason: ${(expected as { reason: string }).reason}`
          : ''

      // The message NAMES the transcript family so a CI failure points straight at it.
      expect(
        `${id}: ${lockHolds(expected, actual) ? expected?.outcome : actual}${detail}`,
        `conformance LOCK broke for ${id}: expected ${expected?.outcome ?? '<no allowlist entry>'}, got ${actual}.` +
          ` Update the EXPECTED allowlist deliberately if this change is intended (with a reason for DIVERGED/UNSUPPORTED).${explanation}`,
      ).toBe(`${id}: ${expected?.outcome ?? '<no allowlist entry>'}`)
    })
  }

  // Declared after the transcript tests so every summary row is pushed before this runs.
  test('zz report: conformance taxonomy (live SQL vs oracle)', () => {
    const by = (o: string) => summary.filter((s) => s.outcome === o)

    console.log('\n================ CONFORMANCE: golden corpus vs LIVE SQL ================')

    for (const s of summary) {
      console.log(`  ${s.outcome.padEnd(14)} ${s.id}`)
    }
    console.log('----- non-PASS detail --------------------------------------------------')

    for (const s of summary) {
      if (s.outcome !== 'PASS-BYTE' && s.outcome !== 'PASS-SEMANTIC') {
        console.log(`  ${s.outcome.padEnd(14)} ${s.id}\n      ↳ ${s.note}`)
      }
    }
    console.log('-----------------------------------------------------------------------')
    console.log(
      `  PASS-BYTE ${by('PASS-BYTE').length}  ·  PASS-SEMANTIC ${by('PASS-SEMANTIC').length}  ·  ` +
        `DIVERGED ${by('DIVERGED').length}  ·  UNSUPPORTED ${by('UNSUPPORTED').length}  ·  ` +
        `ERROR ${by('ERROR').length}  (of ${summary.length})`,
    )
    console.log('=======================================================================\n')
    expect(summary.length).toBeGreaterThan(0)

    // ALLOWLIST COMPLETENESS: TRANSCRIPTS and EXPECTED must name exactly the same set.
    const transcriptIds = [...TRANSCRIPTS.map((x) => x.id)].sort()
    const expectedIds = Object.keys(EXPECTED).sort()

    expect(
      expectedIds,
      'EXPECTED allowlist must pin exactly the TRANSCRIPTS set: add/remove the entry deliberately (with a reason for any DIVERGED/UNSUPPORTED).',
    ).toEqual(transcriptIds)

    // AGGREGATE LOCK: the conformance shape: 45 conformant (PASS-BYTE+PASS-SEMANTIC), 0 DIVERGED (push/002 and push/006 both stay conformant because the replay uses a strict owner-only-RLS fixture, the corpus owner-only model, so an absent or cross-owner row is RLS_DENIED with a null server_row; see the EXPECTED entries above), 1 UNSUPPORTED (the held-txn race), 0 ERROR. A drift in any bucket trips here in addition to the per-family lock.
    const conformant = by('PASS-BYTE').length + by('PASS-SEMANTIC').length
    const expected = { conformant: 45, diverged: 0, unsupported: 1, error: 0 }

    expect({
      conformant,
      diverged: by('DIVERGED').length,
      unsupported: by('UNSUPPORTED').length,
      error: by('ERROR').length,
    }).toEqual(expected)
    const ciCd = readFileSync(join(DOCS_ROOT, 'operations/ci-cd.md'), 'utf8')

    expect(ciCd).toContain(
      `${expected.conformant} / ${expected.diverged} / ${expected.unsupported} / ${expected.error}`,
    )
  })
})
