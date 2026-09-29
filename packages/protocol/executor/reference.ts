/**
 * Reference protocol server.
 *
 * In-memory `IProtocolServer` derived only from the corpus and spec
 * [P:the-golden-corpus-and-deterministic-placeholders]. Fencing is the Postgres
 * transaction-visibility horizon decided by D-visibility-horizon, the refined xid8
 * snapshot horizon (D-visibility-horizon; P:keyset-pagination-and-delivery-bound; SQL:visibility-horizon):
 * `pg_visible_in_snapshot` delivers any committed, visible row even when a lower
 * seq is still in flight. The opaque cursor (D-cursor-opaque-token) carries the
 * high-water mark plus the pending holes (see `../spec/cursor-token.ts`), and its
 * no-hole form is the flat decimal, so a case with no committed seq above an
 * in-flight seq emits the flat token. A continuation page's token also carries
 * the start, the checkpoint its transfer started from, which the expiry gate
 * checks.
 *
 * Schema handshake (P:schema-version-signalling; D-schema-version-handshake, decided): a push below the configured
 * `min_schema_version` returns a typed `RESET_REQUIRED` signal (lifecycle/003),
 * the push-side mirror of the pull gate (lifecycle/002), never a fabricated
 * verdict. D-atomic-batch-abort (atomic batches) is decided and implemented below.
 *
 * Inert-by-design wire fields: `last_mutation_id` accepted, never read (D-dedup-storage-model);
 * `client_id` accepted, ignored (D-client-identity: the registry it keys is a pack object and
 * this oracle holds none, so identity changes no response byte);
 * `base_hint` accepted, ignored (D-base-hint); `hlc` never consulted for ordering on
 * arrival-mode tables (the default, a normative exclusion, P:verdict-completeness-transforms-and-conflict-rejection). On hlc-mode
 * tables (`conflict_mode` 'hlc', origin-order resolution) `hlc` is the
 * per-column LWW ordering key (conflict/003). Optional D-conflict-journal-visibility conflicts are omitted when empty.
 * No wake-up surface (D-wakeup-channel). Determinism: no `Date.now`, no `Math.random`.
 */

import { compareUtf8 } from '../harness/canonical'
import { decodeCursor, encodeCursor } from '../spec/cursor-token'
import type { TCursorToken } from '../spec/cursor-token'
import { DEFAULT_MAX_PULL_SCAN, DEFAULT_PAGE_LIMIT, MAX_PULL_BUCKETS } from '../spec/limits'
import { EBatchOutcome, ERejectReason, ESignalType, EVerdictKind } from '../spec/wire-types'
import type { TBatchAbort, TBucket, TColumnValue, TColumnValues, TConflict, TMutation, TPullRequest, TPullResponse, TPushRequest, TPushResponse, TRejectReason, TRowChange, TSignalType, TTransform, TTombstone, TVerdict } from '../spec/wire-types'
import type { IProtocolServer, TFencing, THistoryOp, TServerChange, TServerSeed, TServerTableConfig } from './server-contract'

// MARK: - Constants

const DEFAULT_LIMIT = DEFAULT_PAGE_LIMIT

/**
 * hlc-mode forward-drift tolerance (ms): the server clamps an incoming HLC's
 * physical part to min(client_physical, serverNow + this) so a far-future HLC
 * cannot poison a column forever (SQL:hlc-skew-clamp). Conservative few seconds;
 * honest in-bounds HLCs pass through unchanged.
 */
const MAX_CLOCK_SKEW_MS = 5000 // [SQL:hlc-skew-clamp]

// MARK: - Internal record types

/** `bucket` is the bucket value the write left the row in, the label `_changelog.bucket_value` carries (null on an unbucketed table). */
type TChangeRecord = { seq: bigint; arrived_step: number; bucket: string | null }

/** One tombstone per (table, pk, bucket value the row left), like `_tombstones` (D-bucket-move-out); `bucket` is '' when there is none. */
type TTombstoneRecord = { table: string; pk: string; bucket: string; seq: bigint; deleted_at: string; arrived_step: number; snapshot: TColumnValues }

type TInflightEffect =
  | { op: 'upsert'; table: string; pk: string; columns: TColumnValues; seq: bigint; moveOutSeq?: bigint; arrived_step: number; hlc?: string }
  | { op: 'delete'; table: string; pk: string; seq: bigint; deleted_at: string; arrived_step: number }

/** `moveOutSeq` is the seq a write that moves the row to another bucket value stamped, before its own, for the old value's tombstone. */
type TUpsertCommit = { table: string; pk: string; columns: TColumnValues; seq: bigint; moveOutSeq?: bigint; arrivedStep: number; hlc?: string }
type TDeleteCommit = { table: string; pk: string; seq: bigint; deletedAt: string; arrivedStep: number }

/** One applied column checked for the conflict journal against the row it overwrites. */
type TColumnOverwrite = { prior: TColumnValues; column: string; value: TColumnValue }

/** A committed write whose overwrites the conflict journal may record; `prior` is the row before the write, undefined when absent. */
type TJournaledWrite = { mutation: TMutation; prior: TColumnValues | undefined; applied: TColumnValues; winnerSeq: bigint }

type TPendingRow = { seq: bigint; table: string; pk: string; row: TColumnValues }
type TPendingTombstone = { seq: bigint; table: string; pk: string; deleted_at: string }

/** One candidate of the stream a page walks: an entry it delivers, or one it withholds (a row with `row` null, a tombstone `withheld`). */
type TCandidate =
  | { kind: 'row'; seq: bigint; table: string; pk: string; row: TColumnValues | null }
  | ({ kind: 'tombstone'; withheld: boolean } & TPendingTombstone)
type TDeliverable = { candidates: TCandidate[]; responseCursor: TCursorToken; transferStart: bigint }

/** A recorded verdict with the row it named, which a replay renders again (D-verdict-ownership). */
type TRecordedVerdict = { verdict: TVerdict; table: string; pk: string }

type TJournalEntry = {
  table: string
  pk: string
  column_name: string
  loser_value: unknown
  winner_mutation_id: string
  conflict_mode: 'arrival' | 'hlc'
  winner_seq: bigint
}

/**
 * The column phase of an insert or update: a verdict that ends the mutation, or
 * the seq its columns stamped, which the transform phase reuses (null when no
 * column landed).
 */
type TColumnsOutcome = { terminal: TVerdict } | { appliedSeq: bigint | null }

/**
 * One mutation with the row it targets as currently committed (undefined when
 * absent) and its table's seeded config (undefined for an unknown table).
 */
type TMutationTarget = { mutation: TMutation; row: TColumnValues | undefined; config: TServerTableConfig | undefined }

type TTransformsInput = Pick<TMutationTarget, 'mutation' | 'row'> & { appliedSeq: bigint | null }

/**
 * Deep-enough snapshot of the mutable committed state for atomic revert
 * (D-atomic-batch-abort decided) and for a rejected mutation's revert: rows
 * deep-copied incl. the inner column objects so an intra-batch update cannot
 * leak across a revert; changelog/tombstones/verdicts shallow-copy each record
 * value (records are immutable once written).
 */
