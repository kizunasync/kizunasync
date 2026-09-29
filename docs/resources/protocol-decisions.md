---
title: Protocol decisions
description: Which protocol choices are settled, which are deployed but not frozen, and which remain open.
status: alpha
docType: concept
audience: app-developer
---

# Protocol decisions

Kizuna records wire choices separately from implementation status. A behavior can be deployed without its bytes being frozen, and the [conformance corpus](./glossary.md#conformance-corpus) can execute a model that the current SQL pack does not emit. The register that holds every entry, its status, and its rationale is [`packages/protocol/decisions/`](../../packages/protocol/decisions). This page restates those entries in the words the rest of the documentation uses.

## Settled wire choices

These decisions carry the status `decided`, and each one has executable schema or corpus coverage:

- `pull` names its page cap `limit`; pagination counts rows and tombstones against the same cap and closes with `has_more: false`. A page also stops once the server has examined a configured number of candidate rows, withheld ones counted the same as delivered ones, and a request naming more than 64 bucket entries is refused before any gate runs.
- A [bucket](./glossary.md#bucket) is `{ table, params }`, and parameter equality narrows the selection under the caller's [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) policies. A write that changes a row's bucket value leaves a tombstone for the value it left, in the same commit and at a lower sequence than the write itself, so a device that pulls only the old value still receives the removal.
- A tombstone reaches only a caller who already pulled a live row of the bucket value it left; naming a bucket value for the first time carries none of its past deletions. The server tracks that per user, table, and bucket value, and a push that decides a delete answers with the same grant: `DELETE_WINS` for a caller who holds it, `RLS_DENIED` with no row for one who does not.
- A replayed `mutation_id` answers only the user who pushed it, with the recorded kind and reason and a `server_row` rendered again under that user's current policies; any other caller gets `RLS_DENIED` with no row and nothing is recorded a second time. The ledger keeps no row copy of its own.
- Both `pull` and `push` may carry an optional `client_id`. When the key is absent the server falls back to the [JWT](https://grokipedia.com/page/JSON_Web_Token) `session_id` claim.
- Pull response keys, lifecycle signals, and a page of data do not mix: a signal carries empty rows and tombstones.
- The [cursor](./glossary.md#cursor) is opaque text. `"0"` bootstraps. Drivers must not parse it or coerce it through a JSON number.
- Fencing is the Postgres visibility horizon. The SQL pack numbers each change when its transaction commits, one committing transaction at a time, and a pull advances the cursor to the largest sequence number visible in its snapshot. An open transaction has no number, so it holds back no other commit. A finite overlap window is not the contract, because a transaction that outlives the window can still be skipped.
- Verdicts correlate by request order and by `mutation_id`. Rejection reasons are the closed union `PRECONDITION`, `RLS_DENIED`, `COLUMN_DENIED`, `CONSTRAINT`, `DELETE_WINS`, and `SUPERSEDED`. An absent or hidden row reports `RLS_DENIED`, not `CONSTRAINT`. A write to a column the caller's role may not update reports `COLUMN_DENIED`, narrowed to the columns the caller may read, rather than `RLS_DENIED`. `CONSTRAINT` covers a class-23 integrity violation, a class-22 data exception, or a bare `P0001` an app trigger raises, whichever is caught while the mutation's row is applied; only that mutation is rejected.
- An atomic batch aborts with one `batch` outcome. No sibling mutation commits.
- Both calls carry `schema_version`. A stale client gets `RESET_REQUIRED` before any mutation.
- Field transforms ride `update` as an optional `transforms` slot. They are not a fourth `op`.
- Conflict-journal visibility is an optional pull `conflicts` array, omitted when empty. `conflict/004` pins the bytes. Authenticated clients hold no `SELECT` on `_conflict_journal`. The engine keeps the ids of the mutations it pushed and saw applied, and neither persists nor emits an overwrite event for a conflict its own mutation won.
- At a closed pull the client publishes the checkpoint and rebases the outbox in the same local transaction. Checkpoint hold-back is not part of the protocol.
- Attachment object bytes stay outside pull and push. Confirm and vacuum are metadata operations around Storage objects.
- The engine event vocabulary lists only events an engine raises.
- A transcript may name a table's `soft_delete_column` and a `local` step may name the error the client must raise.
- A table provisioned with a bucket column refuses an unscoped pull with the pull-policy error `KZL01`, raised before the server builds a page. Tombstones stay bucket-scoped for that table, and table-scoped for a table with no bucket column.

## Resolved outside row-sync bytes

Attachment confirm and vacuum live in the SQL pack and the transfer port uses them. Those operations are not pull/push transcript bytes.

## Deployed but not frozen

The current Supabase adapter and SQL pack do things the register has not frozen as protocol bytes:

| Surface | What ships | What is not frozen |
|---|---|---|
| Wake-up | Private `kizunasync:<table>` topics, event `changed`, payload discarded | Channel name, event, and payload |
| Transport errors | Adapter classifies SQLSTATE 22/23/42 (except `42501`, which stays retryable) plus `P0001` and `0A000` as permanent | A portable error-code vocabulary |
| Cursor holes | SQL emits a flat high-water mark and still honors a composite cursor; the reference oracle may emit composite holes | That the SQL pack must emit holes |

## Blocked decisions

| Id | Question |
|---|---|
| `D-dedup-storage-model` | How `_clients.last_mutation_id` relates to per-mutation `_verdicts` storage |
| `D-base-hint` | Shape and semantics of `base_hint` |
| `D-wakeup-channel` | Wake-up channel and payload |
| `D-transport-error-codes` | Portable transient and permanent transport error codes |

`open` means no conformant bytes may be inferred for the missing choice. The surrounding code still runs and the corpus covers it. The missing piece is a spelling nobody has agreed on.

## Status meanings

| Decision status | Meaning in the register |
|---|---|
| `decided` | The choice is ratified and its spelling is fixed |
| `open` | Required information is missing, and neither the implementation nor the documentation may invent it |
| `superseded` | A later record replaces this one; the id still resolves |

These three statuses describe a wire choice. Alpha, Beta, and Production describe product maturity, and [Status taxonomy](../reference/status-taxonomy.md) keeps that second vocabulary.

## Related pages

- [Protocol overview](../sync/protocol-overview.md)
- [Protocol reference](../reference/protocol.md)
- [Fencing and horizons](../sync/fencing-and-horizons.md)
- [Status taxonomy](../reference/status-taxonomy.md)
