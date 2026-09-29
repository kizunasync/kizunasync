/**
 * PgReferenceServer: a live-Postgres IProtocolServer (conformance harness).
 *
 * A second IProtocolServer beside the in-memory reference in
 * protocol/executor/reference.ts; this one drives the LIVE kizunasync.pull /
 * kizunasync.push RPCs on real Postgres under a fresh isolated owner's RLS.
 * Replays the EXISTING golden corpus against the SQL bodies in
 * 0001_kizuna_init.sql (D-visibility-horizon fencing and the hlc skew clamp).
 *
 * THE IMPEDANCE MISMATCH (characterized, never hidden):
 *   The transcripts speak an ABSTRACT model: table `todos`, bucket column
 *   `owner_id`, fixed uuids (owner `…a1…`, pk `…e1…`). The live schema is
 *   public.todos with bucket column `user_id` (a real auth.users id) plus extra
 *   columns (id, image_path, updated_at, deleted_at, created_at). The global
 *   kizunasync._change_seq is already advanced by prior runs; live seqs are
 *   not the golden 1,2,3.
 *
 *   This server TRANSLATES, bijectively and value-preservingly:
 *     * request rewrite: owner_id→user_id, abstract owner uuid → the minted
 *       real auth.users id (per distinct abstract actor); applied to bucket
 *       params, mutation columns, preconditions.
 *     * response project: drop the live-only columns the transcript never
 *       declares, rename user_id→owner_id, substitute the real owner id back to
 *       the abstract one. The projected key set is the union of column keys
 *       the transcript itself uses for that table (like-for-like; no invented
 *       or dropped SEMANTIC field).
 *     * seq REBASE: every seq/cursor the live RPC emits is decimal-rebased by a
 *       per-transcript base (the _change_seq high-water captured at seed time)
 *       so the golden 1,2,3 line up. Rebasing is a PURE renumbering of an opaque,
 *       monotone token; it changes no ordering, no holes structure, no has_more.
 *
 *   Each of those three is a DECLARED, reported divergence axis, not a fudge.
 *     * history `reap`: the oracle expires every tombstone at once, the live
 *       reaper expires by wall clock. Seeded tombstones are aged past the
 *       configured TTL and kizunasync.reap_tombstones() runs for real. The
 *       horizon the pull gate reads is the one the SQL derived; only the
 *       deleted_at bytes (already a masked axis) are moved, and only for the pks
 *       this transcript seeded.
 *   This server does not touch hlc clamp ceilings or fabricate a reap
 *   horizon. Those surface as failures in the runner's taxonomy.
 *
 * UNSUPPORTED-BY-CONSTRUCTION (typed; the runner does not pass it):
 *   * held-txn / commitTxn (the supastash late-commit race): needs a second
 *     in-flight connection orchestrated against the puller's snapshot; a single
 *     synchronous replay cannot reproduce it. Throws PgUnsupportedError.
 *
 * Never resets / drops / truncates. Seeds rows under minted throwaway owners and
 * deletes exactly those rows (+ their changelog/tombstone/verdict/hlc/grant
 * trace) on cleanup, leaving the DB as found.
 */

import { SQL } from 'bun'
/**
 * Relative imports: @kizunasync/protocol is not a dependency of @kizunasync/supabase (only
 * @kizunasync/core is linked), and only a few subpaths are package-exported, so reach
 * the contract + wire types via the file tree directly. Adding a workspace dep +
 * reinstall is out of scope for a test harness.
 */
import type { IProtocolServer, TServerChange, TServerRowChange, TServerSeed } from '../../../protocol/executor/server-contract'
import type { TPullRequest, TPullResponse, TPushRequest, TPushResponse } from '../../../protocol/spec/wire-types'

// MARK: - Typed unsupported-by-construction signal

export class PgUnsupportedError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'PgUnsupportedError'
    this.reason = reason
  }
}

// MARK: - The abstract↔live binding

/**
 * Every seed transcript uses the abstract table `todos` with bucket column
 * `owner_id`. The corpus models strict owner-only RLS (a row a peer does not
 * own is invoker-invisible on read AND unwritable). Replay runs against a
 * DEDICATED strict owner-only table, public.corpus_todos, NOT the demo's
 * public.todos, whose `0002_example.sql` RLS is deliberately RELAXED (registered
 * users' rows are cross-readable for the demo's anonymous-todos product story).
 *
 * The pack enforces RLS only and imposes no ownership opinion of its own.
 * Authorization must be enforced by the FIXTURE's RLS: the replay table carries
 * the strict owner-equality policy the corpus assumes. push/002's server_row
 * null is then an RLS-invisibility outcome, not a pack opinion. The
 * demo's relaxed todos RLS is untouched; it is exercised by rpc-verdict /
 * example-shared-board, never by this corpus replay.
 */
const ABSTRACT_TABLE = 'todos'
const ABSTRACT_BUCKET = 'owner_id'
const LIVE_TABLE = 'corpus_todos'
const LIVE_BUCKET = 'user_id'

