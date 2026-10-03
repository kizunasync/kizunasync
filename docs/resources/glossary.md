---
title: Glossary
description: Canonical definitions for Kizuna sync, protocol, storage, and maturity terms.
status: alpha
docType: reference
audience: app-developer
---

# Glossary

Each entry gives the definition first, then the detail that decides behavior, then the page that covers it in full.

## App client

An app client is the typed API application code calls. JavaScript uses [`createKizunaSync`](../reference/javascript/initializing.md), and Swift and Kotlin use `KizunaSyncClient` over UniFFI. App clients are peers rather than layers over one another. `selectEngine` exists only inside the JavaScript app client, and no public Rust app client exists, because the kernel is embedder SPI.

## Bridge

A bridge is the language crossing in front of the kernel: [UniFFI](https://mozilla.github.io/uniffi-rs/) (`kizunasync-ffi`) serves Swift, Kotlin, and [React Native](https://reactnative.dev), [N-API](https://nodejs.org/api/n-api.html) (`kizunasync-napi`) serves Node and [Bun](https://bun.sh), and [WebAssembly](https://grokipedia.com/page/WebAssembly) (`kizunasync-wasm`) serves the browser worker. A bridge carries JSON plus a handle and adds no behavior of its own, which is what distinguishes it from an app client. [Repository layout](./repository-layout.md#three-layers) places all three bridges in the tree.

## Bucket

A bucket is the pull scope for one table, written as `{ table, params }`. A sync bucket is not a [Supabase Storage](https://supabase.com/docs/guides/storage) bucket: a Storage bucket holds attachment objects, and a table names one in its `attachments` map. Parameter equality narrows which rows a pull selects. The caller's [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) policies stay the authorization boundary, so a bucket never grants access to a row Supabase would otherwise hide. [Sync rules and buckets](../sync/sync-rules-and-buckets.md#3-choose-the-right-bucket-helper) covers the authoring helpers.

## Causal+ (to checkpoints)

Causal+ to checkpoints is the consistency claim Kizuna makes: a device reads its own writes, never slides backwards through committed checkpoints, and converges with other devices on the same RLS-visible rows after a successful sync. Remote pages become visible only when a pull checkpoint commits. The claim is not [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type), not real-time, and not unqualified conflict freedom. [Consistency model](../sync/consistency-model.md#the-four-session-guarantees) states each guarantee with its limits.

## Checkpoint

A checkpoint is the local transaction boundary at which staged pull pages become visible and the final cursor is saved. Rows, tombstones, cursor state, staging cleanup, and the FIFO replay of any pending outbox commit together, so a pulled batch appears in one step rather than row by row. The saved cursor is a checkpoint token, and the continuation pages of the next transfer carry it as their start, which `CHECKPOINT_EXPIRED` checks. [Checkpoints](../sync/consistency-model.md#checkpoints) states the guarantee that rests on that boundary.

## Column last-writer-wins (column-LWW)

Column-LWW is how concurrent edits to one row are resolved: each column is decided independently, by server arrival order (`arrival`) by default or by opt-in origin [HLC](#hybrid-logical-clock-hlc) order, and delete-wins bounds both modes. Independent columns can both survive, and the same column does not merge, which [Conflict resolution](../sync/conflict-resolution.md) covers in full.

## Conflict journal

The conflict journal is an optional server-side record of the values a write replaced. The `_conflict_journal` table records overwritten column values that were not null, for successful writes on tables whose `conflict_journal` column is on. That column is off by default. Pull may attach matching rows as an optional `conflicts` array, and it omits the array when empty. Clients persist `_kizunasync_overwrites` and emit [`COLUMN_OVERWRITTEN`](../reference/protocol.md#server-side-conflict-journal). Authenticated callers hold no `SELECT` on the table, and `service_role` reads the audit rows. [Conflict history](../sync/conflict-resolution.md#conflict-history) shows the path from write to journal row.

## Conformance corpus

The conformance corpus is the recorded set of protocol exchanges every implementation is replayed against: the JSON Schemas, canonical transcripts, manifest, structural invariants, reference server, and replay runners under [`packages/protocol`](../../packages/protocol). It is the oracle for row-sync wire behavior. By itself it proves nothing about live [Postgres](https://grokipedia.com/page/PostgreSQL) behavior or a driver's physical durability, a separation [Match the test to the claim](../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) keeps explicit.

## Consistency horizon

The consistency horizon is the server-side boundary beyond which a pull must not advance its cursor. In the SQL pack, a pull takes one snapshot, and the page that closes the checkpoint returns the largest sequence number visible in it as a flat cursor; the pack still honors a composite one. That number is safe because the pack draws each sequence number when the writing transaction commits, so no later commit can land below it. The refined reference oracle can instead deliver above an in-flight gap and keep that gap in a composite cursor. [The live SQL horizon](../sync/fencing-and-horizons.md#the-live-sql-horizon) works through both.

## Cursor

A cursor is an opaque text token recording how far a client has read in the server's global change history: `"0"` bootstraps a client, flat tokens are decimal high-water marks, and composite tokens take the form `<high-water>~<hole>.<hole>`. A page cut by the limit returns a continuation token, `<start>:<position>`, whose start is the checkpoint the transfer began from, so expiry is judged by that checkpoint rather than by the page. Clients store and replay the token verbatim and read nothing into its shape, which is what lets the server change its encoding. [Cursor grammar](../reference/protocol.md#cursor-grammar) documents what the server produces.

## Dead letter

A dead letter is a mutation removed from the outbox after it, alone, has taken five consecutive remote failures explicitly classified permanent. A lone queued write or an atomic batch owns that budget outright; a wider non-atomic slice is never charged for a failure it cannot pin on one mutation, and the engine narrows it down to the write responsible first. The engine reverts the optimistic row to its pre-image, records the outcome, and emits [`DEAD_LETTER`](../reference/protocol.md#exactly-once-effect-and-dead-letters). Retryable and unclassified failures never consume that budget, so a long stretch with no network does not dead-letter a write. [Dead letters and liveness](../sync/consistency-model.md#dead-letters-and-liveness) states what the engine promises afterwards.

## Driver

A driver is an adapter implementing one or more engine ports. Five do work: the store locator, protocol remote, file storage, attachment transfer, and engine transport. Three only hint, carrying no data and no correctness obligation of their own: wake-up, connectivity, and foreground. Wire-corpus conformance and platform qualification are distinct layers of evidence, which [What a driver needs beyond the corpus](../reference/drivers-and-tck.md#what-a-driver-needs-beyond-the-corpus) keeps apart.

## Fencing

Fencing is the transaction-visibility rule that stops a cursor from skipping a lower sequence whose transaction commits after a higher sequence has become visible. Without it, a client could save a position past a change it never received. [The late-commit race](../sync/fencing-and-horizons.md#the-late-commit-race) shows the interleaving.

## Hybrid Logical Clock (HLC)

A [Hybrid Logical Clock](https://grokipedia.com/page/Logical_clock) pairs a physical timestamp with a logical counter and a node identifier, so two writes stamped in the same instant have a determined order. It is the optional origin-order key that `hlc` conflict mode uses, and only a table set to that mode mints one; a write to an `arrival` table carries no HLC at all. In `hlc` mode the server clamps far-future physical time and compares HLCs per masked column, which [HLC mode](../sync/conflict-resolution.md#hlc-mode) covers.

## Kernel

The kernel is `SyncEngine` in `crates/kizunasync-engine`, and it owns apply, pull, push, query, outbox, and attachments. Language hosts reach it through a bridge, and application code never imports it. [Kernel and app clients](../getting-started/how-kizuna-works.md#kernel-and-app-clients) explains why the boundary is drawn there.

## Local store

The local store is the SQLite database on the device holding application rows, outbox state, cursors, staging tables, rejection records, and attachment-queue metadata. Kizuna application queries read this store instead of issuing remote SELECTs, which is what lets a read succeed with no network. [Your screen uses local SQLite](../getting-started/how-kizuna-works.md#1-your-screen-uses-local-sqlite) follows one query through it.

## Outbox

The outbox is the local table of mutations awaiting push. A row mutation and its outbox record are written in one local transaction, so a queued write and the row it produced always land together. That transaction is a property of the engine rather than a universal crash-durability claim for every driver and platform. [Offline writes](../sync/offline-writes.md#1-write-locally) shows the queue filling and draining.

## Product CLI (`kizunasync`)

The product CLI is the Rust binary built from `crates/kizunasync-cli`, and it provisions the SQL pack into a Supabase project. Readers invoke it as `npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, or `bunx kizunasync`, and `packages/kizunasync` is the published package, whose Node shim execs the binary. It is not an app sync client and never touches application rows on a device. [CLI](../cli/cli.md#commands) documents each command.

## Public RPC surface

The public RPC surface is the five authenticated SQL functions the current pack installs: `pull`, `push`, `attachment_confirm`, `attachment_metadata`, and `attachment_vacuum`. Only the first two carry row-sync traffic. [The public RPCs](../cli/whats-installed.md#the-public-rpcs) lists their signatures and grants.

## Pull

Pull is `kizunasync.pull`, one of the two row-sync RPCs. It returns RLS-visible latest row images, tombstones, an opaque cursor, pagination state, and an optional lifecycle signal. [Pull](../sync/protocol-overview.md#pull) walks one exchange end to end.

## Push

Push is `kizunasync.push`, the other row-sync RPC. It applies a mutation batch and returns per-mutation verdicts, an atomic-batch abort, or a stale-schema signal. [Push](../sync/protocol-overview.md#push) walks one exchange end to end.

## SQL pack

The SQL pack is everything Kizuna installs into the Supabase project you own, and no server of Kizuna's sits in the sync path. It is the Supabase migration that installs the `kizunasync` schema, private ledgers, public RPC wrappers, RLS-constrained row helpers, retention functions, attachment metadata, and Realtime policies. Provisioning a table then attaches tracking [triggers](https://supabase.com/docs/guides/database/postgres/triggers#creating-a-trigger) and configuration for that table alone. [SQL pack](../reference/sql-pack.md) gives every object its signature.

## Test compatibility kit (TCK)

A test compatibility kit is a packaged suite a third-party implementation runs to prove a defined compatibility contract. Kizuna has the shared protocol corpus and the engine and port harnesses, and it does not ship one standalone third-party driver kit as a single installable command. [Packaged driver TCK](./roadmap.md#packaged-driver-tck) tracks that gap.

## Tombstone

A [tombstone](https://grokipedia.com/page/Tombstone_%28data_store%29) is the retained record of a hard delete, carrying table, primary key, [bucket](#bucket) value, sequence, and deletion time. It propagates the deletion to a device that already pulled a live copy of the bucket the row left, and to no other. A later edit of the same row comes back rejected with [`DELETE_WINS`](../reference/protocol.md#rejection-reasons) for a caller who received it, and `RLS_DENIED` for one who did not. A cursor expires when the reaper removes the tombstones that cursor still needs. A client away longer than the retention window therefore rehydrates, instead of resuming from a delete history the server already reaped. [Deletes](../sync/conflict-resolution.md#deletes) covers the retention window.

## Verdict

A verdict is the server's result for one non-atomic push mutation: `applied`, or `rejected` with a closed reason and either an RLS-visible server row or `null`. An atomic batch returns a batch-abort envelope instead of sibling verdicts. [Rejection reasons](../reference/protocol.md#rejection-reasons) lists the closed set.

## Wake-up

A wake-up is a Realtime hint that a pull may find work, and it carries no row data. The deployed adapter subscribes to `kizunasync:<table>` for the `changed` event. Supabase documents that mechanism as [broadcast from the database](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database). The open wake-up channel and payload decision has not frozen that spelling. Wake-up data is never authoritative, so a missed hint costs latency alone. [Wake-ups](../sync/protocol-overview.md#wake-ups) states the client obligation.

## Related pages

- [Architecture](./architecture.md)
- [Repository layout](./repository-layout.md)
- [Consistency model](../sync/consistency-model.md)
- [Protocol reference](../reference/protocol.md)
- [Status taxonomy](../reference/status-taxonomy.md)
