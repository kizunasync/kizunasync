---
title: Design trade-offs
description: The deliberate costs behind Kizuna's conflict, cursor, validation, and transport choices.
status: alpha
docType: concept
audience: app-developer
---

# Design trade-offs

Kizuna favors a small server-authoritative protocol over peer-to-peer merge machinery. Integration with [Postgres](https://grokipedia.com/page/PostgreSQL) and Row Level Security stays predictable. The cost falls on freshness, synced-write commit throughput, offline invariants, and same-column conflict fidelity. Each section below names one choice, then the cost the project accepted for it.

## Server arbitration instead of general CRDT merge

The default conflict rule is [column-level last-writer-wins](./glossary.md#column-last-writer-wins-column-lww) at a single Postgres arbiter. Updates that name different columns can all survive, and two accepted writes to the same column end with one value. Application rows stay ordinary Postgres rows, so the [policies](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) and constraints you already wrote decide whether a write may commit, exactly as Supabase documents them for any table.

The cost is that Kizuna does not preserve every concurrent edit. Rich text, ordered sequences, and shared canvases need an operation-aware data type inside the field itself, and row sync does not supply one. [Collaborative fields](../sync/collaborative-fields.md) covers the counters, sets, and insert-only child tables that fit inside this model, and [Conflict resolution](../sync/conflict-resolution.md#model-boundary) states the boundary. [Comparison with alternatives](./comparison-with-alternatives.md) sets this choice next to the sync libraries that merge on the client.

## Server arrival instead of device time

`arrival` mode never reads a device wall clock, so a phone set far into the future cannot make its value unbeatable. The trade-off is that network order can differ from authoring order.

The opt-in [`hlc`](./glossary.md#hybrid-logical-clock-hlc) mode chooses origin order per column and clamps far-future physical time to server time plus five seconds. That tracks authoring order more closely, at the price of clock metadata on every row and a partial-win outcome that is harder to reason about. It cannot prove that an untrusted client reported an honest time. [HLC mode](../sync/conflict-resolution.md#hlc-mode) works through the comparison, and the table's [`conflict`](../reference/javascript/define-config.md#parameters) option turns it on.

## Fixed strategies instead of arbitrary resolver code

The SQL pack implements arrival order, HLC order, delete-wins, preconditions, RLS, and integrity-constraint rejection. It runs no application-supplied resolver function inside the sync path.

Customization is narrower for it, and convergence and rejection behavior stay inside a closed set that the corpus can replay. Application-specific invariants remain database policies, constraints, or transactions rather than merge callbacks nobody can test from the outside. [Server-side validation](../sync/server-side-validation.md#mutation-decision-order) gives the order in which those gates run.

## Optimistic offline state instead of offline global invariants

Local writes are visible before the server has evaluated them, which is what makes an application usable with no network. It also means uniqueness, inventory, balance, and cross-user authorization cannot be settled at local write time.

Postgres decides those invariants on push. A rejected mutation is compensated locally and surfaced to the app, so the optimistic state is provisional rather than a promise that the remote write must later succeed. The last seat and the account balance are decided when the write reaches the server, and your UI has to be ready to show a refusal. [Offline writes](../sync/offline-writes.md#3-handle-a-rejection) shows how the refusal reaches the screen.

## Commit-time sequence numbers instead of write-time ones

Change tracking numbers a change when its transaction commits, one committing transaction at a time. `pull` can then advance the [cursor](./glossary.md#cursor) to the largest sequence number its snapshot sees, because a transaction that commits later always draws a higher number. An open transaction holds back no other commit, and the ledger never hands out a bookmark past a change still being written.

The cost falls on writes. Transactions that change synced tables run their commit steps one at a time, including the flush of the write-ahead log, so synced-write commits per second have a ceiling that depends on the disk's flush latency. Transactions that touch no synced table are unaffected.

The reference oracle also models a refined cursor that carries holes and delivers above a gap. That is not the behavior the current SQL pack emits, and [Fencing and horizons](../sync/fencing-and-horizons.md#flat-and-composite-cursors) keeps the two apart.

## Outbox rebase at a completed pull

A pull boundary is the point where the last page of a pull has arrived. At that boundary the engine commits the staged [checkpoint](./glossary.md#checkpoint), even when the [outbox](./glossary.md#outbox) holds mutations. It then replays those mutations in first-in, first-out order inside the same local transaction. Read-your-writes is the guarantee that a device still sees its own pending edits. It survives as an overlay on the pulled rows rather than as a rule that hides remote rows, so a stuck outbox never delays independent remote changes.

The cost falls on the contested column. Once the pending mutation pushes, a later server assign wins regardless. A pulled [tombstone](./glossary.md#tombstone) stays deleted, and a pending local update does not bring the row back. The `increment`, `arrayUnion`, and `arrayRemove` transforms are arrival-ordered deltas rather than [CRDTs](https://grokipedia.com/page/Conflict-free_replicated_data_type).

## Doorbell plus polling instead of an authoritative stream

Realtime carries a [wake-up](./glossary.md#wake-up) hint that a pull may find data, and the client discards the payload. Correctness therefore lives in one place, the pull protocol, and dropped or duplicated hints are harmless. Supabase documents the mechanism itself under [broadcast from the database](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database).

The cost is latency. When a subscription fails, a change waits for the next pull opportunity instead of arriving at once. The deployed `kizunasync:<table>` and `changed` spelling is current behavior rather than a frozen protocol contract, as [Protocol decisions](./protocol-decisions.md#deployed-but-not-frozen) records.

## Storage outside row sync

Attachment references and metadata synchronize as row data, and object bytes go through Supabase Storage. Large binaries stay out of the JSON pull and push messages, and `ITransfer` can implement either a [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) or a [resumable one](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) behind the same port.

The trade-off is a second lifecycle. Upload, integrity confirmation, peer download, and orphan cleanup each complete at their own moment, later than the row mutation that named the file. The current adapter implements the resumable path. Repository tests do not support a universal crash-resume claim across every platform and live service configuration.

## Privileged wrappers with RLS-constrained row helpers

The five public SQL functions are [`SECURITY DEFINER`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker), so authenticated callers never get direct access to Kizuna's private ledgers. Those functions delegate every application-row operation to helpers owned by `kizunasync_rls`, a role that cannot [bypass RLS](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security).

The cost is a second ownership level to keep correct: the wrappers own the private ledgers and `kizunasync_rls` owns every application-row operation, and a change to either has to preserve the split. [Architecture](./architecture.md#the-server-data-path) draws the whole path.

## Executable protocol evidence instead of universal platform evidence

The [conformance corpus](./glossary.md#conformance-corpus) provides canonical schemas, transcripts, a reference server, and cross-engine cases. It is strong evidence for the wire behavior it models.

By itself it says nothing about browser locking, filesystem durability, device lifecycle, live Supabase configuration, or process-kill recovery. Those claims need their own physical test lanes, and no standalone third-party driver test compatibility kit is packaged. [Match the test to the claim](../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) pairs each suite with the claim it supports.

## Related pages

- [Consistency model](../sync/consistency-model.md)
- [Conflict resolution](../sync/conflict-resolution.md)
- [Drivers and the TCK](../reference/drivers-and-tck.md)
- [Fencing and horizons](../sync/fencing-and-horizons.md)