/** The abstract table name the corpus speaks ↔ the live strict replay table. */
const toLive = (table: string): string => (table === ABSTRACT_TABLE ? LIVE_TABLE : table)
const toAbstract = (table: string): string => (table === LIVE_TABLE ? ABSTRACT_TABLE : table)

type TJson = Record<string, unknown>
const isObject = (v: unknown): v is TJson =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// MARK: - PgReferenceServer

export class PgReferenceServer implements IProtocolServer {
  private readonly db: SQL

  /**
   * One reserved-connection pool per transcript, avoiding Postgres
   * reserved-slot exhaustion from opening a fresh connection on every RPC
   * across the expanded increment/array/conflict corpus.
   */
  private readonly ownerPool: SQL

  // abstract actor uuid (…a1…/…a2…) → minted real auth.users id
  private readonly owners = new Map<string, string>()
  private seededPks = new Set<string>()
  private mintedUsers = new Set<string>()
  private step = 0
  private userId = '' // the transcript's primary owner (abstract)
  private minSchemaVersion = 1
  private conflictMode: 'arrival' | 'hlc' = 'arrival'

  /**
   * The global kizunasync._change_seq high-water captured at seed time, BEFORE
   * this transcript writes any row or tombstone of its own. The runner rebases the
   * bootstrap request cursor "0" to this base, so a fresh owner's pull starts ABOVE
   * every seq an earlier run left behind. Bucketed tombstones with a stored snapshot
   * are scoped like live rows, while leftover `{}` snapshots and changelog seqs can
   * still leak on a literal "0". Rebasing "0"→seedBase isolates this transcript's
   * universe WITHOUT touching _pull_impl, the migrations, or the corpus, on the same
   * seq-rebase axis already declared for OUTPUT tokens.
   */
  private seedBase = '0'

  /** Live seq per elided-history op, in order (see `historyCursors`). */
  private historySeqs: string[] = []

  /**
   * Union of column keys the transcript declares for the abstract table: the
   * projection target for response rows (so we compare like-for-like).
   */
  private declaredColumns = new Set<string>([ABSTRACT_BUCKET])

  constructor(db: SQL, url: string) {
    this.db = db
    this.ownerPool = new SQL(url, { max: 1 })
  }

  // MARK: - Pre-seed analysis

  /**
   * Register the union of column keys the transcript uses for the abstract
   * table, so response rows project to exactly that set.
   */
  declareColumns(keys: Iterable<string>): void {
    for (const k of keys) {
      this.declaredColumns.add(k)
    }
  }

  /**
   * Pre-clear the transcript's fixed abstract pks (…e1…/…e2…) before seeding.
   * These ids are HARNESS artifacts written verbatim into public.todos.id; they
   * are shared across transcripts and across runs, so a run that crashed earlier
   * can leave a stale row/changelog/tombstone behind that would contaminate this
   * transcript (e.g. ON CONFLICT merging onto stale columns). Clearing them is
   * safe (they are never real user data) and restores the per-transcript isolation
   * the oracle gets for free from its empty in-memory start.
   */
  async preclearPks(pks: Iterable<string>): Promise<void> {
    const list = [...new Set(pks)]

    if (list.length === 0) {
      return
    }
    const inList = list.map((_, i) => `$${i + 1}`).join(', ')

    await this.db.unsafe(`delete from public.${LIVE_TABLE} where id::text in (${inList})`, list)
    await this.db`delete from kizunasync._changelog where pk::text in ${this.db(list)}`
    await this.db`delete from kizunasync._tombstones where pk::text in ${this.db(list)}`
    await this.db`delete from kizunasync._row_hlc where pk::text in ${this.db(list)}`
  }

  // MARK: - IProtocolServer: seed

  /**
   * The seed-time _change_seq high-water (see `seedBase`). The runner reads this
   * to resolve the bootstrap request cursor "0" to a base ABOVE all leaked
   * earlier seqs, isolating this transcript's tombstone universe.
   */
  get bootstrapBase(): string {
    return this.seedBase
  }

  /**
   * The live seq each elided-history op minted, in transcript order. The oracle
   * numbers that history densely (1, 2, 3, with `reap` consuming none), so the
   * runner maps a golden request cursor pointing INTO the history onto the live
   * token at the same position. Without it a request cursor the transcript never
   * saw in a response resolves to "0" and skips the horizon it is testing.
   */
  get historyCursors(): readonly string[] {
    return this.historySeqs
  }