type TSnapshot = {
  rows: Map<string, Map<string, TColumnValues>>
  changelog: Map<string, TChangeRecord>
  tombstones: Map<string, TTombstoneRecord>
  columnHlc: Map<string, Record<string, string>>
  journal: TJournalEntry[]
  verdicts: Map<string, TRecordedVerdict>
  nextSeq: bigint
  maxCommittedSeq: bigint
}

// MARK: - Helpers

const rowKey = (table: string, pk: string): string => `${table}/${pk}`
const tombstoneKey = (table: string, pk: string, bucket: string): string => `${table}/${pk}/${bucket}`
const grantKey = (table: string, bucket: string): string => `${table}/${bucket}`

/** A bucket value as text, the way Postgres `->>` renders a JSON scalar: the label `track_change` writes and a pull compares. */
const bucketLabel = (value: TColumnValue | undefined): string | null => {
  if (value === undefined || value === null) {
    return null
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Logical timestamp grammar logical-step timestamp: deleted_at encodes the step that performed the delete (tombstones/001 n=4 → 00:00:04; tombstones/002 n=5 → 00:00:05). */
const stepTimestamp = (step: number): string => `2026-01-01T00:00:${String(step).padStart(2, '0')}.000Z`

const maxBigint = (a: bigint, b: bigint): bigint => (a > b ? a : b)

/**
 * Total order over the origin-HLC wire string `<iso>|<logical>|<node>` (P-4 grammar):
 * `<iso>` lexicographically (ISO-8601 sorts chronologically), then `<logical>` numerically,
 * then `<node>` byte-wise. Deterministic: the hlc-mode per-column LWW arbiter (conflict/003, P:verdict-completeness-transforms-and-conflict-rejection).
 */
const compareHlc = (a: string, b: string): number => {
  const [isoA = '', logicalA = '', nodeA = ''] = a.split('|')
  const [isoB = '', logicalB = '', nodeB = ''] = b.split('|')

  if (isoA !== isoB) {
    return compareUtf8(isoA, isoB)
  }
  const numA = BigInt(logicalA)
  const numB = BigInt(logicalB)

  if (numA !== numB) {
    return numA < numB ? -1 : 1
  }
  return compareUtf8(nodeA, nodeB)
}

/**
 * Bound the PHYSICAL (ISO) component of an origin HLC wire string
 * `<iso>|<logical>|<node>` (P-4 grammar) to at most serverNow + maxSkewMs,
 * keeping `<logical>` and `<node>` verbatim. Mirrors SQL kizunasync._clamp_hlc:
 * the ceiling is rendered in the client's exact toISOString() shape (UTC, 3
 * fractional digits, 'Z') so a clamped value compares byte-for-byte under
 * compareHlc; the client physical part passes through UNCHANGED when at/below
 * the ceiling (the honest in-bounds path). serverNow is the injected logical
 * clock (stepTimestamp): NO Date.now, determinism preserved.
 */
const clampHlc = (hlc: string, serverNowIso: string, maxSkewMs: number): string => {
  const [iso = '', logical = '', node = ''] = hlc.split('|')
  const ceilingIso = new Date(Date.parse(serverNowIso) + maxSkewMs).toISOString()

  // compareUtf8 mirrors compareHlc's bytewise ISO order: clamp only when the client physical part exceeds the ceiling.
  return compareUtf8(iso, ceilingIso) > 0 ? `${ceilingIso}|${logical}|${node}` : hlc
}

// (seq, table, pk) page order with byte-wise table/pk compare (I-10 [P:keyset-pagination-and-delivery-bound])
const byPageOrder = (a: { seq: bigint; table: string; pk: string }, b: { seq: bigint; table: string; pk: string }): number => {
  if (a.seq !== b.seq) {
    return a.seq < b.seq ? -1 : 1
  }
  return compareUtf8(a.table, b.table) || compareUtf8(a.pk, b.pk)
}

const I32_ABS = 2147483648n

const encodeSignedInt = (n: bigint): number | string => {
  const abs = n < 0n ? -n : n

  if (abs < I32_ABS) {
    return Number(n)
  }
  return n.toString()
}

const parseColumnInt = (value: unknown): bigint | null => {
  if (value === undefined || value === null) {
    return 0n
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : null
  }
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value)
  }
  return null
}

const parseTransformInt = (value: number | string): bigint | null => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : null
  }
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value)
  }
  return null
}

const asArrayCell = (value: unknown): TColumnValue[] => (Array.isArray(value) ? (value as TColumnValue[]) : [])

const cellKey = (value: TColumnValue): string => JSON.stringify(value)

const applyTransform = (
  current: TColumnValues,
  column: string,
  transform: TTransform,
): { ok: true; next: TColumnValues } | { ok: false } => {
  const next: TColumnValues = { ...current }

  if (transform.op === 'increment') {
    const base = parseColumnInt(next[column])
    const by = parseTransformInt(transform.by)

    if (base === null || by === null) {
      return { ok: false }
    }
    next[column] = encodeSignedInt(base + by) as TColumnValue

    return { ok: true, next }
  }
  if (transform.op === 'arrayUnion') {
    const seen = new Set(asArrayCell(next[column]).map(cellKey))
    const out = [...asArrayCell(next[column])]

    for (const member of transform.values) {
      const key = cellKey(member as TColumnValue)

      if (!seen.has(key)) {
        seen.add(key)
        out.push(member as TColumnValue)
      }
    }
    next[column] = out as unknown as TColumnValue

    return { ok: true, next }
  }
  const remove = new Set(transform.values.map((member) => cellKey(member as TColumnValue)))

  next[column] = asArrayCell(next[column]).filter((member) => !remove.has(cellKey(member))) as unknown as TColumnValue

  return { ok: true, next }
}

const mutationTransforms = (mutation: TMutation): Record<string, TTransform> =>
  mutation.transforms !== undefined && Object.keys(mutation.transforms).length > 0
    ? mutation.transforms
    : {}

function hasTransforms(mutation: TMutation): boolean {
  return Object.keys(mutationTransforms(mutation)).length > 0
}

function copyRow(row: TColumnValues | undefined): TColumnValues | null {
  return row !== undefined ? { ...row } : null
}

/** The named columns `row` carries, in the order given; a column the row lacks is left out. */
function pickColumns(row: TColumnValues, columns: string[]): TColumnValues {
  const picked: TColumnValues = {}

  for (const column of columns) {
    const value = row[column]

    if (value !== undefined) {
      picked[column] = value
    }
  }
  return picked
}

/** The page entry a candidate becomes, or null for a row the page withholds. */
function deliverableEntry(candidate: TCandidate): TPendingRow | TPendingTombstone | null {
  if (candidate.kind === 'tombstone') {
    return candidate.withheld ? null : { seq: candidate.seq, table: candidate.table, pk: candidate.pk, deleted_at: candidate.deleted_at }
  }
  return candidate.row === null ? null : { seq: candidate.seq, table: candidate.table, pk: candidate.pk, row: candidate.row }
}

function isJournaledOverwrite({ prior, column, value }: TColumnOverwrite): boolean {
  if (column === 'id' || !Object.prototype.hasOwnProperty.call(prior, column)) {
    return false
  }
  const old = prior[column]

  return old !== undefined && old !== null && old !== value
}

// MARK: - Reference server

