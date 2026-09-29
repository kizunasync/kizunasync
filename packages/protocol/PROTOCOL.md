# The Oracle Protocol

This document is the prose index for the machine-readable row-sync contract in `packages/protocol`. JSON Schemas define message shapes, the manifest selects golden transcripts, the decision index records disposition, and the SQL pack migration defines the deployed database behavior.

Kizuna exposes five authenticated SQL functions, but only two carry row synchronization:

```text
kizunasync.pull(buckets, cursor, schema_version, limit, client_id)
kizunasync.push(batch, last_mutation_id, schema_version, client_id)
```

`kizunasync.attachment_confirm`, `kizunasync.attachment_metadata`, and `kizunasync.attachment_vacuum` are public attachment metadata operations outside the pull/push transcript corpus. `client_id` is optional on both row-sync calls.

All five public wrappers are `SECURITY DEFINER`, never `SECURITY INVOKER`. Pull and push delegate application-row access to `SECURITY DEFINER` helpers owned by `kizunasync_rls`, and that owner is `NOBYPASSRLS`. Policies evaluated against the request [JWT](https://grokipedia.com/page/JSON_Web_Token) remain the row boundary.

## The two calls, end to end

```jsonc
// pull request
{
  "buckets": [{ "table": "todos", "params": { "owner_id": "…" } }],
  "cursor": "0",
  "schema_version": 1,
  "limit": 500
}
```

```jsonc
// push request
{
  "batch": {
    "atomic": false,
    "mutations": [{
      "mutation_id": "…",
      "table": "todos",
      "pk": "…",
      "op": "insert",
      "columns": { "owner_id": "…", "title": "first local todo", "done": false }
    }]
  },
  "last_mutation_id": null,
  "schema_version": 1
}
```

The SQL wrapper reads the JWT `session_id` claim when client registration is enabled, so identity never travels as a JSON field.

## Mutations and column-masked conflict resolution

A mutation is identified by `mutation_id` and targets `(table, pk)` with operation `insert`, `update`, or `delete`. The keys of `columns` are the update mask. Two accepted updates to distinct columns can both survive; this rule does not bypass tombstones, [RLS](https://grokipedia.com/page/Row-level_security), preconditions, [HLC](../../docs/resources/glossary.md#hybrid-logical-clock-hlc) comparisons, or constraints.

Default `arrival` mode orders contested columns at the single [Postgres](https://grokipedia.com/page/PostgreSQL) arbiter. Device wall clocks are not consulted. In `hlc` mode, the server clamps the origin HLC's physical time and compares it per masked column. If every column loses, the verdict is `SUPERSEDED`; partial winners apply without overwriting losing columns.

A hard delete writes a [tombstone](https://grokipedia.com/page/Tombstone_(data_store)). A later mutation for that row returns `DELETE_WINS` to a caller whose pulls received a live row of the bucket value the row was deleted from, or who deleted it earlier in the same push, and `RLS_DENIED` with no row to any other caller (`D-tombstone-delivery`). Cursor expiry is coupled to tombstone retention so an old client cannot continue from incomplete delete history. A write that moves a row to another bucket value also leaves a tombstone, for the value the row left; that one is followed by the write itself, so it is no delete and a later mutation of the row is decided as usual (`D-bucket-move-out`).

The SQL pack also has an opt-in per-table `conflictJournal` setting. When enabled, successful arrival- and HLC-mode writes record overwritten, previously non-null values for the columns that land. Authenticated clients have no direct `SELECT` on `_conflict_journal`. `D-conflict-journal-visibility` is decided: a pull of the winning row may include those losers in an optional `conflicts` array, omitted when empty.

`base_hint` is present as an optional unconstrained schema slot. `D-base-hint` remains open and no transcript assigns it semantics.

## Session guarantees and exactly-once effect

The protocol model defines causal+ consistency at checkpoint boundaries and four distinct per-device session guarantees:

- Read-your-writes holds through local optimistic state and outbox rebase over incoming checkpoints.
- Monotonic reads holds through non-regressing visible checkpoints.
- Monotonic writes holds through serial issue-order processing. A recorded dead letter is the explicit exception.
- Writes-follow-reads holds through one global server sequence, where a write takes a position after the prefix the client already observed.

These are scoped by RLS and bucket visibility. They do not imply equal datasets for callers authorized to see different rows.

Transport is at-least-once. The server's mutation [UUID](https://grokipedia.com/page/Universally_unique_identifier) verdict ledger gives an exactly-once effect. A replay does not apply the write again, and it answers only the user who pushed the mutation. That user gets the recorded kind and reason, and a `server_row` the verdict carried is rendered again from the row as it stands now, because the ledger keeps no row copy. Any other user gets `RLS_DENIED` with a null `server_row` (`D-verdict-ownership`). `D-dedup-storage-model` remains open on how `_clients.last_mutation_id` relates to that per-mutation storage. The observable replay behavior is fixed.

## Keyset pagination and delivery bound

Pull returns the latest row image for each key, rather than an oplog of every past image. Deliverable rows and tombstones form one stream ordered by `(seq, table, pk)`. The order has no ties, because every `seq` comes from one global sequence and a tombstone owns its `seq`. The global cursor can cross changes outside the request bucket, or changes [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) hides. It does not expose their row images.

A page is a prefix of the remaining stream. It holds at most `limit` entries, rows and tombstones counted together, and its `rows` and `tombstones` lists each keep stream order. The SQL pack and the reference oracle both refuse a `limit` below 1 with SQLSTATE `22023` before any gate runs; the transcript format has no step for a pull that raises, so no transcript pins that refusal. When the remaining entries fit in one page, that page carries all of them with the checkpoint token the horizon computed, and `has_more: false` closes the checkpoint. An exact fit of `limit` entries closes it the same way. Otherwise the page carries the first `limit` entries with `has_more: true`, so a tombstone at the head of the stream rides the first page like any row (`D-page-cap-and-checkpoint-boundary`). Its cursor is `<start>:<seq of its last entry>`, where the start is the checkpoint the transfer started from: the incoming token's start when it has one, otherwise its high-water. The reference oracle also keeps the holes below that seq, and it keeps `has_more: true` on a last page whose cursor still carries a hole.

A page also ends once the server has examined a scan cap of candidates, counting the rows it withholds (hidden by RLS or matching no bucket entry) together with the entries it delivers: `_settings.max_pull_scan` in the SQL pack, default 5000, and `context.server.max_pull_scan` in a transcript. Such a page returns `has_more: true` even with fewer than `limit` entries, none included, and its cursor is `<start>:<seq of the last candidate examined>`. A stream that ends exactly at the cap closes the checkpoint like an exact fit. A pull names at most 64 bucket entries; both implementations refuse a longer list with SQLSTATE `22023` before any gate runs (`D-page-cap-and-checkpoint-boundary`, `pull/005-scan-cap-continues-below-the-limit`).

The bucket snapshot stored with the tombstone scopes a deleted primary key. The server does not replay RLS on a row that is gone. A tombstone is delivered only when three things hold: its snapshot's bucket value matches the pull params, on the bucket column alone; an earlier pull delivered the caller a live row of that table and bucket value, which the SQL pack records as a grant; and the row's current state is not deliverable to the caller under the requested buckets (`D-tombstone-delivery`). Unbucketed tables stay table-scoped, and an unscoped pull of a bucketed table is refused with `KZL01` before any page is built. The cursor may still advance past a withheld delete. RLS stricter than the bucket is a residual. It is not a second tombstone filter.

The SQL pack labels every changelog entry with the bucket value of the row it wrote, casts each requested bucket value through the column type once, and reads a bucketed table's changelog only for the requested values; an unbucketed table keeps a table scan. A row a write moves to another bucket value leaves the old value a tombstone at a lower `seq` than the write, keyed by `(table, pk, bucket value)`, so a move-out and a later delete keep one tombstone each. A pull withholds a tombstone while the row is still deliverable to the caller: a device that pulls both values keeps the row, and a device that received the row from the old value and pulls only that value drops it (`D-bucket-move-out`, `tombstones/004-bucket-move-out`).

A largest-visible-sequence cursor is unsafe when sequence numbers are drawn before commit, because a transaction can hold a low number while a higher one commits and a pull passes it. The SQL pack therefore draws every number at commit. The [fencing](../../docs/resources/glossary.md#fencing) mechanism is the Postgres visibility horizon (`D-visibility-horizon`): the largest commit-ordered sequence number visible in the pull's snapshot.

`kizunasync.track_change` and `kizunasync.track_delete` queue each change in `kizunasync._change_pending`, and a deferred constraint trigger, `kizunasync._stamp_change`, numbers each queued change at commit while it holds one transaction-scoped advisory lock. Postgres makes a committing transaction visible before it releases its locks, so the numbers a snapshot sees form a gapless prefix, apart from numbers an aborted commit consumed.

Two implementations of that horizon exist in this repository:

| Implementation | Behavior |
|---|---|
| SQL pack | A pull takes one snapshot and closes the checkpoint at the largest sequence number visible in it, with a flat checkpoint token; it still honors a composite one. An open transaction has no sequence number, so it never holds back other commits |
| TypeScript reference oracle | Sees in-flight effects in memory, delivers committed rows above an in-flight gap, and records each gap in a composite cursor for re-delivery |

The two refuse to skip a late commit for different reasons. In the pack a late commit draws a number above every visible one, and the oracle re-delivers each recorded hole once it commits. Both deliver a change as soon as its transaction's commit is visible, and they differ in the cursor they emit.

The manifest carries three fencing cases. They exercise late commit, [idempotent](https://grokipedia.com/page/Idempotence) re-delivery, and two simultaneous holes in the reference oracle, so they are oracle evidence. The SQL evidence is the pack's concurrency tests, `packages/supabase-pack/tests/pull-fencing-*.test.ts`.

## Cursor monotonicity, rebase and atomic checkpoints

The cursor is opaque text. `"0"` bootstraps; the client persists and replays the server token without parsing it.

A response with `has_more: true` keeps a checkpoint open. The engine stages the page. At the closing boundary (`has_more: false`), one local database transaction commits the staged rows and tombstones with the final cursor. The same transaction runs the staging cleanup and the FIFO replay of any pending outbox. That holds even when the outbox is non-empty (`D-outbox-rebase`). Replay overlays pending local assigns onto the newly committed snapshot. A pulled tombstone plus a pending non-delete does not resurrect the row. The outbox entry remains, and a later push returns `DELETE_WINS`.

The transaction structure is covered by engine tests and protocol models. It is not a universal physical crash-safety claim: the repository lacks a complete process/device kill matrix for every [SQLite](https://grokipedia.com/page/SQLite) driver and platform.

Pull lifecycle signals are exclusive with page data. A signal response has empty rows and tombstones, `has_more: false`, and the incoming cursor. An optional `conflicts` array (`D-conflict-journal-visibility`) may ride a data page; it is omitted when empty.

## Verdict completeness, transforms and conflict rejection

A non-atomic success response contains one verdict per request mutation, in request order and correlated by `mutation_id`:

```text
applied
rejected(PRECONDITION | RLS_DENIED | COLUMN_DENIED | CONSTRAINT | DELETE_WINS | SUPERSEDED, server_row)
```

The server renders `server_row` under the caller's SELECT policy. It is `null` when the row is deleted or invisible. A rejection therefore cannot become a privileged row read.

The SQL path wraps an individual mutation and returns `CONSTRAINT` for an error raised while its row is applied: a SQLSTATE class-23 integrity-constraint violation, a class-22 data exception such as a value the column type refuses, or a `P0001` that an app trigger raises without a SQLSTATE of its own (`D-rejection-reasons`). Other trigger and internal errors can still fail the RPC. A rejected mutation does not wedge a non-atomic batch. `increment/006`, `increment/009`, and `increment/010` exercise the class-23 path through an increment on a non-numeric column. The transcript grammar has no column types and no app triggers, so the SQL pack's own tests cover the class-22 and `P0001` paths. Despite its name, `push/006-constraint-not-a-wedge` exercises absent-row `RLS_DENIED`.

A mutation is one unit. A `rejected` verdict leaves no effect: none of its columns, transforms, change-log entries, or overwrite-journal entries are written. Only the recorded verdict persists.

For `atomic: true`, the first rejection rolls the batch subtransaction back. The response contains one `batch` object with `outcome: "aborted"`, the offending mutation, reason, and server row; sibling effects do not commit.

Unknown verdict kinds and reasons fail loudly on every bridge.

An `update` may carry optional `transforms` (`D-field-transforms`). They ride that update and never form a fourth `op`. A column key MUST NOT appear in both `columns` and `transforms`. Each transform always applies at the arbiter, without an HLC comparison. A transform cannot `SUPERSEDE` by itself. The closed menu is `increment`, `arrayUnion`, and `arrayRemove`. Signed increment `by` is a schema exception to C-4, the canonicalization rule that keeps JSON numbers non-negative integers below 2^31. `$defs/transform` documents that exception. When any transform ran, `applied` carries an RLS-rendered `server_row`, so the client can snap optimistic state.

## Schema-version signalling

Both row-sync requests carry `schema_version`. The server gates a value below the configured minimum before any normal data work:

- Pull returns an empty page with `RESET_REQUIRED`.
- Push returns `{ "signal": { "type": "RESET_REQUIRED" } }` before any mutation, leaving the outbox and watermark untouched.

`CHECKPOINT_EXPIRED` is pull-only and means the checkpoint the transfer started from predates retained tombstone history: the start of a continuation token, or the high-water of a checkpoint token. A transfer that started from `"0"` never expires, so a bootstrap or a rehydration always completes (`D-cursor-opaque-token`). The engine rehydrates rather than continuing from an incomplete history.

The push outcome is fixed by `D-schema-version-handshake` and `lifecycle/003-push-stale-schema`.

## Outbox and serial in-flight

A local row mutation and its outbox record are written in one local transaction. The engine processes a device's queue in issue order and resends the same mutation UUID after an uncertain acknowledgement.

Only a remote failure explicitly tagged `retryable: false` consumes the dead-letter budget. Five consecutive permanent failures against the same head entry move that mutation, or its consecutive atomic group, to the dead-letter journal and remove it from the queue. Retryable network, timeout, authentication, 5xx, and unclassified failures do not consume the budget and can remain queued indefinitely.

Protocol and local engine errors fail loudly and are not converted into transport dead letters. `D-transport-error-codes` leaves portable transport error codes open.

## Wake-up and poll fallback

Wake-up is a latency hint, never a data channel. The current SQL triggers send private Realtime broadcasts to `kizunasync:<table>` with event `changed`; the current adapter subscribes and discards the payload. A missed hint changes only when the next pull starts.

`D-wakeup-channel` remains open. The deployed channel and payload are not frozen compatibility bytes. `wakeup/002-wakeup-payload` carries no golden transcript. `wakeup/001-missed-wakeup-poll-converges` fixes one correctness rule only: a later pull converges without the hint.

## The golden corpus and deterministic placeholders

`cases/manifest.json` registers 48 entries: 44 shared transcript files, 3 fencing files, and 1 blocked entry with no bytes. The executor resolves 47 runs and 1 skipped result. The only blocked case is `wakeup/002-wakeup-payload` on `D-wakeup-channel`.

The corpus includes schemas, canonical JSON rules, cross-case invariants, scenario controls, a reference server, executor tests, and harness-bite mutations. The Rust conformance runner resolves the same non-blocked manifest set.

Separate evidence lanes remain separate:

- The structural harness checks artifacts and invariants.
- The reference runner checks modeled server responses.
- Engine executors check client obligations.
- SQL integration checks Postgres behavior.
- [TLA+](https://grokipedia.com/page/TLA%2B) checks finite models.
- Driver, browser, device, live-service, and kill tests check physical environments.

A green lane is not evidence that an unrun lane passed. The repository does not package a complete standalone third-party driver TCK.

## Attachments are out of protocol scope

Attachment object bytes never ride pull or push. `D-attachments-outside-row-sync` decides that. The SQL pack includes `attachment_confirm` and `attachment_vacuum`. The client transfer port uses those metadata operations around Storage objects.

The current [Supabase](https://supabase.com) adapter uses single-shot upload for objects at or below 6 MiB and [TUS](https://tus.io/protocols/resumable-upload) above 6 MiB, with 6 MiB chunks. Unit and fake-transport tests cover its paths; the live TUS test is opt-in. These tests do not establish universal process-death resume across every platform.

## Specification grammars

### UUID placeholder grammar

Corpus UUIDs use `00000000-0000-4000-8000-KKNNNNNNNNNN`, with registered kind codes for users, clients, rows, and mutations (`a1`, `c1`, `e1`, `f1` in `fixtures/identifiers.json`). This deterministic corpus grammar is narrower than the runtime SQL UUID grammar.

### Logical timestamp grammar

Corpus timestamps use `2026-01-01T00:00:SS.000Z` to encode logical steps. They are fixtures, not claims about runtime wall-clock values.

### Decimal seq and cursor token

`TSeq` is a decimal string. `TCursor` has this canonical grammar:

```text
bootstrap checkpoint:     0
checkpoint:               <high-water>
checkpoint with holes:    <high-water>~<h1>.<h2>...
continuation:             <start>:<high-water>
continuation with holes:  <start>:<high-water>~<h1>.<h2>...
```

Holes are positive, ascending sequences below the high-water mark. `<start>` is the high-water of the checkpoint a continuation page's transfer started from, `0` for a transfer from the bootstrap, and it has no ordering constraint against the high-water. Only continuation pages carry a start. The SQL pack emits no holes and still honors them; the refined oracle emits holes when needed.

### Origin HLC grammar

An origin HLC is the string `<iso>|<logical>|<node>`, where `<iso>` matches the logical timestamp grammar, `<logical>` is a non-negative decimal integer, and `<node>` is a non-empty token. Corpus fixtures that stamp `hlc` on a mutation or an out-of-band setup row use this whole string. The server clamps the physical component before comparing.

## Principles

### Protocol is the product; the corpus is the arbiter

An implementation fails loudly on an unknown signal, verdict kind, rejection reason, or malformed cursor rather than fabricating state; closed wire unions are never extended by guesswork.

For exact corpus bytes, schemas and selected transcripts are authoritative. For decision disposition, `decisions/index.json` is authoritative. For deployed SQL behavior, the migration is authoritative. These scopes must be named when they differ.

## Two roles, never one

`@kizunasync/protocol` is the private machine specification and test oracle. `@kizunasync/core` is an engine implementation and public API package. The core mirrors generated wire types and uses corpus tooling in development and tests; its package manifest lists `@kizunasync/protocol` as a development dependency, not a runtime dependency.

The protocol package's exports expose executor and harness modules. Generated wire types are not a public `@kizunasync/protocol/spec/*` import path.

## How the corpus stays honest

Every manifest case either resolves to explicit transcript bytes or names a blocking decision. Canonicalization keeps two fixtures from meaning the same thing while differing byte for byte. The runner compares the reference server against golden responses. A deliberate harness mutation fails at a pinned step.

## Limits and non-goals

- `D-dedup-storage-model`, `D-base-hint`, `D-wakeup-channel`, and `D-transport-error-codes` are open.
- `D-conflict-journal-visibility` decides that pull may attach an optional `conflicts` array and omits it when empty. Authenticated clients hold no `SELECT` on `_conflict_journal`.
- `D-outbox-rebase` decides that a completed pull rebases the pending outbox onto the newly committed snapshot. Checkpoint hold-back is not part of the protocol.
- The three fencing transcripts exercise the reference oracle's composite holes, which the SQL pack never emits. The pack's commit-ordered numbering is covered by its own concurrency tests, not by the corpus.
- Attachment bytes remain outside row-sync messages.
- The corpus is not a live SQL, driver, browser, device, multi-process, or kill-test certification.
- A complete standalone third-party driver TCK is not packaged.

## Cross-reference anchors

### Wake-up and realtime: a hint, never a source of truth

Wake-ups influence scheduling only. Pull remains the authoritative data path. `D-wakeup-channel` leaves the spelling of the deployed channel unfrozen.

### Cursor and sequence decimal-string grammar

Sequences use decimal strings and cursors use opaque text. Drivers preserve both without JSON-number coercion.

### The driver TCK

The corpus is the shared wire oracle used by engine and port harnesses. A complete packaged third-party driver TCK and the full physical qualification matrix are not available.

## Related documentation

- [Protocol reference](../../docs/reference/protocol.md)
- [Protocol overview](../../docs/sync/protocol-overview.md)
- [Protocol decisions](../../docs/resources/protocol-decisions.md)
- [Drivers and the TCK](../../docs/reference/drivers-and-tck.md)
- [Fencing and horizons](../../docs/sync/fencing-and-horizons.md)