  async seedAsync(seed: TServerSeed): Promise<void> {
    this.userId = seed.user_id
    this.minSchemaVersion = seed.min_schema_version

    // Capture the global sequence high-water BEFORE this transcript writes any of its own rows/tombstones. The runner rebases bootstrap "0" to a base that sits above every prior-run seq but below every seq this transcript will mint. currval is unavailable until nextval runs in this session; read the sequence relation's last_value directly (works even if it has not been called this session). is_called is load-bearing: on a sequence nextval has never touched, last_value is the value it is ABOUT to hand out, not one already handed out. An unadjusted base sits one seq above the transcript's first row and hides it.
    const [seq] = await this.db<{ base: string }[]>`
      select (case when is_called then last_value else last_value - 1 end)::text as base
      from kizunasync._change_seq`

    this.seedBase = seq?.base ?? '0'
    const table = seed.tables[ABSTRACT_TABLE]

    this.conflictMode = table?.conflict_mode === 'hlc' ? 'hlc' : 'arrival'
    this.conflictJournal = table?.conflict_journal === true

    // Point the live _config at the transcript's declared server block so the RESET_REQUIRED and hlc gates fire where the oracle's do. Cleanup restores the captured values.
    await this.captureAndSetConfig(seed)

    // Mint the primary owner up front (others mint lazily as actors appear).
    await this.ownerFor(seed.user_id)

    for (const op of seed.history) {
      if (op.op === 'reap') {
        await this.reapSeededTombstones()
        continue
      }
      if (op.op === 'upsert') {
        await this.privilegedUpsert(op.pk, op.columns)
        this.historySeqs.push(await this.changelogSeq(op.pk))
      } else {
        await this.privilegedDelete(op.pk)
        this.historySeqs.push(await this.tombstoneSeq(op.pk))
      }
    }
  }

  /**
   * Sync IProtocolServer.seed is unusable (the live work is async); the runner
   * calls seedAsync. This throws so a mis-wire is loud.
   */
  seed(_seed: TServerSeed): void {
    throw new PgUnsupportedError('PgReferenceServer.seed is async: call seedAsync')
  }

  setStep(n: number): void {
    this.step = n
  }

  /**
   * The oracle's applyServerChange bypasses RLS entirely (it is another actor's
   * committed write, set up out of band). Reproduced with a privileged
   * (RLS-bypassing) write to public.todos as the owning role.
   */
  // MARK: - IProtocolServer: out-of-band server change

  async applyServerChangeAsync(change: TServerChange): Promise<void> {
    // A reap change names no row: the same aging and real reaper as a history `reap` (lifecycle/006).
    if (change.op === 'reap') {
      await this.reapSeededTombstones()

      return
    }
    if (change.txn !== undefined) {
      throw new PgUnsupportedError(
        'held-txn server change (the supastash late-commit race) needs a second in-flight connection orchestrated against the puller snapshot: not reproducible in synchronous single-connection replay (fencing/001)',
      )
    }
    if (change.op === 'delete') {
      await this.privilegedDelete(change.pk)

      return
    }
    await this.privilegedUpsert(change.pk, change.columns ?? {}, change.hlc)
  }

  applyServerChange(_change: TServerChange): void {
    throw new PgUnsupportedError('applyServerChange is async: call applyServerChangeAsync')
  }

  /** The reap change `applyServerChangeAsync` takes, as its own call. */
  async reapAsync(): Promise<void> {
    await this.applyServerChangeAsync({ op: 'reap' })
  }

  commitTxn(_txn: string): void {
    throw new PgUnsupportedError('commitTxn (held-txn race) is unsupported in single-connection replay')
  }

  // MARK: - IProtocolServer: pull / push

  /**
   * The cursor is OPAQUE and replayed verbatim by a real client. The golden
   * request cursor (dense "0"/"1"/"2") is meaningless to the live DB, whose
   * cursors track the global sequence. The RUNNER owns the golden↔live cursor
   * map (it sees both golden request and golden response cursors, and honors
   * hold-back: the client re-pulls from a PRIOR cursor, not the latest) and
   * passes the resolved live cursor here. The returned live response cursor
   * flows back to the runner to extend that map.
   */
  async pullAsync(request: TPullRequest, liveCursor: string): Promise<{ response: TPullResponse; liveCursor: string }> {
    const buckets = request.buckets.map((b) => ({
      table: toLive(b.table),
      params: this.rewriteParams(b.params as TJson),
    }))
    const limit = (request as { limit?: number }).limit ?? 500
    const resp = await this.asOwner(this.userId, async (w) => {
      const [r] = await w<{ resp: TJson }[]>`
        select kizunasync.pull(${buckets}::jsonb, ${liveCursor}, ${request.schema_version}, ${limit}) as resp`

      return r.resp
    })

    return { response: this.normalizePull(resp), liveCursor: String(resp.cursor) }
  }

  pull(_request: TPullRequest): TPullResponse {
    throw new PgUnsupportedError('pull is async: call pullAsync')
  }

  async pushAsync(request: TPushRequest): Promise<TPushResponse> {
    const batch = {
      atomic: request.batch.atomic,
      mutations: request.batch.mutations.map((m) => this.rewriteMutation(m as unknown as TJson)),
    }
    const lastMutationId = request.last_mutation_id ?? null
    const resp = await this.asOwner(this.userId, async (w) => {
      const [r] = await w<{ resp: TJson }[]>`
        select kizunasync.push(${batch}::jsonb, ${lastMutationId}::uuid, ${request.schema_version}) as resp`

      return r.resp
    })

    return this.normalizePush(resp)
  }

  push(_request: TPushRequest): TPushResponse {
    throw new PgUnsupportedError('push is async: call pushAsync')
  }

  // MARK: - Cleanup