export class ReferenceServer implements IProtocolServer {
  // MARK: - State

  private rows = new Map<string, Map<string, TColumnValues>>()
  private changelog = new Map<string, TChangeRecord>()
  private tombstones = new Map<string, TTombstoneRecord>()

  /**
   * hlc-mode per-column high-water-mark: rowKey → { column: hlcString }. The
   * last write to each column on a committed row (conflict/003, P:verdict-completeness-transforms-and-conflict-rejection). Empty for
   * arrival-mode rows: never consulted on the arrival path.
   */
  private columnHlc = new Map<string, Record<string, string>>()

  private journal: TJournalEntry[] = []

  /** The (table, bucket value) pairs the subject's pulls delivered a live row from, like `_bucket_grants` (D-tombstone-delivery). */
  private grants = new Set<string>()

  /** The rows the push in progress deleted, like a delete queued in the pushing transaction: a later mutation of one answers DELETE_WINS without a grant. */
  private pushDeletes = new Set<string>()

  private reapHorizon = 0n // highest reaped tombstone seq (lifecycle/001 → 2n)
  private maxPullScan = DEFAULT_MAX_PULL_SCAN
  private nextSeq = 1n
  private maxCommittedSeq = 0n // max committed stamped seq: the refined cursor's high-water floor (D-visibility-horizon)
  private inflight = new Map<string, TInflightEffect[]>()
  private verdicts = new Map<string, TRecordedVerdict>()
  private step = 0

  /**
   * Seed config (client_id / tombstone_ttl_days stored but behaviorally
   * inert: identity is not wire bytes [D-client-identity]; TTL never elapses inside a
   * ≤59-logical-second transcript: reaping happens only via elided history).
   */
  private clientId = ''

  private userId = ''
  private minSchemaVersion = 1
  private tables: Record<string, TServerTableConfig> = {}
  private tombstoneTtlDays = 0
  private fencing: TFencing = 'visibility-horizon'

  // MARK: - IProtocolServer: seeding and the logical clock

  seed(seed: TServerSeed): void {
    this.rows = new Map()
    this.changelog = new Map()
    this.tombstones = new Map()
    this.columnHlc = new Map()
    this.journal = []
    this.grants = new Set()
    this.pushDeletes = new Set()
    this.reapHorizon = 0n
    this.inflight = new Map()
    this.verdicts = new Map()
    this.step = 0
    this.clientId = seed.client_id
    this.userId = seed.user_id
    this.minSchemaVersion = seed.min_schema_version
    this.tables = seed.tables
    this.tombstoneTtlDays = seed.tombstone_ttl_days
    this.fencing = seed.fencing
    this.maxPullScan = seed.max_pull_scan ?? DEFAULT_MAX_PULL_SCAN
    this.nextSeq = BigInt(seed.next_seq)
    // Elided history below next_seq is committed by definition (Decimal seq and cursor token: fencing cases use seq gaps by design, the client checkpoint already covers it)
    this.maxCommittedSeq = this.nextSeq - 1n

    for (const op of seed.history) {
      this.applyHistoryOp(op)
    }
  }

  setStep(n: number): void {
    this.step = n
  }

  // MARK: - IProtocolServer: out-of-band changes

  applyServerChange(change: TServerChange): void {
    // A reap names no row and consumes no seq (lifecycle/006).
    if (change.op === 'reap') {
      this.reapTombstones()

      return
    }
    const moveOutSeq = change.op === 'upsert' ? this.stampMoveOut(change.table, change.pk, change.columns ?? {}) : undefined
    const seq = this.stampSeq()

    if (change.txn !== undefined) {
      // Stamp the seq immediately and hold visibility until commitTxn: the supastash-class late-commit race (fencing/001 context.notes; P:keyset-pagination-and-delivery-bound). The trigger sets arrived_step at stamp time, not at commit time.
      const effects = this.inflight.get(change.txn) ?? []

      if (change.op === 'upsert') {
        effects.push({ op: 'upsert', table: change.table, pk: change.pk, columns: change.columns ?? {}, seq, moveOutSeq, arrived_step: this.step, hlc: change.hlc })
      } else {
        effects.push({
          op: 'delete',
          table: change.table,
          pk: change.pk,
          seq,
          deleted_at: stepTimestamp(this.step),
          arrived_step: this.step,
        })
      }
      this.inflight.set(change.txn, effects)

      return
    }
    if (change.op === 'upsert') {
      this.commitUpsert({
        table: change.table,
        pk: change.pk,
        columns: change.columns ?? {},
        seq,
        moveOutSeq,
        arrivedStep: this.step,
        hlc: change.hlc,
      })
    } else {
      this.commitDelete({
        table: change.table,
        pk: change.pk,
        seq,
        deletedAt: stepTimestamp(this.step),
        arrivedStep: this.step,
      })
    }
  }

  commitTxn(txn: string): void {
    const effects = this.inflight.get(txn)

    if (effects === undefined) {
      throw new Error(`commitTxn: unknown transaction "${txn}" (fail loud)`)
    }
    this.inflight.delete(txn)

    for (const effect of effects) {
      if (effect.op === 'upsert') {
        this.commitUpsert({
          table: effect.table,
          pk: effect.pk,
          columns: effect.columns,
          seq: effect.seq,
          moveOutSeq: effect.moveOutSeq,
          arrivedStep: effect.arrived_step,
          hlc: effect.hlc,
        })
      } else {
        this.commitDelete({
          table: effect.table,
          pk: effect.pk,
          seq: effect.seq,
          deletedAt: effect.deleted_at,
          arrivedStep: effect.arrived_step,
        })
      }
    }
  }

  // MARK: - IProtocolServer: pull

  pull(request: TPullRequest): TPullResponse {
    const limit = request.limit ?? DEFAULT_LIMIT

    // The pack refuses a page that could hold no entry before any gate runs, with SQLSTATE 22023 (invalid_parameter_value); an absent or null limit is the default.
    if (limit < 1) {
      throw Object.assign(new Error('kizunasync.pull(): limit must be at least 1'), { code: '22023' })
    }
    // Each bucket entry is a range the pack's candidate read scans, so it refuses a pull that names more than it bounds, with the same SQLSTATE.
    if (request.buckets.length > MAX_PULL_BUCKETS) {
      throw Object.assign(new Error(`kizunasync.pull(): a pull names at most ${MAX_PULL_BUCKETS} bucket entries`), { code: '22023' })
    }
    this.assertPullPolicy(request.buckets)

    // 1. RESET_REQUIRED, the schema handshake gates everything (P:schema-version-signalling; lifecycle/002): empty page, echoed cursor (I-8/D-signal-excludes-page-data).
    if (request.schema_version < this.minSchemaVersion) {
      return this.signalPage(request.cursor, ESignalType.RESET_REQUIRED)
    }
    const token = decodeCursor(request.cursor)

    if (this.isCheckpointExpired(token)) {
      return this.signalPage(request.cursor, ESignalType.CHECKPOINT_EXPIRED)
    }
    const deliverable = this.collectDeliverable(token, request.buckets)

    return this.paginate(deliverable, limit)
  }

