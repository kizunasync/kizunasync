---
title: Protocol overview
description: How the pull and push protocol moves row state, verdicts, cursors, and lifecycle signals.
status: alpha
docType: concept
audience: app-developer
---

# Protocol overview

The row-sync protocol is the request and response contract between a Kizuna client and your [Postgres](https://grokipedia.com/page/PostgreSQL) database. It moves server row state one way and a decision about every local mutation the other, using two operations: [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull) downloads server state, and [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush) uploads local mutations.

Pull answers what changed after this position. Push answers what became of the writes the device made. The rest of the protocol is the vocabulary those answers use: an opaque cursor, a closed set of [verdict](../resources/glossary.md#verdict) reasons, and a short list of lifecycle signals.

The SQL pack also exposes three attachment metadata functions. Attachment bytes and their lifecycle are not part of the pull and push wire corpus.

## Pull

A [pull request](../reference/protocol.md#pull-request) carries [buckets](../resources/glossary.md#bucket), an opaque [cursor](../resources/glossary.md#cursor), a schema version, an optional limit, and an optional `client_id`. When that key is absent the server falls back to the authenticated [JWT](https://grokipedia.com/page/JSON_Web_Token) `session_id` claim.

A [pull response](../reference/protocol.md#pull-response) carries:

- The next opaque cursor.
- `has_more` keeps the [checkpoint](../resources/glossary.md#checkpoint) open while more work remains.
- The latest row images, ordered by `(seq, table, pk)`.
- [Tombstones](../resources/glossary.md#tombstone) in the same ordering domain.
- Either no signal or one typed lifecycle signal.

Each row is filtered twice: buckets narrow the requested scope, and the caller's policies remain the authorization boundary, which Supabase documents in [SELECT policies](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies). Kizuna runs each row read under those policies rather than around them, so a change that is hidden or out of bucket can advance the global cursor without its row image being returned.

Deletes are filtered by grant as well as by snapshot: a deleted primary key is delivered when its stored bucket snapshot matches the request params and the caller already pulled a live row of that bucket, and tables with no bucket stay table-scoped. A table provisioned with a bucket column refuses an unscoped pull with `KZL01` before the server builds a page. [Row Level Security](https://grokipedia.com/page/Row-level_security) cannot be replayed against a row that is gone, so a tombstone can reach a caller whose policies would have hidden the row itself, once that caller has received a live copy of it. Supabase covers writing those policies in [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).

Rows and tombstones travel as one stream in `(seq, table, pk)` order, and each page is the next part of that stream. A page holds at most `limit` entries, with rows and tombstones counted together, so a delete that comes first in the stream arrives on the first page like any row. The page that reaches the end of the stream returns `has_more: false` and closes the checkpoint, and that includes a page that ends with exactly `limit` entries. Every other page carries the first `limit` entries that remain, returns `has_more: true`, and points its cursor at the last entry it carried.

When pagination spans several responses the engine stages the pages. The closing response lets it commit the staged rows and tombstones, the final cursor, the staging cleanup, and a first-in-first-out replay of the pending [outbox](../resources/glossary.md#outbox) in one step. It commits that way even when the outbox is not empty. [`pullOnce()`](../reference/javascript/pull-once.md) runs one page of that sequence, and [Swift: Pull once](../reference/swift/pull-once.md) and [Kotlin: Pull once](../reference/kotlin/pull-once.md) run the same page on native.

## Push

A [push request](../reference/protocol.md#push-request) carries a batch, the last-mutation watermark, a schema version, and the same optional `client_id`. Each mutation contains a [UUID](https://grokipedia.com/page/Universally_unique_identifier) [idempotency](https://grokipedia.com/page/Idempotence) key, a table, a primary key, an operation, and a `columns` map whose keys form the conflict mask. An `update` may also carry [`transforms`](../reference/javascript/using-transforms.md) for [`increment`](../reference/protocol.md#transforms), `arrayUnion`, and `arrayRemove`. Preconditions and [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) values are optional, and `base_hint` is accepted by the schema with no decided meaning.

A successful non-atomic [push response](../reference/protocol.md#push-response) holds one verdict for each mutation in request order:

- `applied` means the effect committed; or
- `rejected` carries one of the closed reasons and an RLS-visible server row, or `null` when no row may be returned.

The closed [rejection reasons](../reference/protocol.md#rejection-reasons) are `RLS_DENIED`, `COLUMN_DENIED`, `DELETE_WINS`, `PRECONDITION`, `CONSTRAINT`, and `SUPERSEDED`. An unknown verdict kind or reason fails the engine loudly rather than picking a compensation path the client does not recognize.

An atomic batch fails on a different arm. The first rejected mutation rolls the batch subtransaction back, and the response holds one `batch` object with outcome `aborted`, the offending mutation id, the reason, and the server row, so no sibling mutation's effect commits.

An optional per-table [`conflict_journal`](../cli/configuration.md#kizunasync_config) records overwritten values in [`kizunasync._conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal), and it stays off until you turn it on. A pull of the winning row may carry those losers in an optional `conflicts` array, which the server omits when it has nothing to report. The engine persists `_kizunasync_overwrites` and emits `COLUMN_OVERWRITTEN`. Authenticated clients have no direct `SELECT` on the journal table, and `service_role` reads the audit rows.

[Swift: Push once](../reference/swift/push-once.md) and [Kotlin: Push once](../reference/kotlin/push-once.md) run one native push round.

## Retry semantics

Transport delivery is at least once, so the same push can arrive twice. Each mutation carries a UUID, and the server keeps a verdict ledger keyed on it. A byte-identical replay therefore returns the recorded result instead of applying the mutation a second time, which makes the effect exactly once. How the client registry's `last_mutation_id` relates to per-mutation verdict storage remains open. The conformance case fixes the observable outcome without settling the storage model, as [Exactly-once effect and dead letters](../reference/protocol.md#exactly-once-effect-and-dead-letters) records.

A rejection is a decision the server made about one write, and a network failure is no decision at all, so a remote failure is never a verdict. Only a failure the adapter classifies permanent consumes the engine's [dead-letter](../resources/glossary.md#dead-letter) budget, while retryable network, timeout, authentication, 5xx, and unclassified failures keep the mutation queued. A portable error-code vocabulary shared across transports is not settled, so these codes describe the current adapters rather than the wire.

## Conflict and validation

In the default [`arrival` mode](./conflict-resolution.md#arrival-mode), accepted writes to the same column resolve by server arrival order. Accepted writes to different [column masks](./conflict-resolution.md#column-masks) can both survive. In [`hlc` mode](./conflict-resolution.md#hlc-mode) the server compares the clamped origin clock per column and rejects the mutation as `SUPERSEDED` when every masked column loses.

Before a row effect commits, the SQL path checks the table's own configuration, a tombstone or a delete already queued for the row, Row Level Security, an optional precondition, and database constraints, in that order. The pack catches a class-23 integrity failure, a class-22 data exception, or a bare `P0001` an app trigger raises around the individual mutation and returns it as `CONSTRAINT`, so one failing mutation does not necessarily fail the rest of a non-atomic push. A mutation is one unit: a rejected verdict leaves no effect, and only the recorded verdict persists.

The public `pull` and `push` wrappers are `SECURITY DEFINER`, because they touch private Kizuna ledgers. That is the mode Supabase contrasts with invoker rights in [Database functions](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker). A client reaches the wrappers as ordinary Postgres functions through [`rpc`](https://supabase.com/docs/reference/javascript/rpc). The wrappers delegate every application-row operation to helpers owned by `kizunasync_rls`, a role that is `NOBYPASSRLS`, so the caller's JWT-backed policies decide row visibility and writes. [Server-side validation](./server-side-validation.md) walks that boundary and the decision order.

## Cursors and fencing

Every tracked row change and tombstone takes a position in one global sequence. A number drawn before its transaction commits could land below a position a pull has already passed, so the SQL pack [fences](../resources/glossary.md#fencing) the cursor by drawing each number when the writing transaction commits, one committing transaction at a time.

A pull takes one snapshot and advances the cursor to the largest sequence number visible in it, because no later commit can land below that number. An open transaction has no number yet, so it never holds back other commits. The page that closes the checkpoint returns that number as a flat decimal cursor, and the pack still honors a composite one. A page cut by the limit returns a continuation cursor that also names the checkpoint its transfer started from. The cost falls on writes: transactions that change synced tables commit one at a time, which caps their commit rate at a ceiling that depends on the disk's flush latency.

The reference oracle implements the refined form, which sees in-flight effects in memory, delivers rows above a gap, and records the gap as a hole in a composite cursor. It keeps `has_more: true` while that hole is open, even on the page that reaches the end of the stream. The client treats both token shapes as opaque text. [Fencing and horizons](./fencing-and-horizons.md) covers the mechanism and its costs, and [Cursor grammar](../reference/protocol.md#cursor-grammar) fixes the token shapes.

## Lifecycle signals

The two [lifecycle signals](../reference/protocol.md#lifecycle-signals) replace a page of rows. `CHECKPOINT_EXPIRED` means the checkpoint the transfer started from predates the retained delete history, so the incremental position is unusable and the engine rehydrates from scratch, the same rebuild [`reset()`](../reference/javascript/reset.md) forces by hand. The server checks the transfer's start, never the page it reached, so the rehydration from the beginning always completes.

`RESET_REQUIRED` means the request's `schema_version` is below the configured minimum. Pull returns an empty page carrying the signal. Push gates before any mutation, leaves the queued writes where they are, and returns the matching signal arm.

A non-null pull signal is exclusive with row and tombstone data and closes the page boundary, so a signal never arrives alongside a page of rows.

## Wake-ups

A Realtime [wake-up](../resources/glossary.md#wake-up) is a scheduling hint rather than a third sync operation. The deployed trigger and adapter send a private broadcast on `kizunasync:<table>` with event `changed`, and [`createRealtimeWakeup`](../reference/javascript/create-realtime-wakeup.md) discards the payload. Neither the channel spelling nor the payload is frozen, so treat them as current behavior rather than as a compatibility contract. A missed hint costs freshness alone, because the next pull finds the change anyway. Supabase documents the transport in [Broadcast from the database](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database), and the policies that gate a private channel in [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#how-it-works). Kizuna adds only the trigger that sends the hint, and it never treats an arriving message as data.

## Attachments

[`attachment_confirm`](../reference/sql-pack.md#kizunasyncattachment_confirm), [`attachment_metadata`](../reference/sql-pack.md#kizunasyncattachment_metadata), and [`attachment_vacuum`](../reference/sql-pack.md#kizunasyncattachment_vacuum) bring the authenticated public SQL surface to five functions. They manage caller-owned attachment metadata. Object bytes travel through Storage, using [standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads) at or below 6 MiB and [resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads) above it, and never appear in a pull or push transcript. [Media attachments](../attachments/media-and-attachments.md) wires that path in an app.

## Conformance boundary

Three lanes replay the corpus against the engine, and each of them executes the same 49 of the 50 manifest entries. `cargo run -p kizunasync-conformance` drives the Rust engine in process and reports `passed=49 failed=0 skipped_steps=1`. The transport lane in `packages/core/src/conformance/` drives the same engine through the [N-API](https://nodejs.org/api/n-api.html) addon on [Bun](https://bun.sh) and reports 49 passed with 1 skipped. The browser lane in `packages/web/conformance` drives that engine compiled to [WebAssembly](https://grokipedia.com/page/WebAssembly) inside the `@kizunasync/web` worker, and it asserts the identical 49 and 1. A browser-only divergence is therefore a finding about the engine on wasm rather than a case to skip.

A fourth lane covers the native hosts and is not the wire corpus. The Swift and Kotlin bindings replay the 24 shared scenarios in `crates/kizunasync-scenarios/scenarios.json` through the generated [UniFFI](https://mozilla.github.io/uniffi-rs/) surface, which checks the host wiring around the engine rather than protocol bytes.

The wake-up payload entry has no bytes to run. That evidence therefore covers the modeled protocol, and it is not a substitute for live SQL, driver, browser, device, or process-kill evidence. [Protocol evidence](../getting-started/status.md#protocol-evidence) scopes what the corpus establishes, and [Drivers and the TCK](../reference/drivers-and-tck.md) discusses it for third-party implementations. [Replay the protocol corpus](../operations/test-offline-behavior.md#4-replay-the-protocol-corpus) runs the client half of that corpus against your own engine.

## Related pages

- [Protocol reference](../reference/protocol.md)
- [Consistency model](./consistency-model.md)
- [Conflict resolution](./conflict-resolution.md)
- [Fencing and horizons](./fencing-and-horizons.md)
- [Protocol decisions](../resources/protocol-decisions.md)