  async cleanup(): Promise<void> {
    try {
      // Bun's tagged SQL expands a JS array via the `db(arr)` helper into a parenthesized value list for `IN`; a bare `= any(${arr})` mis-serializes to comma text (malformed array literal). Guard the empty case (IN () is a syntax error) explicitly.
      const pks = [...this.seededPks]

      if (pks.length > 0) {
        const inList = pks.map((_, i) => `$${i + 1}`).join(', ')

        await this.db.unsafe(`delete from public.${LIVE_TABLE} where id::text in (${inList})`, pks)
        await this.db`delete from kizunasync._changelog where pk::text in ${this.db(pks)}`
        await this.db`delete from kizunasync._tombstones where pk::text in ${this.db(pks)}`
        await this.db`delete from kizunasync._row_hlc where pk::text in ${this.db(pks)}`
        await this.db`delete from kizunasync._conflict_journal where pk::text in ${this.db(pks)}`
      }
      // The verdict table is keyed by mutation_id, not pk, so drop those rows by the ids this run wrote.
      for (const id of this.writtenMutationIds) {
        await this.db`delete from kizunasync._verdicts where mutation_id = ${id}::uuid`
      }
      const users = [...this.mintedUsers]

      if (users.length > 0) {
        await this.db`delete from kizunasync._clients where user_id::text in ${this.db(users)}`
        await this.db`delete from kizunasync._bucket_grants where user_id::text in ${this.db(users)}`
        await this.db`delete from auth.users where id::text in ${this.db(users)}`
      }
      await this.restoreConfig()
    } finally {
      await this.ownerPool.end()
    }
  }

  // MARK: - Owner minting + privileged setup

  private async ownerFor(abstractId: string): Promise<string> {
    const existing = this.owners.get(abstractId)

    if (existing !== undefined) {
      return existing
    }
    // REGISTERED (is_anonymous=false), NOT a guest. The transcript model assumes the protocol's strict owner-only RLS (owner-equality). The demo's relaxed RLS lets ANYONE edit a GUEST-owned (is_anonymous=true) todo: which would collapse the cross-owner RLS_DENIED of push/002 into an applied verdict. A registered owner keeps the strict boundary the oracle models.
    const [u] = await this.db<{ id: string }[]>`
      insert into auth.users (id, is_anonymous) values (gen_random_uuid(), false) returning id`

    this.owners.set(abstractId, u.id)
    this.mintedUsers.add(u.id)

    return u.id
  }

  /**
   * Privileged (RLS-bypassing, runs as the connection's superuser role) upsert of
   * a corpus_todos row, column-rewritten. Mirrors the oracle's applyServerChange
   * which bypasses RLS. Goes through normal DML so the live triggers stamp _changelog.
   */
  private async privilegedUpsert(pk: string, columns: TServerRowChange['columns'], hlc?: string): Promise<void> {
    const cols = await this.rewriteColumns((columns ?? {}) as TJson)

    this.seededPks.add(pk)
    const keys = Object.keys(cols)
    // Branch on existence (NOT a blind ON CONFLICT): a column-MASKED upsert of an EXISTING row must touch only the masked columns and leave the rest. With ON CONFLICT the synthesized INSERT tuple sets the unmasked NOT-NULL columns (e.g. title) to NULL and Postgres rejects that tuple BEFORE conflict arbitration. So: UPDATE the masked columns when the row exists, INSERT otherwise: exactly the oracle's { ...current, ...columns } merge.
    const exists = (await this.db.unsafe(
      `select count(*)::int as n from public.${LIVE_TABLE} where id = $1::uuid`,
      [pk],
    )) as { n: number }[]

    if (exists[0]!.n > 0 && keys.length > 0) {
      const setList = keys.map((k, i) => `${quoteIdent(k)} = $${i + 2}`).join(', ')

      await this.db.unsafe(
        `update public.${LIVE_TABLE} set ${setList} where id = $1`,
        [pk, ...keys.map((k) => bindPgParam(cols[k]))],
      )
    } else if (exists[0]!.n === 0) {
      const merged = { id: pk, ...cols }
      const insertCols = ['id', ...keys].map(quoteIdent).join(', ')
      const selectVals = ['id', ...keys].map((k) => `r.${quoteIdent(k)}`).join(', ')

      // Pass the merged record as a JS object: Bun binds it as json, so `$1` is a real jsonb (not a double-encoded string); omitted columns keep table defaults.
      await this.db.unsafe(
        `insert into public.${LIVE_TABLE} (${insertCols}) select ${selectVals} from jsonb_populate_record(null::public.${LIVE_TABLE}, $1) r`,
        [merged],
      )
    }
    // hlc-mode: stamp the per-column high-water so a later push compares against it, exactly as the SQL apply path would have for an owner-side write.
    if (hlc !== undefined && this.conflictMode === 'hlc') {
      const stamps: TJson = {}

      for (const k of keys) {
        stamps[k] = hlc
      }
      await this.db`
        insert into kizunasync._row_hlc (table_name, pk, column_hlc)
        values (${LIVE_TABLE}, ${pk}::uuid, ${stamps}::jsonb)
        on conflict (table_name, pk) do update
          set column_hlc = kizunasync._row_hlc.column_hlc || excluded.column_hlc`
    }
  }