  private assertPullPolicy(buckets: TBucket[]): void {
    // Pull policy (the pack raises KZL01): a table provisioned with a bucket column must be pulled with a bucket that names that column. Tombstones carry only the stored bucket snapshot and never replay RLS, so an unscoped pull could not receive deletes without leaking every deleted pk.
    for (const bucket of buckets) {
      const column = this.tables[bucket.table]?.bucket_column

      if (column && !(column in bucket.params)) {
        throw new Error(
          `pull: table "${bucket.table}" is bucketed on "${column}": the pull bucket must name that column (fail loud)`,
        )
      }
    }
  }

  private isCheckpointExpired(token: TCursorToken): boolean {
    // 2. CHECKPOINT_EXPIRED: the checkpoint the transfer started from predates the oldest retained tombstone ("the token is invalidated, not advanced", lifecycle/001). A continuation token carries that checkpoint as its start and a checkpoint token is its own high-water (D-cursor-opaque-token). Start '0' is exempt: a bootstrap or a rehydration always runs to completion, while a transfer from a reaped checkpoint expires even mid-transfer, because tombstones above its position may be gone.
    const checkpoint = token.start ?? token.highWater

    return checkpoint > 0n && checkpoint < this.reapHorizon
  }

  private collectDeliverable(token: TCursorToken, buckets: TBucket[]): TDeliverable {
    // 3-5. Candidate stream plus response cursor under the refined horizon (D-visibility-horizon): any committed, visible entry whose seq is above highWater OR sits in holes (pg_visible_in_snapshot semantics), so a page carries the new committed rows above the mark PLUS the holes an earlier page skipped that have since committed.
    return {
      candidates: [...this.collectRowCandidates(token, buckets), ...this.collectPendingTombstones(token, buckets)].sort(byPageOrder),
      responseCursor: this.refinedCursorToken(token),
      transferStart: token.start ?? token.highWater,
    }
  }

  private paginate({ candidates, responseCursor, transferStart }: TDeliverable, limit: number): TPullResponse {
    // 6. Pagination: a page is a prefix of one stream, the deliverable rows and tombstones together in (seq, table, pk) order, counted against one cap (P:keyset-pagination-and-delivery-bound; D-page-cap-and-checkpoint-boundary). The walk also stops once it has examined maxPullScan candidates, withheld entries included, like `kizunasync._pull_page` (SQL:pull-scan-cap).
    const rows: TPendingRow[] = []
    const tombstones: TPendingTombstone[] = []
    let scanned = 0
    let lastScanned = 0n
    let lastEntry = 0n

    for (const candidate of candidates) {
      // A candidate past the scan cap proves there is more, and the next page continues from the last candidate this one examined.
      if (scanned === this.maxPullScan) {
        return this.continuationPage({ rows, tombstones, position: lastScanned, responseCursor, transferStart })
      }
      scanned += 1
      lastScanned = candidate.seq

      const entry = deliverableEntry(candidate)

      if (entry === null) {
        continue
      }
      // A deliverable entry past the limit proves there is more, and the next page continues from this page's last entry.
      if (rows.length + tombstones.length === limit) {
        return this.continuationPage({ rows, tombstones, position: lastEntry, responseCursor, transferStart })
      }
      lastEntry = entry.seq

      if ('row' in entry) {
        rows.push(entry)
        this.grants.add(grantKey(entry.table, this.bucketOf(entry.table, entry.row) ?? ''))
      } else {
        tombstones.push(entry)
      }
    }
    // A remaining stream of at most `limit` entries, examined within the scan cap, is the final page, an exact fit included.
    return this.finalPage(rows, tombstones, responseCursor)
  }

  /**
   * A continuation page. Its cursor starts from the transfer's checkpoint and
   * sits at `position`, the seq of the page's last entry, or of the last
   * candidate it examined when the scan cap stopped it. It keeps only the holes
   * below that seq, because the next pull rescans every seq above it.
   */
  private continuationPage(page: { rows: TPendingRow[]; tombstones: TPendingTombstone[]; position: bigint; responseCursor: TCursorToken; transferStart: bigint }): TPullResponse {
    const { rows, tombstones, position, responseCursor, transferStart } = page

    return this.withConflicts({
      cursor: encodeCursor({ start: transferStart, highWater: position, holes: responseCursor.holes.filter((hole) => hole < position) }),
      has_more: true,
      rows: rows.map(renderRow),
      signal: null,
      tombstones: tombstones.map(renderTombstone),
    })
  }

  // MARK: - IProtocolServer: push

  push(request: TPushRequest): TPushResponse {
    // Whole-request schema gate BEFORE any mutation (P:schema-version-signalling; D-schema-version-handshake decided): a push below the configured minimum returns a typed RESET_REQUIRED signal, symmetric with pull (lifecycle/002), never a fabricated verdict (lifecycle/003). The client soft-blocks; outbox + watermark untouched.
    if (request.schema_version < this.minSchemaVersion) {
      return { signal: { type: ESignalType.RESET_REQUIRED } }
    }
    this.pushDeletes = new Set()

    // last_mutation_id accepted, never read (D-dedup-storage-model stays unresolved: the per-mutation verdict map is internal storage, not wire-visible).
    if (!request.batch.atomic) {
      // Per-mutation verdicts (the bijection, I-5): unflagged batches apply each mutation independently (P:verdict-completeness-transforms-and-conflict-rejection).
      const verdicts = request.batch.mutations.map((mutation) => this.processMutation(mutation))

      return { verdicts }
    }
    // Atomic = all-or-nothing (D-atomic-batch-abort decided, JSON:API / AIP-233 shape). Snapshot the committed state, process in order with the SAME engine: applies record their effect, so an intra-batch dependency (e.g. insert then update the same row) is handled exactly as a non-atomic batch would see it. On the first rejection, restore the snapshot (revert every effect incl. the verdict records and the seq counter) and return one batch outcome naming the offender; no per-member verdicts.
    const before = this.snapshot()
    const verdicts: TVerdict[] = []

    for (const mutation of request.batch.mutations) {
      const verdict = this.processMutation(mutation)

      if (verdict.verdict === EVerdictKind.rejected) {
        this.restore(before)
        const abort: TBatchAbort = {
          offender_mutation_id: verdict.mutation_id,
          outcome: EBatchOutcome.aborted,
          reason: verdict.reason,
          server_row: verdict.server_row,
        }

        return { batch: abort }
      }
      verdicts.push(verdict)
    }
    return { verdicts }
  }

  // MARK: - Mutation processing

  private processMutation(mutation: TMutation): TVerdict {
    // 1. Replay: the recorded kind and reason return with no effect (P:verdict-completeness-transforms-and-conflict-rejection; push/003, the retry stamps nothing), and a server_row is rendered again as the row stands now (D-verdict-ownership; push/007).
    const recorded = this.verdicts.get(mutation.mutation_id)

    if (recorded !== undefined) {
      return this.replayVerdict(recorded)
    }
    const before = this.snapshot()
    const verdict = this.decideMutation(mutation)

    // A mutation is one unit (P:verdict-completeness-transforms-and-conflict-rejection): a rejected verdict leaves no effect, so every write it made reverts before the verdict is recorded.
    if (verdict.verdict === EVerdictKind.rejected) {
      this.restore(before)
    }
    // Record EVERY verdict (applied and rejected) for replay.
    this.verdicts.set(mutation.mutation_id, { verdict, table: mutation.table, pk: mutation.pk })

    return verdict
  }

