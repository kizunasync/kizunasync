---
title: Conflict resolution
description: How server-arrival and HLC modes reconcile masked column updates, deletes, and rejected writes.
status: alpha
docType: concept
audience: app-developer
---

# Conflict resolution

Kizuna resolves writes in your [Postgres](https://grokipedia.com/page/PostgreSQL) database. The default is [column-level last-writer-wins](../resources/glossary.md#column-last-writer-wins-column-lww) ordered by server arrival, and a table can instead use [Hybrid Logical Clock](../resources/glossary.md#hybrid-logical-clock-hlc) (HLC) values as the per-column ordering key. In both modes the server returns an explicit `applied` or `rejected` [verdict](../resources/glossary.md#verdict), and the client reconciles its optimistic local state from that verdict.

## Column masks

The keys of a mutation's `columns` object are its mask. An update writes only those columns, so two concurrent updates that name different columns can both survive.

![Sarah's phone and David's tablet push masked updates to one todos row: edits to different columns both survive, and when both edit the title, the later arrival holds the column.](/docs/images/conflict-columns.svg)

The mask decides which columns a write touches, not whether the write happens at all. A masked update is turned away all the same by a [tombstone](../resources/glossary.md#tombstone), by a Row Level Security policy, by a failed precondition, by a database constraint, or by HLC ordering. Every row write runs under the calling user's own policies, which Supabase documents in [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Arrival mode

`arrival` is the default. A table uses it unless you set the table's [`conflict`](../reference/javascript/define-config.md#parameters) option to `'hlc'`, which [`kizunasync init`](../cli/cli.md#kizunasync-init) provisions as the `conflict_mode` column in [`kizunasync._config`](../reference/sql-pack.md#kizunasync_config). Postgres decides the order: when two accepted writes touch the same column, the write that arrives later holds the column, and device wall clocks are never read.

Both mutations come back `applied`, because each one was valid when the server processed it. A push verdict reports whether that write applied. The device whose value was overwritten learns the current value on a later pull.

## HLC mode

Set the table's `conflict` option to `'hlc'`. Choose that mode when you want origin order preserved across offline clients and you can trust device clocks inside the drift bound.

The server then compares each masked column against the HLC stored for that column. Before the comparison, the [SQL pack](../resources/glossary.md#sql-pack) clamps the physical part of the incoming HLC to server time plus a five-second skew bound, so a device with a far-future clock cannot hold a column indefinitely. The comparison runs over the clamped timestamp, then the logical counter, then the node identifier.

Each device mints its own stamp, wire-formatted `<rfc3339 millisecond>|<counter>|<node>`. A write pairs the later of the device's wall clock and the physical time it last kept, and advances the counter instead when that physical time does not move, so two writes from one device never share a stamp even when they land in the same millisecond, and a clock that steps backward never regresses the stamp either. A kept physical time found more than an hour ahead of the device's own clock is read as a fault and discarded rather than carried forward on every later write. The device keeps its last stamp across a restart, and a filtered call such as `update(values).eq('id', targetId)` stamps every row it matches the same way a single-row `apply` does, so a broad update is fully ordered too. Only a table set to `hlc` mints a stamp at all; a write to an `arrival` table carries none.

A column wins when it carries no stored HLC or when the incoming clamped value compares greater. Winning columns are written and their new HLC is recorded; losing columns keep the value they already had. When every masked column loses, the mutation is rejected with `SUPERSEDED` and the current server row as your account can read it. A mutation that also carries transforms is the exception: the losing assigns are dropped, the transforms apply regardless, and the verdict is `applied`. When at least one column wins, the verdict is `applied`.

HLC mode changes the ordering key and nothing about authorization. A mutation that reaches an `hlc` table carrying no HLC fails loudly. Tombstones, policies, preconditions, and database constraints run around the write exactly as they do in arrival mode.

## Deletes

A delete removes the row and leaves a [tombstone](../resources/glossary.md#tombstone) keyed by table name, primary key, and the [bucket](../resources/glossary.md#bucket) value the row left. The tombstone check runs early in the per-mutation decision, right after the table's own configuration gate, so a later mutation for that same pair is rejected before the precondition and row-write steps run. The verdict it gets depends on what the caller already synced: `DELETE_WINS` with `server_row: null` when the caller had already pulled a live copy of that bucket, or `RLS_DENIED` with `server_row: null` otherwise, so a verdict never confirms a deleted primary key the caller never received. The client drops its optimistic row on either reason.

Tombstones are kept for the table's retention window, 30 days by default. Once reaping removes them, a pull whose transfer started from a checkpoint below the reap watermark receives [`CHECKPOINT_EXPIRED`](../reference/protocol.md#lifecycle-signals) and rehydrates rather than continuing from a delete history reaping has already discarded. The server reads that start from the [cursor](../resources/glossary.md#cursor), so a transfer from the beginning always completes. The no-resurrection property holds for a device that syncs inside that window.

Declare a table's [`softDelete`](../reference/javascript/define-config.md#parameters) column and the engine refuses `op: 'delete'` for that table, pointing you at an update that sets the column instead. Marking a row with that flag is an ordinary masked update, so it takes the conflict order of its table, writes no tombstone, and a later accepted update can reverse it.

## Validation rejections

A rejected mutation comes back with one [reason code](../reference/protocol.md#rejection-reasons) and, when the row is readable, the current server row. A mutation is one unit, so a rejected one leaves no effect on the server: none of its columns or transforms apply, and only the recorded verdict persists.

| Reason | Meaning |
|---|---|
| [`RLS_DENIED`](../reference/javascript/rejections.md#returns) | The caller's policy did not permit the row operation, an update or delete affected no policy-visible row, or a deleted row's bucket was never synced to this caller |
| `COLUMN_DENIED` | The mutation wrote a column the caller's role may not update, under [column-level privileges](../reference/sql-pack.md#column-level-privileges) |
| `PRECONDITION` | At least one expected column value did not match the current policy-visible row |
| `CONSTRAINT` | A class-23 integrity constraint, a class-22 data exception, or an app trigger's bare `RAISE EXCEPTION` raised while the mutation was applying |
| `SUPERSEDED` | In HLC mode, every masked column lost its HLC comparison |
| `DELETE_WINS` | The row's latest change is a removal, and the caller already synced a live copy of the bucket it was removed from |

`server_row` is read through the caller's SELECT policy. It carries a row when you may read it but not write it, narrowed to the columns you may read, and it is `null` when the row is deleted or hidden from you, `SUPERSEDED` included. The client replaces its local row with the columns it receives, and deletes that row when `server_row` is `null`. A rejected write therefore never becomes a way to read a row you are not allowed to see.

Those six reasons are the whole vocabulary. The engine replays the shared conflict corpus, and a verdict carrying any other reason fails loudly with `UNKNOWN_VERDICT_REASON` and leaves local state untouched. [A local write is rejected and compensated](../operations/troubleshooting.md#a-local-write-is-rejected-and-compensated) reads the same outcome from the user's side of the screen.

## Conflict history

The SQL pack can keep the values an accepted write overwrote. Turn on a table's [`conflict_journal`](../cli/configuration.md#kizunasync_config) setting and each changed column's previous non-null value is recorded on the server in [`kizunasync._conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal), together with the winning mutation and the conflict mode. The setting is off until you enable it, and a write that lands on no prior row records nothing.

Those entries travel back with your data. A pull attaches them as an optional `conflicts` array, matched to rows in the page it delivers, and leaves the field out when there is nothing to report. The engine stores what arrives in `_kizunasync_overwrites` and emits `COLUMN_OVERWRITTEN`.

A device sees an overwritten value through the pull path. Authenticated callers have no `SELECT` on the journal table itself, and `service_role` reads the audit rows.

The client side survives the event that carried it: [`kizunasync.overwrites()`](../reference/javascript/overwrites.md) reads the same rows back, newest first, until [`dismissOverwrite(id)`](../reference/javascript/dismiss-overwrite.md) acknowledges each one, and [Reset](../reference/javascript/reset.md) clears the journal along with everything else. Each row carries `winnerSeq`, the changelog sequence of the winning write.

## Model boundary

Two writes that name the same column resolve to one value: one replaces the other, because Kizuna provides no same-column multi-value merge or [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type) semantics. Where a column is a counter or a set, the `increment`, `arrayUnion`, and `arrayRemove` transforms apply a delta rather than an assign, and [Collaborative fields](./collaborative-fields.md) covers them. The [conflict journal](../resources/glossary.md#conflict-journal) does not record transforms.

Client-side recovery of an overwritten value is not part of the model. The conflict journal above is the server-side alternative, and it has to be on for the table before a device sees what a write replaced.

Cross-row and cross-user invariants are decided when a mutation reaches Postgres. Offline enforcement of global uniqueness, inventory, balance, and other coordinated invariants sits outside the model, and the [Consistency model](./consistency-model.md) lists the rest of what the model does not provide.

## Related pages

- [Consistency model](./consistency-model.md)
- [Sync rules & buckets](./sync-rules-and-buckets.md)
- [Collaborative fields](./collaborative-fields.md)
- [Server-side validation](./server-side-validation.md)
- [Offline writes](./offline-writes.md)
- [Protocol overview](./protocol-overview.md)
- [Protocol reference](../reference/protocol.md)