  private async privilegedDelete(pk: string): Promise<void> {
    this.seededPks.add(pk)
    await this.db.unsafe(`delete from public.${LIVE_TABLE} where id = $1::uuid`, [pk])
    await this.db`delete from kizunasync._row_hlc where table_name = ${LIVE_TABLE} and pk = ${pk}::uuid`
  }

  /** The seq the change-capture trigger minted for the last write of `pk`. */
  private async changelogSeq(pk: string): Promise<string> {
    const [row] = await this.db<{ seq: string }[]>`
      select max(seq)::text as seq from kizunasync._changelog
       where table_name = ${LIVE_TABLE} and pk = ${pk}::uuid`

    return row?.seq ?? this.seedBase
  }

  /** The seq the tombstone trigger minted for the delete of `pk`. */
  private async tombstoneSeq(pk: string): Promise<string> {
    const [row] = await this.db<{ seq: string }[]>`
      select seq::text as seq from kizunasync._tombstones
       where table_name = ${LIVE_TABLE} and pk = ${pk}::uuid`

    return row?.seq ?? this.seedBase
  }

  /**
   * The oracle's history `reap` clears every tombstone it holds and remembers the
   * horizon. The live reaper expires by wall clock. Age THIS transcript's
   * tombstones past the configured TTL and then run the real
   * kizunasync.reap_tombstones(): the horizon the pull gate reads is the one the
   * SQL derived, not a value the harness wrote. Only the transcript's own pks
   * are aged; a tombstone belonging to anything else stays where it is.
   */
  private async reapSeededTombstones(): Promise<void> {
    const pks = [...this.seededPks]

    if (pks.length === 0) {
      return
    }
    // The effective TTL is the reaper's own rule: the table's own value, the project default when it declares none.
    await this.db`
      update kizunasync._tombstones t
         set deleted_at = now() - make_interval(days => 1 + coalesce(
           (select c.tombstone_ttl_days from kizunasync._config c where c.table_name = t.table_name),
           (select s.tombstone_ttl_days from kizunasync._settings s)
         ))
       where t.pk::text in ${this.db(pks)}`
    await this.db`select kizunasync.reap_tombstones()`

    // A reap raises the floor any cursor can still reach, so the bootstrap rebase moves with it: the oracle's re-hydration cursor "0" sits below every retained tombstone, and a base under the new horizon would make the live gate answer that pull with the CHECKPOINT_EXPIRED signal the preceding step already delivered. The history cursors keep their own live tokens, so the expiry step still tests a cursor below the horizon.
    const [state] = await this.db<{ reaped_seq: string }[]>`
      select reaped_seq::text as reaped_seq from kizunasync._reap_state where id`
    const horizon = state?.reaped_seq ?? '0'

    if (BigInt(horizon) > BigInt(this.seedBase)) {
      this.seedBase = horizon
    }
  }

  // MARK: - Run a closure under an abstract owner's RLS on a reserved connection

  /**
   * Runs `fn` under the abstract owner's RLS, wrapped in ONE explicit transaction
   * on a reserved connection. The transaction is load-bearing for determinism:
   * pinConfig re-asserts this transcript's declared _config (taking the row
   * lock on the SHARED global row) ATOMICALLY with the RPC. No concurrent
   * writer can flip conflict_mode between the pin and the RPC's read of it. The
   * jwt.claims + role GUCs are transaction-local (is_local=true): they persist
   * across statements within this single txn (auth.uid() is non-NULL for the
   * RPC) and auto-reset at commit, leaving the pooled connection clean.
   */
  private async asOwner<T>(abstractOwner: string, fn: (w: SQL) => Promise<T>): Promise<T> {
    const ownerId = await this.ownerFor(abstractOwner)
    const w = await this.ownerPool.reserve()

    try {
      const claims = JSON.stringify({ sub: ownerId, role: 'authenticated' })

      await w`begin`

      try {
        // Pin this transcript's _config first (before dropping to `authenticated`) inside the txn: the row lock serializes any concurrent flip of config.
        await this.pinConfig(w)
        await w`select set_config('request.jwt.claims', ${claims}, true)`
        await w`set local role authenticated`
        const out = await fn(w)

        await w`commit`

        return out
      } catch (error) {
        await w`rollback`.catch(() => {})

        throw error
      }
    } finally {
      await w.release()
    }
  }

  // MARK: - Config capture / set / restore

  private configBefore: TJson | null = null

  /** `_settings.max_pull_scan` before a transcript that declares a scan cap pinned its own, restored at cleanup. */
  private maxPullScanBefore: number | null = null

  /** The scan cap the transcript declares (`context.server.max_pull_scan`), null when it leaves the database's own. */
  private declaredMaxPullScan: number | null = null