  /**
   * The ledger keeps no row copy (D-verdict-ownership): a verdict that carried a server_row carries the recorded row as the subject's RLS analog renders it now.
   * A rejection carries a row the subject cannot read at the replay as null; an applied verdict, whose server_row is column values only, leaves it out.
   */
  private replayVerdict({ verdict, table, pk }: TRecordedVerdict): TVerdict {
    if (!('server_row' in verdict)) {
      return verdict
    }
    const serverRow = this.renderSubjectRow(table, pk)

    if (verdict.verdict === EVerdictKind.rejected) {
      return { ...verdict, server_row: serverRow }
    }
    if (serverRow === null) {
      return { mutation_id: verdict.mutation_id, verdict: verdict.verdict }
    }
    return { ...verdict, server_row: serverRow }
  }

  /** The row as the subject's RLS analog renders it: present and owned by the subject, else null. */
  private renderSubjectRow(table: string, pk: string): TColumnValues | null {
    const row = this.rows.get(table)?.get(pk)
    const config = this.tables[table]

    return row !== undefined && config !== undefined && row[config.bucket_column] === this.userId ? { ...row } : null
  }

  private decideMutation(mutation: TMutation): TVerdict {
    const row = this.rows.get(mutation.table)?.get(mutation.pk)
    const gated = this.gate({ mutation, row, config: this.tables[mutation.table] })

    if (gated !== null) {
      return gated
    }
    // 5. Apply. A delete is remove-wins under EITHER mode: it always wins going forward (tombstone sticky, the gate above rejects later edits).
    if (mutation.op === 'delete') {
      return this.applyDeleteOp(mutation)
    }
    const columns = this.applyColumnsOp(mutation, row)

    if ('terminal' in columns) {
      return columns.terminal
    }
    if (hasTransforms(mutation)) {
      return this.applyTransformsOp({ mutation, row, appliedSeq: columns.appliedSeq })
    }
    return { mutation_id: mutation.mutation_id, verdict: EVerdictKind.applied }
  }

  private gate({ mutation, row, config }: TMutationTarget): TVerdict | null {
    if (config === undefined) {
      throw new Error(`push: unknown table "${mutation.table}": not in the seeded table config (fail loud)`)
    }
    // 2. Delete-wins, checked after the table config and before RLS: the deleted row has no owner left to evaluate (tombstones/002; D-rejection-reasons note: revert = local delete). A subject that never received the row gets RLS_DENIED instead (D-tombstone-delivery).
    const deleted = this.deletedRowReason(mutation.table, mutation.pk)

    if (deleted !== null) {
      return rejectedVerdict(mutation, deleted, null)
    }
    // 3. Caller-scoped RLS (P:cursor-monotonicity-rebase-and-atomic-checkpoints) produces a rejected verdict and never wedges the queue: processing continues with the next mutation (push/002, P:verdict-completeness-transforms-and-conflict-rejection/P:outbox-and-serial-in-flight).
    if (mutation.op === 'insert') {
      // WITH-CHECK analog (unexercised by the current corpus, P:cursor-monotonicity-rebase-and-atomic-checkpoints)
      if (mutation.columns[config.bucket_column] !== this.userId) {
        return rejectedVerdict(mutation, ERejectReason.RLS_DENIED, null)
      }
    } else {
      if (row === undefined) {
        // Nonexistent never-tombstoned row (push/006): an RLS-scoped server cannot (and must not) distinguish "absent" from "RLS-hidden" without leaking existence, so a non-insert op yields RLS_DENIED, not CONSTRAINT (D-rejection-reasons).
        return rejectedVerdict(mutation, ERejectReason.RLS_DENIED, null)
      }
      if (row[config.bucket_column] !== this.userId) {
        return rejectedVerdict(mutation, ERejectReason.RLS_DENIED, null)
      }
    }
    const precondition = this.checkPrecondition({ mutation, row, config })

    if (precondition !== null) {
      return precondition
    }
    if (mutation.op === 'insert' && hasTransforms(mutation)) {
      return rejectedVerdict(mutation, ERejectReason.CONSTRAINT, copyRow(row))
    }
    return null
  }

  private checkPrecondition({ mutation, row, config }: TMutationTarget & { config: TServerTableConfig }): TVerdict | null {
    // 4. Precondition (Bayou-style, P:verdict-completeness-transforms-and-conflict-rejection): the precondition's key set is the expected-value mask; mismatch returns the full current row when invoker-visible (push/004), else null (D-rejection-reasons).
    if (mutation.precondition !== undefined) {
      const mismatch = Object.entries(mutation.precondition).some(([column, expected]) => (row === undefined ? undefined : row[column]) !== expected)

      if (mismatch) {
        const visible = row !== undefined && row[config.bucket_column] === this.userId

        return rejectedVerdict(mutation, ERejectReason.PRECONDITION, visible ? { ...row } : null)
      }
    }
    return null
  }

  private applyDeleteOp(mutation: TMutation): TVerdict {
    const seq = this.stampSeq()

    this.pushDeletes.add(rowKey(mutation.table, mutation.pk))

    this.commitDelete({
      table: mutation.table,
      pk: mutation.pk,
      seq,
      deletedAt: stepTimestamp(this.step),
      arrivedStep: this.step,
    })

    return { mutation_id: mutation.mutation_id, verdict: EVerdictKind.applied }
  }

  private applyColumnsOp(mutation: TMutation, row: TColumnValues | undefined): TColumnsOutcome {
    const hasColumns = Object.keys(mutation.columns).length > 0

    // hlc-mode (opt-in, conflict/003): per-column LWW keyed on the origin HLC.
    if (this.tables[mutation.table]?.conflict_mode === 'hlc' && hasColumns) {
      return this.applyHlcColumns(mutation)
    }
    if (hasColumns) {
      // arrival mode (the default): a column-masked LWW merge where the columns key set IS the mask (P:mutations-and-column-masked-conflict-resolution; conflict/001); arrival order at the single arbiter stamps the seq (P:verdict-completeness-transforms-and-conflict-rejection; conflict/002). hlc is forensic only here.
      const moveOutSeq = this.stampMoveOut(mutation.table, mutation.pk, mutation.columns)
      const appliedSeq = this.stampSeq()
      const prior = this.rows.get(mutation.table)?.get(mutation.pk)

      this.commitUpsert({
        table: mutation.table,
        pk: mutation.pk,
        columns: mutation.columns,
        seq: appliedSeq,
        moveOutSeq,
        arrivedStep: this.step,
      })
      this.journalOverwrites({ mutation, prior, applied: mutation.columns, winnerSeq: appliedSeq })

      return { appliedSeq }
    }
    if (!hasTransforms(mutation)) {
      return { terminal: rejectedVerdict(mutation, ERejectReason.RLS_DENIED, copyRow(row)) }
    }
    return { appliedSeq: null }
  }

