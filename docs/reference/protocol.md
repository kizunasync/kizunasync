---
title: Protocol reference
description: Every field of the pull and push wire shapes, the closed vocabularies, the cursor grammar, the fencing variants, and the conformance inventory.
status: alpha
docType: reference
audience: driver-author
---

# Protocol reference

This page lists the row-sync wire surface as the current repository implements it: every message field with its type and requirement, every member of every closed vocabulary, the cursor grammar, and what the golden corpus covers. [Protocol overview](../sync/protocol-overview.md) explains how the two calls fit together; this page is the field-by-field lookup that page points at.

[Authenticated SQL surface](#authenticated-sql-surface), [Scalar types](#scalar-types), and [Closed vocabularies](#closed-vocabularies) name the five functions and the value sets every message is built from. [Pull request](#pull-request) through [Rejection reasons](#rejection-reasons) give each field of the two calls and the closed verdict set. [Cursor grammar](#cursor-grammar) through [Attachment boundary](#attachment-boundary) state the rules a client follows around those messages. [Conformance inventory](#conformance-inventory), [Decision registry](#decision-registry), and [Known contract limits](#known-contract-limits) mark what the corpus pins and what stays open.

Four sources are authoritative, each inside its own scope. The JSON Schemas and the selected transcripts fix corpus bytes, `decisions/index.json` fixes decision disposition, `0001_kizuna_init.sql` fixes deployed database behavior, and the Rust engine fixes client reconciliation. Where they differ, the difference is named at the point it appears.

| Subject | Source |
|---|---|
| JSON wire shapes | `packages/protocol/schemas/*.schema.json` |
| Generated TypeScript types | `packages/protocol/spec/wire-types.ts` |
| Cursor codec | `packages/protocol/spec/cursor-token.ts` |
| Golden behavior | `packages/protocol/cases/manifest.json` and `transcripts/` |
| Decision status | `packages/protocol/decisions/index.json` |
| Deployed SQL behavior | `packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql` |
| Client reconciliation | `crates/kizunasync-engine/` |

## Authenticated SQL surface

The pack grants five functions to `authenticated`. Only `pull` and `push` carry row synchronization. The three attachment functions move metadata around Storage objects, and they appear in no transcript.

| Function | Arguments | Returns | Purpose |
|---|---|---|---|
| [`kizunasync.pull`](./sql-pack.md#kizunasyncpull) | `buckets jsonb, cursor text, schema_version integer, "limit" integer default 500, client_id uuid default null` | `jsonb` | Row and tombstone download |
| [`kizunasync.push`](./sql-pack.md#kizunasyncpush) | `batch jsonb, last_mutation_id uuid, schema_version integer, client_id uuid default null` | `jsonb` | Mutation upload and verdicts |
| [`kizunasync.attachment_confirm`](./sql-pack.md#kizunasyncattachment_confirm) | `p_bucket text, p_path text, p_sha256 text, p_size bigint, p_media_type text, p_table text default null` | `void` | Attachment integrity metadata |
| [`kizunasync.attachment_metadata`](./sql-pack.md#kizunasyncattachment_metadata) | `p_bucket_id text, p_object_path text` | table of integrity columns | Peer-visible integrity metadata |
| [`kizunasync.attachment_vacuum`](./sql-pack.md#kizunasyncattachment_vacuum) | `p_bucket text, p_path text` | `void` | Caller-owned attachment metadata cleanup |

All five wrappers are [`SECURITY DEFINER`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker), the mode Supabase contrasts with invoker rights, because they read and write private bookkeeping the caller holds no privilege on. The wrappers delegate application-row access to a second set of `SECURITY DEFINER` helpers owned by `kizunasync_rls`, a `NOBYPASSRLS` role that inherits the request [JWT](https://grokipedia.com/page/JSON_Web_Token) claims. The [policies on the application table](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) therefore stay the authorization boundary, and nothing bypasses them. Describing the public wrappers themselves as `SECURITY INVOKER` is wrong.

A client reaches all five as ordinary [Postgres](https://grokipedia.com/page/PostgreSQL) functions through the [Data API](https://supabase.com/docs/guides/api#rest-api-overview), which exposes the `kizunasync` schema alongside `public`. The request bodies below are the [`rpc`](https://supabase.com/docs/reference/javascript/rpc#parameters) argument maps, and their top-level keys are the SQL argument names. [Buckets](../resources/glossary.md#bucket) scope selection under [Row Level Security](https://grokipedia.com/page/Row-level_security) and never widen it.

## Scalar types

| Name | Wire form | Constraint | Description |
|---|---|---|---|
| `TCursor` | string | `^((0\|[1-9][0-9]*):)?(0\|[1-9][0-9]*)(~[1-9][0-9]*(\.[1-9][0-9]*)*)?$` | Opaque resume token. `"0"` is the bootstrap value. See [Cursor grammar](#cursor-grammar). |
| `TSeq` | string | `^(0\|[1-9][0-9]*)$` | Position in the one global server change sequence. Always decimal text, never a JSON number. |
| `TUuid` | string | Corpus: `00000000-0000-4000-8000-(a1\|c1\|d1\|e1\|f1)[0-9]{10}` | Runtime values are RFC 4122 UUIDs. The pattern above is the corpus placeholder grammar, with kind codes `a1` user, `c1` client, `d1` attachment (reserved and unused), `e1` row primary key, and `f1` mutation. |
| `TIsoTimestamp` | string | Corpus: `^2026-01-01T00:00:[0-5][0-9]\.000Z$` | Runtime values are real timestamps. The pattern above encodes logical steps for deterministic fixtures. |
| `TColumnValue` | string, integer, boolean, null, or an array of strings, integers, and booleans | Corpus: integers are non-negative and below 2^31 | One column value. Every int64-class value rides as a decimal string. Floats and exponents never appear in the corpus. Postgres array columns encode as JSON arrays of scalars. |
| `TColumnValues` | object | Values are `TColumnValue` | A column-to-value map. Its key set is the mutation mask wherever a mask applies. |

A driver that validates against the corpus [UUID](https://grokipedia.com/page/Universally_unique_identifier) and timestamp patterns rejects production traffic.

## Closed vocabularies

Every union below is closed. The engine fails loudly on an unrecognized member rather than choosing a compensation, so adding a value is a wire change and not a compatible extension.

```ts
// @kizunasync/protocol spec/wire-types.ts (excerpt)
type TOp = 'delete' | 'insert' | 'update'
type TSignalType = 'CHECKPOINT_EXPIRED' | 'RESET_REQUIRED'
type TRejectReason =
  | 'COLUMN_DENIED'
  | 'CONSTRAINT'
  | 'DELETE_WINS'
  | 'PRECONDITION'
  | 'RLS_DENIED'
  | 'SUPERSEDED'
type TVerdictKind = 'applied' | 'rejected'
type TBatchOutcome = 'aborted'
```

D-rejection-reasons decided the rejection literals and D-field-transforms decided the transform menu. [Status taxonomy](./status-taxonomy.md) lists these vocabularies beside the local ones the engine adds on top.

## Pull request

```ts
// @kizunasync/protocol spec/wire-types.ts (excerpt)
type TBucket = {
  params: Record<string, boolean | number | string>
  table: string
}

type TPullRequest = {
  buckets: TBucket[]
  client_id?: TUuid
  cursor: TCursor
  limit?: number
  schema_version: number
}
```

| Name | Type | Required | Description |
|---|---|---|---|
| `buckets` | `TBucket[]` | Yes | The table scopes this request covers. A bucket is `{ table, params }`. An empty array asks for nothing. The SQL pack and the reference oracle refuse more than 64 entries with SQLSTATE `22023` before any gate runs. |
| `buckets[].table` | `string` | Yes | A synced table name, matched against `^[a-z][a-z0-9_]*$`. |
| `buckets[].params` | `Record<string, boolean \| number \| string>` | Yes | Column-equality filter applied to the rendered row. An empty object matches the whole table. |
| `client_id` | `TUuid` | No | Durable client identity, decided by D-client-identity. The engine sets it from its configured `clientId`. When the key is absent the wrapper falls back to the JWT `session_id` claim, the resolved D-client-identity carrier. |
| `cursor` | `TCursor` | Yes | The token the previous response returned, or `"0"` to start over. Shape decided by D-cursor-opaque-token. |
| `limit` | `number` | No | Page cap shared by rows and tombstones, decided by D-page-cap-and-checkpoint-boundary. A client omits it unless it was configured with a page size; the SQL applies `500` when the argument is absent or null. The SQL pack and the reference oracle both refuse a value below `1` with SQLSTATE `22023` (`invalid_parameter_value`) before any gate runs. The transcript format has no step for a pull that raises, so no transcript pins that refusal. A page can also end below `limit` at the server's scan cap, described under the pull response. |
| `schema_version` | `number` | Yes | The client's declared schema version, compared with the highest configured minimum across the requested tables, or with the highest across every configured table when none of the requested tables match. The SQL pack gates a `null` value like a stale one. |

Transcript `context.client_id` is the same uuid the engine puts on the body.

## Pull response

```ts
// @kizunasync/protocol spec/wire-types.ts (excerpt)
type TRowChange = {
  pk: TUuid
  row: TColumnValues
  seq: TSeq
  table: string
}

type TTombstone = {
  deleted_at: TIsoTimestamp
  pk: TUuid
  seq: TSeq
  table: string
}

type TConflict = {
  column_name: string
  conflict_mode: 'arrival' | 'hlc'
  loser_value: unknown
  pk: TUuid
  table: string
  winner_mutation_id: TUuid
  winner_seq: TSeq
}

type TSignal = { type: TSignalType } | null

type TPullResponse = {
  conflicts?: TConflict[]
  cursor: TCursor
  has_more: boolean
  rows: TRowChange[]
  signal: TSignal
  tombstones: TTombstone[]
}
```

| Name | Type | Required | Description |
|---|---|---|---|
| `conflicts` | `TConflict[]` | No | Overwritten values recorded by the opt-in [server-side conflict journal](#server-side-conflict-journal). Each entry includes `winner_seq`. The key is omitted when there is nothing to attach, which is the only correct encoding of an empty result. |
| `cursor` | `TCursor` | Yes | The next resume position. The engine writes it in the same local transaction that commits the staged data. |
| `has_more` | `boolean` | Yes | `true` marks a continuation page, including one the scan cap ended below `limit`, and keeps the [checkpoint](../resources/glossary.md#checkpoint) open. `false` marks the page that carried the rest of the stream, an exact fit of `limit` entries included, and closes the checkpoint; on a signal response it ends the sequence instead. The reference oracle keeps `true` on that last page while its composite cursor still carries a hole. |
| `rows` | `TRowChange[]` | Yes | Latest row images, ordered by `(seq, table, pk)`. This is a state feed and not a row-image oplog, so a row that changed three times arrives once. |
| `rows[].row` | `TColumnValues` | Yes | The full row as the caller's [SELECT policy](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies) renders it. Kizuna reads it through a helper that runs under those policies rather than around them. |
| `signal` | `{ type: TSignalType } \| null` | Yes | `null`, or one [lifecycle signal](#lifecycle-signals). A non-null signal is exclusive with page data. |
| `tombstones` | `TTombstone[]` | Yes | Removed primary keys in the same ordering domain: deleted rows, and rows a write moved out of a requested bucket value. Only the key travels, never a row image. |

Rows and tombstones form one stream ordered by `(seq, table, pk)`. The order has no ties, because every `seq` comes from one global sequence and a tombstone owns its `seq`. A page is a prefix of what remains of that stream. It holds at most `limit` entries, rows and tombstones counted together, and `rows` and `tombstones` each keep stream order. When the remaining entries fit in one page, that page carries all of them with a checkpoint cursor and `has_more: false`, which closes the checkpoint. An exact fit of `limit` entries closes it the same way. Otherwise the page carries the first `limit` entries with `has_more: true`, so a tombstone at the head of the stream rides the first page like any row. Its cursor is `<start>:<seq of its last entry>`. The start is the incoming token's start when it has one, otherwise the incoming token's high-water, so every page of a transfer names the checkpoint the transfer started from. The reference oracle's continuation cursor also keeps the holes below that `seq`. D-page-cap-and-checkpoint-boundary decided this rule.

A page also ends once the server has examined its scan cap of candidates, the rows it withholds included: `_settings.max_pull_scan` in the SQL pack, default 5000, and `context.server.max_pull_scan` in a transcript. That page returns `has_more: true` even when it holds fewer than `limit` entries, or none, and its cursor is `<start>:<seq of the last candidate examined>`, which can lie above its last entry. A stream that ends exactly at the cap closes the checkpoint like an exact fit. The SQL pack reads a bucketed table's changelog only for the requested bucket values, after casting each value through the column type, so the rows of other bucket values never count against the cap. D-page-cap-and-checkpoint-boundary decided this rule too, and `pull/005-scan-cap-continues-below-the-limit` pins it.

A signal response carries empty `rows`, empty `tombstones`, `has_more: false`, and the incoming [cursor](../resources/glossary.md#cursor) echoed back.

Row Level Security cannot be replayed against a row that is gone, so tombstone scope comes from the bucket snapshot stored at delete time and from what the caller has already received. A deleted key rides the page when the snapshot's bucket value matches the request params (the other params of a bucket filter live rows only), when an earlier pull delivered this caller a live row of that table and bucket value, which the SQL pack records as a grant, and when the row's current state is not deliverable to the caller. Tables without a bucket column stay table-scoped, and a policy stricter than the bucket is not applied a second time. An unscoped pull of a table provisioned with a bucket column is refused with `KZL01` before any page is built. A write that moves a row to another bucket value leaves the old value a tombstone at a lower `seq` than the write, and tombstones are keyed by `(table, pk, bucket value)`, so a move-out and a later delete keep one each. A pull withholds a tombstone while the row is still deliverable to the caller, so a device that pulls both values keeps the row and a device that received the row from the old value and pulls only that value drops it. D-bucket-move-out and D-tombstone-delivery decided this, and `tombstones/004-bucket-move-out` pins the move-out. Members of the same bucket value still receive the deleted keys of rows they never saw, and a member removed from a bucket keeps receiving its deletions, so a table whose policies are finer than its bucket should mark removals with a soft-delete column instead. Supabase documents the write side of that boundary in [DELETE policies](https://supabase.com/docs/guides/database/postgres/row-level-security#delete-policies). Kizuna adds only the snapshot and grant filters above them.

## Push request

```ts
// @kizunasync/protocol spec/wire-types.ts (excerpt)
type TMutation = {
  base_hint?: unknown
  columns: TColumnValues
  hlc?: string
  mutation_id: TUuid
  op: TOp
  pk: TUuid
  precondition?: TColumnValues
  table: string
  transforms?: Record<string, TTransform>
}

type TPushBatch = {
  atomic: boolean
  mutations: TMutation[]
}

type TPushRequest = {
  batch: TPushBatch
  client_id?: TUuid
  last_mutation_id: TUuid | null
  schema_version: number
}
```

| Name | Type | Required | Description |
|---|---|---|---|
| `batch.atomic` | `boolean` | Yes | `false` asks for independent per-mutation verdicts. `true` asks for all-or-nothing semantics decided by D-atomic-batch-abort. The SQL treats a missing key as `false`. |
| `batch.mutations` | `TMutation[]` | Yes | The mutations in issue order. Verdicts come back in the same order. |
| `client_id` | `TUuid` | No | The same optional identity as on pull, decided by D-client-identity, with the JWT `session_id` claim as fallback. |
| `last_mutation_id` | `TUuid \| null` | Yes | The client-registry watermark, stored in [`_clients`](./sql-pack.md#kizunasync_clients) when registration is on. How it relates to per-mutation verdict storage is blocked by D-dedup-storage-model. |
| `schema_version` | `number` | Yes | Gated before any mutation runs, per D-schema-version-handshake, against the highest configured minimum across the mutations' tables. A stale value returns the signal arm below. |

Each element of `batch.mutations`:

| Name | Type | Required | Description |
|---|---|---|---|
| `mutation_id` | `TUuid` | Yes | Idempotency key and the correlation key for the verdict. A repeat applies nothing: the user who pushed it gets the recorded verdict, with any `server_row` rendered again, and any other user gets `RLS_DENIED` with a null `server_row`. |
| `table` | `string` | Yes | A synced table name. A table without a [`_config`](./sql-pack.md#kizunasync_config) row raises `feature_not_supported`. |
| `pk` | `TUuid` | Yes | The row's primary key. |
| `op` | `TOp` | Yes | `insert`, `update`, or `delete`. |
| `columns` | `TColumnValues` | Yes | The values to apply, with `id` omitted. The key set is the conflict mask. Empty for a delete. |
| `precondition` | `TColumnValues` | No | Expected values for visible columns, compared against the current server row before the apply. A mismatch yields the `PRECONDITION` verdict. |
| `transforms` | `Record<string, TTransform>` | No | Field [transforms](#transforms) on `op: 'update'` only. Omitted when empty. |
| `hlc` | `string` | No | The origin clock, formatted `<iso8601>\|<logical>\|<node>`. Required by the current SQL for a table whose conflict mode is `hlc`, and unused for ordering on an arrival-mode table. |
| `base_hint` | `unknown` | No | An unconstrained schema slot named by the specification and left without shape or semantics by D-base-hint. No transcript uses it. |

A column key must not appear in both `columns` and `transforms`. The schema forbids it, and the specification defines no precedence for it. The JavaScript builder cannot construct one, because it splits a single `update()` values map into the two. It throws `LOCAL_CONSTRAINT` when a transform targets the primary key.

## Transforms

A transform is an arithmetic or set operation (not a fourth `op`) that the arbiter applies to the current server value, so two devices that each add one both land. The arbiter never compares a transform against an [HLC](../resources/glossary.md#hybrid-logical-clock-hlc), which means a transform alone cannot produce a `SUPERSEDED` verdict.

```ts
// @kizunasync/protocol spec/wire-types.ts (excerpt)
type TTransform =
  | { by: number | string; op: 'increment' }
  | { op: 'arrayRemove' | 'arrayUnion'; values: (boolean | number | string)[] }
```

| Name | Type | Required | Description |
|---|---|---|---|
| `op` | `'increment' \| 'arrayUnion' \| 'arrayRemove'` | Yes | The closed menu decided by D-field-transforms. The SQL pack refuses any other value, like a missing or non-numeric `by` and an empty `values`, with SQLSTATE `22023` for the whole batch before any mutation runs. |
| `by` | `number \| string` | Yes for `increment` | A signed integer delta. It rides as a JSON number below 2^31 in absolute value and as a decimal string matching `^-?(0\|[1-9][0-9]*)$` above it. This is the one place a negative JSON number is allowed. |
| `values` | `(boolean \| number \| string)[]` | Yes for `arrayUnion` and `arrayRemove` | At least one scalar member to add or remove. `arrayUnion` appends only missing members and keeps existing order. The deployed SQL applies both to a `text[]` column only and raises `CONSTRAINT` against any other type. |

When any transform ran, the `applied` verdict carries `server_row` so the client can replace its optimistic value with the arbitrated total. [Using transforms](./javascript/using-transforms.md) shows the call side.

## Push response

```ts
// @kizunasync/protocol spec/wire-types.ts (excerpt)
type TVerdictApplied = { mutation_id: TUuid; server_row?: TColumnValues; verdict: 'applied' }

type TVerdictRejected = {
  mutation_id: TUuid
  reason: TRejectReason
  server_row: TColumnValues | null
  verdict: 'rejected'
}

type TVerdict = TVerdictApplied | TVerdictRejected

type TBatchAbort = {
  offender_mutation_id: TUuid
  outcome: 'aborted'
  reason: TRejectReason
  server_row: TColumnValues | null
}

type TPushResponse =
  | { verdicts: TVerdict[] }
  | { batch: TBatchAbort }
  | { signal: { type: 'RESET_REQUIRED' } }
```

The three `TPushResponse` arms are exclusive. Which one arrives depends on `batch.atomic` and on the schema gate.

| Name | Type | Required | Description |
|---|---|---|---|
| `verdicts` | `TVerdict[]` | Yes on the success arm | One verdict per request mutation, in request order. The `mutation_id` values form a bijection with the request, which is the correlation D-verdict-correlation ratified. A non-atomic batch and an atomic batch with no rejection both use this arm. |
| `verdicts[].server_row` | `TColumnValues \| null` | Optional on `applied`, required on `rejected` | The row for a compensating revert, rendered under the caller's SELECT policy and `null` when the row is deleted or invisible. On `applied` it appears only when a transform ran. A rejection can therefore never become a privileged read. |
| `batch` | `TBatchAbort` | Yes on the abort arm | Returned instead of member verdicts when an atomic batch hits its first rejection. It names the offender, the reason, and the offender's server row; every sibling effect rolls back. |
| `signal` | `{ type: 'RESET_REQUIRED' }` | Yes on the schema arm | Returned before any mutation runs when `schema_version` is below the highest configured minimum across the mutations' tables. `CHECKPOINT_EXPIRED` is a cursor concept and never appears on a push. |

The signal arm is request-level. It fabricates no verdicts and clears nothing from the [outbox](../resources/glossary.md#outbox), so the queued writes remain after the client upgrades its schema.

## Rejection reasons

A rejection is a decision the server made about one write. A network failure is no decision at all and never arrives as a verdict.

| Reason | Server condition | `server_row` |
|---|---|---|
| `DELETE_WINS` | The row's latest change is a removal the caller may know about: a delete earlier in the same push, or a tombstone for this `(table, pk)` newer than every write of it, of a bucket value an earlier pull delivered the caller a live row of. Checked after the table's configuration and before row validation. The tombstone a bucket move-out leaves is followed by the write that moved the row, so it does not count. | `null` |
| `PRECONDITION` | One or more `precondition` values do not match the current server row. | The current row, or `null` when the caller may not read it |
| `RLS_DENIED` | The write is not permitted: an insert fails the table's `WITH CHECK`, or an update or delete matches no row the caller may write. An absent row and a policy-hidden row are deliberately indistinguishable, so the reason leaks neither. A deleted row whose bucket value the caller never received a live row of is refused this way too, with no row. An update carrying neither columns nor transforms is refused this way as well. | The current row only when SELECT permits it, otherwise `null` |
| `COLUMN_DENIED` | The mutation writes a column the caller may not UPDATE, under the [column-level privileges](./sql-pack.md#column-level-privileges) a project grants by hand. | The current row narrowed to the columns the caller may read |
| `CONSTRAINT` | A genuine class-23 integrity failure caught around this one mutation: a user `CHECK`, a foreign key, a not-null column, a validation trigger raising in that class, or a transform against a column of the wrong type. | The pre-write row, or `null` |
| `SUPERSEDED` | HLC mode only. Every masked column lost the comparison against the stored winner, and the mutation carried no transform. | The current row, or `null` when the caller may not read it |

An uncaught trigger or internal exception is an RPC failure rather than a fabricated rejection, and the client keeps the mutation queued. [Validation rejections](../sync/conflict-resolution.md#validation-rejections) covers what an app does with each reason.

## Cursor grammar

```text
bootstrap     = "0"
checkpoint    = <high-water> [ "~" <hole> ("." <hole>)* ]
continuation  = <start> ":" <high-water> [ "~" <hole> ("." <hole>)* ]
```

Checkpoint examples are `"42"`, `"6~5"`, and `"9~5.7"`; continuation examples are `"0:2"` and `"4:9~5.7"`. A final page returns a checkpoint token, and only a continuation page returns a start: the high-water of the checkpoint its transfer started from, `0` when it started from the bootstrap. The start has no ordering constraint against the high-water. Holes are positive decimal sequences strictly below the high-water mark, written in ascending order. The TypeScript encoder sorts them and throws on a hole greater than or equal to the mark rather than emitting a token that would pass format validation while meaning nothing.

The client contract is opacity: persist the string and replay it unchanged. No client behavior may depend on the flat form, and a driver must never parse, compare, increment, or coerce the token through a JSON number. [Flat and composite cursors](../sync/fencing-and-horizons.md#flat-and-composite-cursors) works through what each form represents.

## Fencing implementations

Postgres makes a row visible when its transaction commits. A cursor that trusts the largest number a query saw is therefore unsafe when numbers are drawn before commit, because it can step over a lower number still being written. [Fencing](../resources/glossary.md#fencing) is the rule that closes that race, and the SQL pack applies it by drawing every number at commit. D-visibility-horizon picks the Postgres visibility horizon, the largest commit-ordered sequence number visible in a snapshot, over a trigger-set arrival-time window. A finite overlap window bounds lateness by heuristic, and the visibility horizon leaves no gap.

Two implementations of that visibility horizon exist in this version of the repository, and they are not the same code.

| Implementation | Boundary | Cursor output |
|---|---|---|
| Current SQL pack | The largest sequence number visible in the run's snapshot; numbers are drawn at commit | Flat decimal, with the start on a continuation page; a composite token it receives is still honored |
| Visibility-horizon reference oracle | The highest committed high-water, with every in-flight gap recorded explicitly | Flat when no hole exists, composite when one does, with the start on a continuation page |

Neither implementation loses the late commit that the fencing cases model, and each refuses to skip it for its own reason. In the SQL pack a transaction that commits late draws its number at that moment, above every number already visible, and an open transaction has no number, so it holds back no other commit. The reference oracle delivers the rows above an in-flight gap, then re-scans that gap once it commits. Both deliver a change as soon as its commit is visible; what differs is the cursor they emit.

The three fencing cases in the manifest run against the oracle and are evidence for the refined model. The SQL evidence is the pack's concurrency tests, `packages/supabase-pack/tests/pull-fencing-*.test.ts`. [What commit-time numbering costs](../sync/fencing-and-horizons.md#what-commit-time-numbering-costs) explains the trade the deployed pack takes: commits that change synced tables run one at a time, so their rate has a ceiling that depends on the disk's flush latency.

## Checkpoint and rebase rules

| Rule | Current engine behavior |
|---|---|
| Cursor monotonicity | A pull never returns a lower covered position than the one it was given. |
| Atomic checkpoint | Staged rows, tombstones, the final cursor, staging cleanup, and outbox replay commit in one local transaction. |
| Rebase | A non-empty outbox does not withhold the checkpoint. Pending mutations replay over the new snapshot in issue order (D-outbox-rebase). |
| Page safety | `has_more: true` retains staging. Only the closing boundary publishes it. |
| Tombstone precedence | A pulled tombstone plus a pending non-delete does not resurrect the row. The outbox entry stays and a later push returns `DELETE_WINS`. |

These are properties of the engine code and the protocol models. The repository has no complete physical kill-test matrix across every [SQLite](https://grokipedia.com/page/SQLite) driver, so this section asserts no universal crash durability. [Checkpoints](../sync/consistency-model.md#checkpoints) states the same boundary from the app's side.

## Exactly-once effect and dead letters

Transport delivery is at least once. The mutation UUID indexes the server verdict ledger, so a repeated mutation applies no second effect and returns its recorded verdict to the user who pushed it. Another user who repeats the UUID gets `RLS_DENIED` with a null `server_row`. The result is an exactly-once effect over an at-least-once channel. It is not exactly-once delivery.

Only a failure the adapter tags permanent counts against the [dead-letter](../resources/glossary.md#dead-letter) budget. Five consecutive permanent failures against the same outbox head dead-letter that entry, or its consecutive atomic group, and remove it from the queue. Retryable network, timeout, authentication, 5xx, and unclassified failures stay queued for as long as they keep failing that way. Protocol and local engine errors fail loudly, and nothing converts them into a transport dead letter. D-transport-error-codes leaves a portable transport error-code vocabulary blocked, so the codes an adapter uses describe that adapter and not the wire.

## Server-side conflict journal

The SQL pack installs [`_conflict_journal`](./sql-pack.md#kizunasync_conflict_journal) and the per-table switch that fills it. The switch is the [`conflict_journal`](../cli/configuration.md#kizunasync_config) column, default `false`.

For an enabled table, a successful arrival-mode or HLC-mode apply records one row per column that landed over a different, non-null previous value. Each row carries that previous value, the winning mutation ID, and the conflict mode. Nothing else produces an entry: not a first write, not a column absent from the pre-image, not an unchanged value, not a value whose prior value was null, not `id`, not a losing HLC column, not a delete, not a rejected mutation, and not either transform family. A transform's values never travel in the `columns` map the journal reads.

D-conflict-journal-visibility fixes what a client sees of the journal on the wire. Pull attaches a `conflicts` array, and each entry joins a `_conflict_journal` row to the delivered page by `winner_seq`. An entry appears only when the winning row's primary key is already in `rows`, so the array never reveals a row the page withheld. Only `service_role` holds `SELECT` on `_conflict_journal` itself. The `conflict/004` case pins those bytes, and the engine persists `_kizunasync_overwrites` and emits `COLUMN_OVERWRITTEN` for each entry, except one its own write won.

## Lifecycle signals

| Signal | Pull meaning | Push meaning |
|---|---|---|
| `CHECKPOINT_EXPIRED` | The checkpoint the transfer started from predates the retained delete history: the start of a continuation token, or the high-water of a checkpoint token. The incremental position is unusable and the engine rehydrates from `"0"`, a transfer that never expires. | Not a push response arm |
| `RESET_REQUIRED` | The request's `schema_version` is below the highest minimum configured across the requested tables. | Gated before every mutation; the outbox and the watermark are untouched |

A pull signal replaces a page rather than riding beside one. [Lifecycle signals](../sync/protocol-overview.md#lifecycle-signals) covers what an app does when either arrives.

## Wake-up contract

A wake-up is a scheduling hint and never a data channel. The deployed triggers send a private [Realtime broadcast](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database) on topic `kizunasync:<table>` with event `changed`, and the Supabase adapter subscribes and discards the payload. Supabase gates who may read a private topic through [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#broadcast-and-presence-read); the pack ships the read policy and no [write policy](https://supabase.com/docs/guides/realtime/authorization#broadcast-and-presence-write), because the trigger functions emit as `SECURITY DEFINER`.

D-wakeup-channel is blocked. No golden bytes freeze the channel spelling or the payload, and `wakeup/002-wakeup-payload` is the manifest entry that waits on that decision. `wakeup/001-missed-wakeup-poll-converges` fixes only the correctness rule: a missed hint costs freshness and nothing else, because the next pull finds the change anyway.

## Attachment boundary

D-attachments-outside-row-sync settles the attachment boundary. `attachment_confirm` and `attachment_vacuum` ship in the SQL pack, and the client transfer port calls them around Storage objects. Attachment bytes never ride a pull or push message, and no transcript contains them.

The current Supabase transfer adapter uses a [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) for objects at or below 6 MiB and a [resumable TUS upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) in 6 MiB chunks above that threshold. Live TUS execution is opt-in in the test suite, so the unit and fake-transport coverage establishes no cross-platform crash-resume claim.

## Conformance inventory

`cases/manifest.json` registers 48 entries.

| Group | Entries | What it is |
|---|---|---|
| Shared transcripts | 44 | One canonical request and response file per case |
| Fencing transcripts | 3 | Cases exercising the visibility-horizon reference oracle, under `transcripts/fencing/` |
| Blocked entry | 1 | `wakeup/002-wakeup-payload`, which has no bytes while D-wakeup-channel stays open |

The TypeScript executor and the Rust conformance runner resolve the same 47 executable runs and 1 skip. That skip is the blocked entry `wakeup/002-wakeup-payload`, which carries no bytes to replay.

| Corpus area | Cases |
|---|---|
| Conflict | Different columns merge, same column resolves by arrival, HLC origin order, journal on the winning pull |
| Fencing | Late commit delivered, overlap re-delivery [idempotent](https://grokipedia.com/page/Idempotence), two holes under one high-water mark |
| Increment | Concurrent deltas, increment then assign, assign then increment, server row, delete wins, non-numeric constraint, atomic batch, precondition mix, rejected transform applies no column, HLC rejected transform applies no column |
| Array transforms | Concurrent union, union then remove, union then assign |
| Rebase | Cursor advances with a non-empty outbox, a different column stays visible, a tombstone does not resurrect, rehydration replays |
| Lifecycle | Expired checkpoint, pull reset, push stale schema, soft-delete refusal, a paged bootstrap that completes after a reap, a continuation that expires once a reap passes its start |
| Pull | Empty bootstrap, keyset pagination, a tombstone at the head of a continuation page, an exact fit that closes the checkpoint, a page the scan cap ends below the limit |
| Push | Insert applied, RLS denial without a wedge, replay returns recorded verdicts, precondition rejected, atomic batch revert, absent-row denial, a replayed rejection carries the row as it stands now |
| Tombstones | Delete propagates, an offline edit does not resurrect, bucket-scoped delete, a row that moves to another bucket leaves its old bucket a tombstone |
| Wake-up | Missed hint converges; the payload case is blocked |

Structural corpus validation, reference-server replay, client-engine execution, live SQL integration, [TLA+](https://grokipedia.com/page/TLA%2B) models, and physical driver tests are separate evidence lanes. A lane that passes covers only itself, and it says nothing about a lane that did not run. [Protocol evidence](../getting-started/status.md#protocol-evidence) tracks where that boundary falls, and [Drivers and the TCK](./drivers-and-tck.md) applies it to third-party implementations.

## Decision registry

`decisions/index.json` holds 23 records.

| Status | Decisions |
|---|---|
| `decided` | Nineteen records covering page cap, signals, cursor, fencing, verdicts, rejections, atomic batches, schema handshake, client identity, transforms, conflict journal, outbox rebase, attachments, engine events, corpus grammar, the pull bucket requirement, the bucket move-out, tombstone delivery, and verdict ownership |
| `open` | `D-dedup-storage-model`, `D-base-hint`, `D-wakeup-channel`, `D-transport-error-codes` |

The index schema also admits `superseded`, and no record carries it. [Protocol decisions](../resources/protocol-decisions.md) reads each one in prose, and [Status taxonomy](./status-taxonomy.md#decision-register-status) defines the words.

## Known contract limits

- The SQL pack emits no holes: its checkpoint cursors are flat at its visibility [horizon](../resources/glossary.md#consistency-horizon), because its sequence numbers are commit-ordered, and the reference oracle exercises refined holes in composite cursors. The corpus's fencing cases cover the oracle only; the pack's concurrency tests cover the SQL.
- The SQL pack reports a class-23 integrity failure, the Postgres class for constraint violations, as `CONSTRAINT`. No current golden transcript induces a user `CHECK`, foreign key, not-null, or validation-trigger failure. The corpus pins one class-23 path only: the pack's own raise on a transform against a column of the wrong type, in `increment/006-non-numeric-constraint`, `increment/009-rejected-transform-applies-no-column`, and `increment/010-hlc-rejected-transform-applies-no-column`. Despite its name, `push/006-constraint-not-a-wedge` exercises absent-row `RLS_DENIED`.
- `base_hint` has no semantics and no transcript.
- The relationship between the client-registry watermark and per-mutation verdict storage is not fixed.
- The server-side conflict journal is off by default, and authenticated clients have no `SELECT` on it even when it is on.
- [Wake-up](../resources/glossary.md#wake-up) bytes and portable transport error codes are not frozen.
- A standalone packaged third-party driver TCK is not available.
- Protocol conformance is not physical crash, browser, device, or live-service qualification.

## Related reference

- [Protocol overview](../sync/protocol-overview.md): the same two calls, explained rather than listed.
- [Fencing and horizons](../sync/fencing-and-horizons.md): why a cursor needs a horizon at all.
- [SQL pack](./sql-pack.md): the database objects that produce these shapes.
- [Drivers and the TCK](./drivers-and-tck.md): what the corpus proves about an implementation.
- [Status taxonomy](./status-taxonomy.md): the status vocabularies these messages carry.
- [Protocol decisions](../resources/protocol-decisions.md): each OD and D record in prose.