  /**
   * The exact _config the transcript declares for the abstract table. Recorded at
   * seed time and RE-PINNED in the same transaction as every push/pull RPC (see
   * pinConfig). The value the live RPC reads is ALWAYS this transcript's
   * declared mode, immune to a concurrent writer (a parallel test file, another
   * transcript, or residue from a crashed run) flipping the SHARED global
   * _config.<table> row between this transcript's seed and its push step. Without
   * the per-RPC re-pin, an arrival transcript whose push runs while the row sits
   * at 'hlc' routes through _apply_hlc with a NULL hlc and raises (fail-loud; @../../../../CONVENTIONS.md),
   * FLAKILY diverging conflict/001 et al.
   */
  private declaredConfig: {
    min_schema_version: number
    conflict_mode: 'arrival' | 'hlc'
    conflict_journal: boolean
    tombstone_ttl_days: number
  } = {
    min_schema_version: 1,
    conflict_mode: 'arrival',
    conflict_journal: false,
    tombstone_ttl_days: 30,
  }

  private conflictJournal = false
  private async captureAndSetConfig(seed: TServerSeed): Promise<void> {
    const [row] = await this.db<TJson[]>`
      select min_schema_version, conflict_mode, conflict_journal, tombstone_ttl_days
      from kizunasync._config where table_name = ${LIVE_TABLE}`

    this.configBefore = row ?? null
    this.declaredConfig = {
      min_schema_version: seed.min_schema_version,
      conflict_mode: this.conflictMode,
      conflict_journal: this.conflictJournal,
      tombstone_ttl_days: seed.tombstone_ttl_days,
    }
    await this.db`
      update kizunasync._config
         set min_schema_version = ${seed.min_schema_version},
             conflict_mode = ${this.conflictMode},
             conflict_journal = ${this.conflictJournal},
             tombstone_ttl_days = ${seed.tombstone_ttl_days}
       where table_name = ${LIVE_TABLE}`

    if (seed.max_pull_scan !== undefined) {
      const [settings] = await this.db<{ max_pull_scan: number }[]>`select max_pull_scan from kizunasync._settings`

      this.maxPullScanBefore = settings?.max_pull_scan ?? null
      this.declaredMaxPullScan = seed.max_pull_scan
    }
  }

  /**
   * Re-assert this transcript's declared _config on the reserved RPC connection `w`
   * INSIDE the RPC transaction (asOwner wraps this UPDATE + the push/pull call in
   * one BEGIN/COMMIT). The UPDATE's row lock on the SHARED _config.<table> row
   * serializes any concurrent flip; the RPC reads exactly the declared mode.
   * Per-transcript determinism: each transcript pins its own config atomically
   * with its RPC, immune to global residue and leaving none beyond the seed-time
   * set that cleanup restores.
   */
  private async pinConfig(w: SQL): Promise<void> {
    await w`
      update kizunasync._config
         set min_schema_version = ${this.declaredConfig.min_schema_version},
             conflict_mode = ${this.declaredConfig.conflict_mode},
             conflict_journal = ${this.declaredConfig.conflict_journal},
             tombstone_ttl_days = ${this.declaredConfig.tombstone_ttl_days}
       where table_name = ${LIVE_TABLE}`

    if (this.declaredMaxPullScan !== null) {
      await w`update kizunasync._settings set max_pull_scan = ${this.declaredMaxPullScan}`
    }
  }

  private async restoreConfig(): Promise<void> {
    if (this.maxPullScanBefore !== null) {
      await this.db`update kizunasync._settings set max_pull_scan = ${this.maxPullScanBefore}`
    }
    if (this.configBefore === null) {
      return
    }
    await this.db`
      update kizunasync._config
         set min_schema_version = ${this.configBefore.min_schema_version as number},
             conflict_mode = ${this.configBefore.conflict_mode as string},
             conflict_journal = ${this.configBefore.conflict_journal as boolean},
             tombstone_ttl_days = ${this.configBefore.tombstone_ttl_days as number}
       where table_name = ${LIVE_TABLE}`
  }

  // MARK: - Request rewrites

  private rewriteParams(params: TJson): TJson {
    const out: TJson = {}

    for (const [k, v] of Object.entries(params)) {
      if (k === ABSTRACT_BUCKET) {
        out[LIVE_BUCKET] = this.owners.get(v as string) ?? v
      } else {
        out[k] = v
      }
    }
    return out
  }

  private async rewriteColumns(columns: TJson): Promise<TJson> {
    const out: TJson = {}

    for (const [k, v] of Object.entries(columns)) {
      if (k === ABSTRACT_BUCKET) {
        out[LIVE_BUCKET] = await this.ownerFor(v as string)
      } else {
        out[k] = v
      }
    }
    return out
  }

  private readonly writtenMutationIds = new Set<string>()
  private rewriteMutation(m: TJson): TJson {
    const out: TJson = { ...m }

    if (typeof m.table === 'string') {
      out.table = toLive(m.table)
    }
    if (typeof m.mutation_id === 'string') {
      this.writtenMutationIds.add(m.mutation_id)
    }
    // A pushed mutation's pk is part of this transcript's universe: track it so the owner-scoping filter keeps it on the follow-up pull AND cleanup removes it.
    if (typeof m.pk === 'string') {
      this.seededPks.add(m.pk)
    }
    if (isObject(m.columns)) {
      out.columns = this.rewriteColumnsSync(m.columns)
    }
    if (isObject(m.precondition)) {
      out.precondition = this.rewriteColumnsSync(m.precondition)
    }
    return out
  }