  private applyHlcColumns(mutation: TMutation): TColumnsOutcome {
    const key = rowKey(mutation.table, mutation.pk)
    const hlcVerdict = this.applyHlc(mutation, key)

    if (hlcVerdict.verdict === EVerdictKind.rejected && !hasTransforms(mutation)) {
      return { terminal: hlcVerdict }
    }
    if (hlcVerdict.verdict === EVerdictKind.rejected && hlcVerdict.reason !== ERejectReason.SUPERSEDED) {
      return { terminal: hlcVerdict }
    }
    return { appliedSeq: hlcVerdict.verdict === EVerdictKind.applied ? (this.changelog.get(key)?.seq ?? null) : null }
  }

  private applyTransformsOp({ mutation, row, appliedSeq }: TTransformsInput): TVerdict {
    const transforms = mutationTransforms(mutation)
    let current = { ...(this.rows.get(mutation.table)?.get(mutation.pk) ?? {}) }

    for (const [column, transform] of Object.entries(transforms)) {
      const applied = applyTransform(current, column, transform)

      if (!applied.ok) {
        return rejectedVerdict(mutation, ERejectReason.CONSTRAINT, copyRow(row))
      }
      current = applied.next
    }
    const transformColumns = pickColumns(current, Object.keys(transforms))
    const moveOutSeq = appliedSeq === null ? this.stampMoveOut(mutation.table, mutation.pk, transformColumns) : undefined
    const seq = appliedSeq ?? this.stampSeq()

    this.commitUpsert({
      table: mutation.table,
      pk: mutation.pk,
      columns: transformColumns,
      seq,
      moveOutSeq,
      arrivedStep: this.step,
    })
    const serverRow = { ...(this.rows.get(mutation.table)?.get(mutation.pk) ?? {}) }

    return { mutation_id: mutation.mutation_id, verdict: EVerdictKind.applied, server_row: serverRow }
  }

  // MARK: - hlc-mode resolution

  /**
   * For each masked column the mutation WINS iff its hlc strictly exceeds the
   * stored column high-water-mark (or no prior hlc). If EVERY masked column
   * loses, the whole mutation is SUPERSEDED ⇒ rejected with the current
   * committed row as server_row (the client compensating-reverts to the winner,
   * convergence). Otherwise apply only the winning columns (partial-win is still
   * `applied`) and advance their column hlc to the mutation's (conflict/003).
   */
  private applyHlc(mutation: TMutation, key: string): TVerdict {
    if (mutation.hlc === undefined) {
      throw new Error(`push: hlc-mode table "${mutation.table}" mutation carries no hlc (fail loud)`)
    }
    // Clamp the incoming HLC's physical part to serverNow + maxSkew, so a far-future HLC cannot poison the column (SQL:hlc-skew-clamp). serverNow is the injected logical clock: stepTimestamp of the current step, the deterministic analog of SQL clock_timestamp(). The CLAMPED value drives both the compare and the stamp (otherwise the raw far-future value would be re-stored and the lockout would persist).
    const hlc = clampHlc(mutation.hlc, stepTimestamp(this.step), MAX_CLOCK_SKEW_MS)
    const stamps = this.columnHlc.get(key) ?? {}
    const winning: TColumnValues = {}

    for (const [column, value] of Object.entries(mutation.columns)) {
      const prior = stamps[column]

      if (prior === undefined || compareHlc(hlc, prior) > 0) {
        winning[column] = value
      }
    }
    if (Object.keys(winning).length === 0) {
      // Every masked column lost ⇒ superseded; revert to the current committed row (invoker-visible by the RLS gate above).
      const current = this.rows.get(mutation.table)?.get(mutation.pk) ?? {}

      return rejectedVerdict(mutation, ERejectReason.SUPERSEDED, { ...current })
    }
    const moveOutSeq = this.stampMoveOut(mutation.table, mutation.pk, winning)
    const seq = this.stampSeq()
    const prior = this.rows.get(mutation.table)?.get(mutation.pk)

    this.commitUpsert({ table: mutation.table, pk: mutation.pk, columns: winning, seq, moveOutSeq, arrivedStep: this.step, hlc })
    this.journalOverwrites({ mutation, prior, applied: winning, winnerSeq: seq })

    return { mutation_id: mutation.mutation_id, verdict: EVerdictKind.applied }
  }

  // MARK: - Committed-state transitions

  private stampSeq(): bigint {
    const seq = this.nextSeq

    this.nextSeq += 1n

    return seq
  }

  private commitUpsert({ table, pk, columns, seq, moveOutSeq, arrivedStep, hlc }: TUpsertCommit): void {
    const key = rowKey(table, pk)
    const tableRows = this.rows.get(table) ?? new Map<string, TColumnValues>()
    const current = tableRows.get(pk) ?? {}
    const next = { ...current, ...columns }

    // A write that moved the row to another bucket value leaves the old value a tombstone, at the seq stamped before this write's own (D-bucket-move-out; tombstones/004).
    if (moveOutSeq !== undefined) {
      this.recordTombstone({ table, pk, seq: moveOutSeq, deletedAt: stepTimestamp(arrivedStep), arrivedStep })
    }
    tableRows.set(pk, next)
    this.rows.set(table, tableRows)
    // The changelog keeps one entry per (table, pk), the latest state only, like kizunasync._changelog after compaction (P:keyset-pagination-and-delivery-bound): conflict/001's step-8 page therefore carries seq 3 alone. It carries the bucket value the write left the row in.
    this.changelog.set(key, { seq, arrived_step: arrivedStep, bucket: this.bucketOf(table, next) })

    // hlc-mode high-water-mark: stamp each written column's hlc (conflict/003). Only when an hlc rides the write: arrival-mode writes carry none, so their map stays empty.
    if (hlc !== undefined) {
      const stamps = this.columnHlc.get(key) ?? {}

      for (const column of Object.keys(columns)) {
        stamps[column] = hlc
      }
      this.columnHlc.set(key, stamps)
    }
    this.maxCommittedSeq = maxBigint(this.maxCommittedSeq, seq)
  }

  private snapshotFor(table: string, pk: string): TColumnValues {
    const row = this.rows.get(table)?.get(pk)
    const config = this.tables[table]

    if (row === undefined || config === undefined) {
      return {}
    }
    const value = row[config.bucket_column]

    if (value === undefined) {
      return {}
    }
    return { [config.bucket_column]: value }
  }

  private tombstoneMatchesBuckets(table: string, snapshot: TColumnValues, buckets: TBucket[]): boolean {
    const config = this.tables[table]
    const keys = Object.keys(snapshot)

    return buckets.some((bucket) => {
      if (bucket.table !== table) {
        return false
      }
      if (keys.length === 0) {
        // Fail closed: leftover `{}` is table-scoped only when the table is known and unbucketed. Unknown tables and bucketed leftovers are withheld.
        return config !== undefined && !config.bucket_column
      }
      if (config === undefined) {
        return false
      }
      if (config.bucket_column && !(config.bucket_column in bucket.params)) {
        return false
      }
      // The bucket column alone: the snapshot carries nothing else, and a bucket's other params filter live rows only (D-tombstone-delivery).
      return snapshot[config.bucket_column] === bucket.params[config.bucket_column]
    })
  }

  private commitDelete(commit: TDeleteCommit): void {
    const { table, pk } = commit

    this.recordTombstone(commit)
    this.rows.get(table)?.delete(pk)
    this.changelog.delete(rowKey(table, pk))
    // Deletes are remove-wins (sticky tombstone): drop any per-column hlc, the row is gone and a later edit is rejected DELETE_WINS, never resurrected.
    this.columnHlc.delete(rowKey(table, pk))
  }

  /** The tombstone of the bucket value the row is leaving, captured before the row changes. A re-delete from the same value refreshes it. */
  private recordTombstone({ table, pk, seq, deletedAt, arrivedStep }: TDeleteCommit): void {
    const row = this.rows.get(table)?.get(pk)
    const bucket = (row === undefined ? null : this.bucketOf(table, row)) ?? ''

    this.tombstones.set(tombstoneKey(table, pk, bucket), {
      table,
      pk,
      bucket,
      seq,
      deleted_at: deletedAt,
      arrived_step: arrivedStep,
      snapshot: this.snapshotFor(table, pk),
    })
    this.maxCommittedSeq = maxBigint(this.maxCommittedSeq, seq)
  }

  /** The bucket label of `row`: its bucket column's value as text, null on an unbucketed table. */
  private bucketOf(table: string, row: TColumnValues): string | null {
    const column = this.tables[table]?.bucket_column

    return column ? bucketLabel(row[column]) : null
  }

  /**
   * A write that moves an existing row to another bucket value stamps the old
   * value's tombstone first, so it takes the lower seq (D-bucket-move-out). The
   * returned seq rides the write's commit; undefined when the write moves nothing.
   */
  private stampMoveOut(table: string, pk: string, columns: TColumnValues): bigint | undefined {
    const current = this.rows.get(table)?.get(pk)
    const column = this.tables[table]?.bucket_column

    if (current === undefined || !column || !(column in columns) || bucketLabel(columns[column]) === bucketLabel(current[column])) {
      return undefined
    }
    return this.stampSeq()
  }

  /**
   * The rejection a mutation of a deleted row gets, null when the row is not
   * deleted. A row counts as deleted when its latest change is a removal: its
   * newest tombstone is newer than its changelog entry. A move-out leaves a
   * tombstone followed by the write that moved the row, so a moved row is
   * decided like any other. A row this push deleted answers DELETE_WINS; a
   * committed removal answers DELETE_WINS only when the subject holds a grant
   * for the bucket value it removed the row from, RLS_DENIED otherwise
   * (D-tombstone-delivery).
   */
  private deletedRowReason(table: string, pk: string): TRejectReason | null {
    if (this.pushDeletes.has(rowKey(table, pk))) {
      return ERejectReason.DELETE_WINS
    }
    const upsertSeq = this.changelog.get(rowKey(table, pk))?.seq ?? 0n
    const newest = [...this.tombstones.values()]
      .filter((tombstone) => tombstone.table === table && tombstone.pk === pk)
      .reduce<TTombstoneRecord | null>((latest, tombstone) => (latest === null || tombstone.seq > latest.seq ? tombstone : latest), null)

    if (newest === null || newest.seq <= upsertSeq) {
      return null
    }
    return this.grants.has(grantKey(table, newest.bucket)) ? ERejectReason.DELETE_WINS : ERejectReason.RLS_DENIED
  }

  private reapTombstones(): void {
    // The tombstone reaper (SQL:tombstone-reaping): clear every tombstone recorded so far and raise the horizon to the highest reaped seq, from elided history (lifecycle/001 → reap_horizon 2n) or a mid-transcript step (lifecycle/006). In-flight deletes are not recorded yet, so they stay.
    for (const tombstone of this.tombstones.values()) {
      this.reapHorizon = maxBigint(this.reapHorizon, tombstone.seq)
    }
    this.tombstones = new Map()
  }

  // MARK: - Atomic batch snapshot/restore

  private snapshot(): TSnapshot {
    const rows = new Map<string, Map<string, TColumnValues>>()

    for (const [table, tableRows] of this.rows) {
      const copy = new Map<string, TColumnValues>()

      for (const [pk, columns] of tableRows) {
        copy.set(pk, { ...columns })
      }
      rows.set(table, copy)
    }
    // Deep-copy the per-column hlc inner records too (an intra-batch hlc-mode apply mutates them in place; a revert must not leak the stamp).
    const columnHlc = new Map<string, Record<string, string>>()

    for (const [key, stamps] of this.columnHlc) {
      columnHlc.set(key, { ...stamps })
    }
    return {
      rows,
      changelog: new Map(this.changelog),
      tombstones: new Map(this.tombstones),
      columnHlc,
      journal: this.journal.map((entry) => ({ ...entry })),
      verdicts: new Map(this.verdicts),
      nextSeq: this.nextSeq,
      maxCommittedSeq: this.maxCommittedSeq,
    }
  }

  private restore(s: TSnapshot): void {
    this.rows = s.rows
    this.changelog = s.changelog
    this.tombstones = s.tombstones
    this.columnHlc = s.columnHlc
    this.journal = s.journal
    this.verdicts = s.verdicts
    this.nextSeq = s.nextSeq
    this.maxCommittedSeq = s.maxCommittedSeq
  }

  private applyHistoryOp(op: THistoryOp): void {
    // History ops are the state elided before the transcript starts (lifecycle/001 context.notes): apply them at seed time with arrived_step 0.
    if (op.op === 'upsert') {
      const moveOutSeq = this.stampMoveOut(op.table, op.pk, op.columns)

      this.commitUpsert({ table: op.table, pk: op.pk, columns: op.columns, seq: this.stampSeq(), moveOutSeq, arrivedStep: 0 })

      return
    }
    if (op.op === 'delete') {
      this.commitDelete({
        table: op.table,
        pk: op.pk,
        seq: this.stampSeq(),
        deletedAt: stepTimestamp(0),
        arrivedStep: 0,
      })

      return
    }
    this.reapTombstones()
  }

  // MARK: - Pull internals: visibility

  private isRowDeliverable(table: string, row: TColumnValues, buckets: TBucket[]): boolean {
    // (a) a request bucket names this table and every one of its params equals the row's column (P:mutations-and-column-masked-conflict-resolution; owner-equality in every seed transcript)
    const inBucket = buckets.some(
      (bucket) => bucket.table === table && Object.entries(bucket.params).every(([column, value]) => row[column] === value)
    )

    if (!inBucket) {
      return false
    }
    // (b) caller-scoped RLS (P:cursor-monotonicity-rebase-and-atomic-checkpoints): push/002 step 9 withholds e1 once it moves to user-b, while the cursor still advances past seq 2.
    const config = this.tables[table]

    return config !== undefined && row[config.bucket_column] === this.userId
  }

  /**
   * Refined delivery (D-visibility-horizon): a COMMITTED seq is deliverable when
   * it sits above the high-water mark OR is one of the cursor's holes, a gap an
   * earlier page skipped that has since committed. Committed means present in the
   * changelog/tombstones (in-flight effects live in this.inflight, never here):
   * the pg_visible_in_snapshot analog. A flat cursor carries no holes, so the test
   * reduces to seq > highWater.
   */
  private refinedDeliverable(seq: bigint, token: TCursorToken): boolean {
    return seq > token.highWater || token.holes.includes(seq)
  }