  /**
   * Sync column rewrite for mutations: owner ids must already be minted (they are
   * every actor that owns a pushed row is the primary owner, minted at seed).
   */
  private rewriteColumnsSync(columns: TJson): TJson {
    const out: TJson = {}

    for (const [k, v] of Object.entries(columns)) {
      if (k === ABSTRACT_BUCKET) {
        const live = this.owners.get(v as string)

        if (live === undefined) {
          throw new PgUnsupportedError(`mutation references un-minted owner ${String(v)} (insert under a never-seeded actor)`)
        }
        out[LIVE_BUCKET] = live
      } else {
        out[k] = v
      }
    }
    return out
  }

  // MARK: - Response normalization

  private normalizePull(resp: TJson): TPullResponse {
    // Scope to THIS transcript's universe: the oracle starts from an empty server and reasons only about the pks it seeded. The live DB cannot be emptied (no reset), so pre-existing `todos` rows/tombstones from prior runs leak in: unbucketed or empty-snapshot tombstones especially. Restricting the compared set to seeded pks is the faithful scoping: we keep ALL seeded pks (a dropped seeded row would still surface as a divergence), we only drop pks the transcript never mentions. This is a DECLARED divergence axis, not a fudge: see the harness report (tombstone owner-scoping).
    const mine = (pk: unknown): boolean => this.seededPks.has(String(pk))
    const rows = (Array.isArray(resp.rows) ? resp.rows : [])
      .filter((r) => mine((r as TJson).pk))
      .map((r) => this.projectRow(r as TJson))
    const tombstones = (Array.isArray(resp.tombstones) ? resp.tombstones : [])
      .filter((t) => mine((t as TJson).pk))
      .map((t) => this.projectTombstone(t as TJson))
    const conflicts = Array.isArray(resp.conflicts)
      ? resp.conflicts
          .filter((c) => mine((c as TJson).pk))
          .map((c) => this.projectConflict(c as TJson))
      : []
    const page: TJson = {
      cursor: String(resp.cursor),
      has_more: Boolean(resp.has_more),
      rows,
      signal: resp.signal === null || resp.signal === undefined ? null : (resp.signal as TPullResponse['signal']),
      tombstones,
    }

    if (conflicts.length > 0) {
      page.conflicts = conflicts
    }
    return page as TPullResponse
  }

  private normalizePush(resp: TJson): TPushResponse {
    if (isObject(resp.batch)) {
      // Atomic abort shape: project server_row if present.
      const batch = resp.batch as TJson

      if (isObject(batch.server_row)) {
        batch.server_row = this.projectRowColumns(batch.server_row)
      }
      return { batch } as unknown as TPushResponse
    }
    const verdicts = Array.isArray(resp.verdicts) ? resp.verdicts : []

    return {
      verdicts: verdicts.map((v) => {
        const out = { ...(v as TJson) }

        if (isObject(out.server_row)) {
          out.server_row = this.projectRowColumns(out.server_row)
        }
        return out
      }),
    } as unknown as TPushResponse
  }

  private projectRow(r: TJson): TJson {
    return {
      pk: r.pk,
      row: this.projectRowColumns(r.row as TJson),
      seq: String(r.seq), // raw live seq: runner rank-normalizes
      table: toAbstract(String(r.table)),
    }
  }

  private projectTombstone(t: TJson): TJson {
    return {
      deleted_at: t.deleted_at, // raw wall-clock timestamp: the runner replaces it with a placeholder
      pk: t.pk,
      seq: String(t.seq),
      table: toAbstract(String(t.table)),
    }
  }

  private projectConflict(c: TJson): TJson {
    const projected: TJson = {
      column_name: c.column_name,
      conflict_mode: c.conflict_mode,
      loser_value: c.loser_value,
      pk: c.pk,
      table: toAbstract(String(c.table)),
      winner_mutation_id: c.winner_mutation_id,
    }

    // Carried, not dropped: the runner masks it like any other seq, so the corpus compares its presence and its join to the delivered page. A server that does not send it leaves the key out here too and diverges by absence, which is what a database still running an older pack should look like.
    if (c.winner_seq !== undefined && c.winner_seq !== null) {
      projected.winner_seq = String(c.winner_seq)
    }
    return projected
  }

  /**
   * Project a live row jsonb back to the abstract model: keep only the keys the
   * transcript declares (plus the renamed bucket), rename user_id→owner_id, and
   * substitute the real owner id back to its abstract uuid.
   */
  private projectRowColumns(row: TJson): TJson {
    const reverseOwners = new Map<string, string>()

    for (const [abstract, real] of this.owners) {
      reverseOwners.set(real, abstract)
    }
    const out: TJson = {}

    for (const [k, v] of Object.entries(row)) {
      const abstractKey = k === LIVE_BUCKET ? ABSTRACT_BUCKET : k

      if (!this.declaredColumns.has(abstractKey)) {
        continue // drop live-only columns
      }
      out[abstractKey] = abstractKey === ABSTRACT_BUCKET ? (reverseOwners.get(v as string) ?? v) : v
    }
    return out
  }

}