  /**
   * The changelog entries a pull reads: every entry of a requested unbucketed
   * table, and on a bucketed table only the entries labeled with a requested
   * value (SQL:changelog-bucket-value). Each carries its row when the pull
   * delivers it and null when the page withholds it, which still counts against
   * the scan cap.
   */
  private collectRowCandidates(token: TCursorToken, buckets: TBucket[]): TCandidate[] {
    const out: TCandidate[] = []

    for (const [key, record] of this.changelog) {
      const separator = key.indexOf('/')
      const table = key.slice(0, separator)
      const pk = key.slice(separator + 1)
      const row = this.rows.get(table)?.get(pk)

      // REFINED horizon (D-visibility-horizon): seq > highWater OR seq ∈ holes.
      if (row === undefined || !this.isRequestedEntry(table, record.bucket, buckets) || !this.refinedDeliverable(record.seq, token)) {
        continue
      }
      out.push({ kind: 'row', seq: record.seq, table, pk, row: this.isRowDeliverable(table, row, buckets) ? row : null })
    }
    return out
  }

  private isRequestedEntry(table: string, bucket: string | null, buckets: TBucket[]): boolean {
    const column = this.tables[table]?.bucket_column

    return buckets.some((entry) => entry.table === table && (!column || (column in entry.params && bucketLabel(entry.params[column]) === bucket)))
  }

  private collectPendingTombstones(token: TCursorToken, buckets: TBucket[]): TCandidate[] {
    const out: TCandidate[] = []

    for (const record of this.tombstones.values()) {
      // Bucket-scoped: the stored snapshot's bucket value matches some request bucket (tombstones/001 same-owner; tombstones/003 cross-bucket), and the subject received a live row of that value (D-tombstone-delivery).
      if (!this.tombstoneMatchesBuckets(record.table, record.snapshot, buckets) || !this.grants.has(grantKey(record.table, record.bucket))) {
        continue
      }
      // REFINED horizon (D-visibility-horizon): a committed tombstone above the high-water mark OR a hole that has since committed (deletes join the same horizon space as upserts).
      if (this.refinedDeliverable(record.seq, token)) {
        const row = this.rows.get(record.table)?.get(record.pk)
        // A row still deliverable to the subject rides the stream as a row, and a client applies a page's rows before its tombstones, so its tombstone is withheld (D-tombstone-delivery).
        const withheld = row !== undefined && this.isRowDeliverable(record.table, row, buckets)

        out.push({ kind: 'tombstone', withheld, seq: record.seq, table: record.table, pk: record.pk, deleted_at: record.deleted_at })
      }
    }
    return out
  }

  /**
   * Refined response cursor (D-visibility-horizon). The new high-water is max(old
   * highWater, the max committed stamped seq): commit-visibility advances the mark
   * past committed seqs even when RLS withholds the row data (push/002 step 9). The
   * new holes are ALL in-flight seqs strictly below the new high-water, which is
   * exactly "in-flight seqs below the mark UNION old holes still in-flight MINUS
   * holes now delivered": a committed (delivered) hole has left the in-flight set, a
   * still-in-flight old hole is below the mark, and a newly in-flight lower seq is a
   * fresh gap. The codec encodes it, flat decimal when there are no holes. It is
   * a checkpoint token, so it never carries a start.
   */
  private refinedCursorToken(token: TCursorToken): TCursorToken {
    const highWater = maxBigint(token.highWater, this.maxCommittedSeq)
    const holes: bigint[] = []

    for (const effects of this.inflight.values()) {
      for (const effect of effects) {
        const seqs = effect.op === 'upsert' && effect.moveOutSeq !== undefined ? [effect.moveOutSeq, effect.seq] : [effect.seq]

        holes.push(...seqs.filter((seq) => seq < highWater))
      }
    }
    return { start: null, highWater, holes }
  }

  // MARK: - Pull internals: page assembly

  private finalPage(pendingRows: TPendingRow[], pendingTombstones: TPendingTombstone[], responseCursor: TCursorToken): TPullResponse {
    // has_more on the final page: the refined horizon (D-visibility-horizon) keeps the boundary OPEN while the cursor carries holes, the composite token encodes the pending gap, and the next pull resumes from it to pick the hole up once it commits (fencing/001-a step 3: cursor '6~5', has_more true). With no holes the token is the flat decimal and the boundary closes.
    const hasMore = responseCursor.holes.length > 0

    return this.withConflicts({
      cursor: encodeCursor(responseCursor),
      has_more: hasMore,
      rows: pendingRows.map(renderRow),
      signal: null,
      tombstones: pendingTombstones.map(renderTombstone),
    })
  }

  private journalOverwrites({ mutation, prior, applied, winnerSeq }: TJournaledWrite): void {
    if (prior === undefined || this.tables[mutation.table]?.conflict_journal !== true) {
      return
    }
    const mode = this.tables[mutation.table]?.conflict_mode === 'hlc' ? 'hlc' : 'arrival'

    for (const [column, value] of Object.entries(applied)) {
      if (!isJournaledOverwrite({ prior, column, value })) {
        continue
      }
      this.journal.push({
        table: mutation.table,
        pk: mutation.pk,
        column_name: column,
        loser_value: prior[column],
        winner_mutation_id: mutation.mutation_id,
        conflict_mode: mode,
        winner_seq: winnerSeq,
      })
    }
  }

  private withConflicts(page: TPullResponse): TPullResponse {
    const seqByRow = new Map(page.rows.map((row) => [`${row.table}/${row.pk}`, row.seq]))
    const conflicts: TConflict[] = this.journal
      .filter((entry) => seqByRow.get(`${entry.table}/${entry.pk}`) === String(entry.winner_seq))
      .map((entry) => ({
        column_name: entry.column_name,
        conflict_mode: entry.conflict_mode,
        loser_value: entry.loser_value,
        pk: entry.pk,
        table: entry.table,
        winner_mutation_id: entry.winner_mutation_id,
        winner_seq: String(entry.winner_seq),
      }))
      .sort(
        (a, b) =>
          compareUtf8(a.table, b.table) || compareUtf8(a.pk, b.pk) || compareUtf8(a.column_name, b.column_name),
      )

    if (conflicts.length === 0) {
      return page
    }
    return { conflicts, ...page }
  }

  private signalPage(cursor: string, type: TSignalType): TPullResponse {
    // Non-null signal rides an empty page, has_more false, cursor echoed (I-8, D-signal-excludes-page-data).
    return { cursor, has_more: false, rows: [], signal: { type }, tombstones: [] }
  }
}

// MARK: - Wire rendering

const renderRow = (item: TPendingRow): TRowChange => ({
  pk: item.pk,
  row: { ...item.row },
  seq: String(item.seq),
  table: item.table,
})

const renderTombstone = (item: TPendingTombstone): TTombstone => ({
  deleted_at: item.deleted_at,
  pk: item.pk,
  seq: String(item.seq),
  table: item.table,
})

const rejectedVerdict = (mutation: TMutation, reason: TRejectReason, serverRow: TColumnValues | null): TVerdict => ({
  mutation_id: mutation.mutation_id,
  reason,
  server_row: serverRow,
  verdict: EVerdictKind.rejected,
})

// MARK: - Factory

export const makeReferenceServer = (): IProtocolServer => new ReferenceServer()