// MARK: - Connection URL

export const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'

// MARK: - Strict owner-only replay fixture

/** The reap watermark captured by ensureCorpusFixture, restored by dropCorpusFixture. */
let reapStateBefore: { reaped_seq: string; reaped_at: string | null } | null = null

/**
 * The corpus models strict owner-only RLS. The replay table carries
 * exactly that: owner-equality on read AND write. A HARNESS fixture, not a
 * shipped migration: the pack imposes no ownership opinion; the app's RLS does.
 * The fixture is the app RLS the corpus assumes. Idempotent create so a re-run
 * (or a crashed prior run) is safe; the config row + change-capture triggers
 * make it a synced table the live pull/push exercise exactly like any real table.
 */
export async function ensureCorpusFixture(db: SQL): Promise<void> {
  // A `reap` case runs the real kizunasync.reap_tombstones(), which raises `reaped_seq` to a fixture tombstone's seq, and dropping the fixture then deletes the rows that justified that floor: every later cursor below it would answer CHECKPOINT_EXPIRED on a database the suite has already used. Snapshot the watermark here and restore it in dropCorpusFixture so the reap stays inside the suite.
  const [state] = await db<{ reaped_seq: string; reaped_at: string | null }[]>`
    select reaped_seq::text as reaped_seq, reaped_at from kizunasync._reap_state where id`

  reapStateBefore = state ?? null
  await db.unsafe(`
    create table if not exists public.${LIVE_TABLE} (
      id uuid primary key,
      ${LIVE_BUCKET} uuid not null,
      title text,
      done boolean,
      likes integer not null default 0,
      version integer not null default 0,
      labels text[] not null default '{}'
    );
    alter table public.${LIVE_TABLE} add column if not exists likes integer not null default 0;
    alter table public.${LIVE_TABLE} add column if not exists version integer not null default 0;
    alter table public.${LIVE_TABLE} add column if not exists labels text[] not null default '{}';
    alter table public.${LIVE_TABLE} enable row level security;
    grant select, insert, update, delete on public.${LIVE_TABLE} to authenticated;
    drop policy if exists corpus_owner_only on public.${LIVE_TABLE};
    create policy corpus_owner_only on public.${LIVE_TABLE} for all to authenticated
      using (${LIVE_BUCKET} = (select auth.uid())) with check (${LIVE_BUCKET} = (select auth.uid()));
    drop trigger if exists kizunasync_track_change on public.${LIVE_TABLE};
    drop trigger if exists kizunasync_track_delete on public.${LIVE_TABLE};
    create trigger kizunasync_track_change after insert or update on public.${LIVE_TABLE}
      for each row execute function kizunasync.track_change();
    create trigger kizunasync_track_delete after delete on public.${LIVE_TABLE}
      for each row execute function kizunasync.track_delete();
  `)
  await db`
    insert into kizunasync._config (table_name, sync_mode, bucket_column, conflict_mode, min_schema_version, register_clients)
    values (${LIVE_TABLE}, 'read-write', ${LIVE_BUCKET}, 'arrival', 1, false)
    on conflict (table_name) do update set sync_mode = 'read-write', bucket_column = excluded.bucket_column`
}

/** Drops the replay fixture table, the kizunasync rows that reference it, and restores the reap watermark. */
export async function dropCorpusFixture(db: SQL): Promise<void> {
  await db.unsafe(`drop table if exists public.${LIVE_TABLE} cascade`)
  await db`delete from kizunasync._changelog where table_name = ${LIVE_TABLE}`
  await db`delete from kizunasync._tombstones where table_name = ${LIVE_TABLE}`
  await db`delete from kizunasync._row_hlc where table_name = ${LIVE_TABLE}`
  await db`delete from kizunasync._bucket_grants where table_name = ${LIVE_TABLE}`
  await db`delete from kizunasync._config where table_name = ${LIVE_TABLE}`

  if (reapStateBefore !== null) {
    await db`
      update kizunasync._reap_state
         set reaped_seq = ${reapStateBefore.reaped_seq}::bigint,
             reaped_at = ${reapStateBefore.reaped_at}
       where id`
  }
}

// MARK: - Minimal SQL ident quoting

const quoteIdent = (id: string): string => `"${id.replace(/"/g, '""')}"`

/**
 * Bun binds a JS array as a JSON scalar. Postgres `text[]` then sees the first
 * element as an array literal (`home`) and raises 22P02. Encode arrays in the
 * Postgres text form `{a,b}` so privileged server upserts of labels work.
 */
const bindPgParam = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value
  }
  const encode = (el: unknown): string => {
    const s = String(el)

    if (s === '' || /[",{}\\\s]/.test(s)) {
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return s
  }
  return `{${value.map(encode).join(',')}}`
}
