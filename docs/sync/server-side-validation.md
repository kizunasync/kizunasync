---
title: Server-side validation
description: How privileged bookkeeping wrappers preserve caller-scoped RLS and turn row validation outcomes into protocol verdicts.
status: alpha
docType: concept
audience: app-developer
---

# Server-side validation

Server-side validation is the layer that decides whether a queued mutation may change a row. It turns the answers your database already gives into one typed [verdict](../resources/glossary.md#verdict) per mutation, inside your own Postgres database rather than in a service sitting in front of it.

A device accepts a write while it is offline, long before anything can judge it. No local check stands in for a [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) policy, a constraint, or a trigger that runs in Postgres, so the sync layer runs them, classifies the outcomes it can classify safely, and refuses to invent the rest.

Mechanically that means three things: a privileged wrapper does the private bookkeeping, a role that cannot bypass Row Level Security does the application-row work, and every mutation walks a fixed order of gates whose outcome is written down for replay. Both entry points are Postgres functions the client calls through supabase-js, which Supabase documents in [Calling Postgres functions](https://supabase.com/docs/reference/javascript/rpc). Kizuna adds the two names, [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush) and [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull), and nothing about how `rpc` itself works.

## Security boundary

The five public [functions](../reference/sql-pack.md#functions) `kizunasync.pull`, `kizunasync.push`, `kizunasync.attachment_confirm`, `kizunasync.attachment_metadata`, and `kizunasync.attachment_vacuum` are `SECURITY DEFINER`, the mode Supabase contrasts with invoker rights in [Database functions](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker). That is what lets an authenticated caller use the API with no direct SELECT or DML rights on the private change, tombstone, verdict, cursor, and [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) ledgers.

The privilege stops at the bookkeeping. Pull and push delegate every application-row read and write to helpers owned by `kizunasync_rls`, a role that is `NOBYPASSRLS`, inherits the authenticated role's table privileges, and evaluates the original request [JWT](https://grokipedia.com/page/JSON_Web_Token). Your policies therefore constrain each row operation even though the outer wrapper is privileged. Supabase describes the privilege that would skip them in [Bypassing Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security), and the point of the delegation is that Kizuna's row helpers never hold it.

[Buckets](../resources/glossary.md#bucket) are selection filters under that boundary. A bucket narrows an RLS-visible set and cannot widen it, so naming a bucket never reaches a row your policies do not already allow. [Sync rules & buckets](./sync-rules-and-buckets.md#1-understand-the-two-layers) sets out the two layers side by side.

The attachment functions carry a different check, because they act on Kizuna metadata as their definer rather than on your tables: the owner segment of the Storage path must match [`auth.uid()`](https://supabase.com/docs/guides/database/postgres/row-level-security#authuid) before metadata is confirmed or removed. [Storage policies](../attachments/media-and-attachments.md#storage-policies) shows the Storage bucket policies that pair with it.

Two things a signed-in caller may see sit outside that RLS boundary on purpose. The Realtime [wake-up](../resources/glossary.md#wake-up) is a contentless broadcast on a `kizunasync:<table>` topic, and any authenticated caller may subscribe to it, whether or not their policies let them read that table's rows, so a doorbell reveals that some write landed on a table and roughly when, never which row or what changed. The pull [cursor](../resources/glossary.md#cursor) is a position in one project-wide change sequence rather than a count of the rows one caller received, so a caller's cursor advances past commits their policies hide, which reveals that a write happened somewhere in the project without revealing its table, row, or content. [Fencing and horizons](./fencing-and-horizons.md#what-the-cursor-counts) covers that boundary in full. A pull or push error message names the table and, for a bucketed table, the bucket column it names in `_config`, to every caller who can call the RPC, whatever their row-level access.

Two preconditions of your own keep the rest of this boundary true. Row Level Security has to be enabled on every synced table: `kizunasync_rls` carries no bypass, but a table with the feature turned off hands every row to any signed-in user regardless, which is why the CLI refuses to sync such a table unless you pass `--allow-no-rls`, and `kizunasync doctor`'s `rls-enabled` check finds one already synced this way. A trigger function you attach to a synced table needs a `search_path` of its own: a push applies its writes through the pack's definer helpers, which run with an empty `search_path`, so an unqualified name in your function fails the push that fires it, and `doctor`'s `trigger-search-path` check names the trigger and the fix.

A tombstone carries a residual of its own: a caller who already pulled a live row of the [bucket](../resources/glossary.md#bucket) it left goes on receiving that bucket's deletions even after losing access to it, because a grant is never revoked for age alone. Mark a table's removals with a [`softDelete`](../reference/javascript/define-config.md#parameters) column instead when its Row Level Security is finer than its bucket, so each removal travels as an ordinary row update under the caller's own policies. [Sync rules & buckets](./sync-rules-and-buckets.md#soft-delete) shows the column.

The stamp that numbers a change at commit is one advisory lock shared by every transaction that writes a synced table, so those transactions commit one at a time project-wide while the pack numbers them. A transaction that holds it a long time slows every other synced commit behind it, which is the availability cost of a boundary that never lets a cursor skip a write. [Fencing and horizons](./fencing-and-horizons.md#what-commit-time-numbering-costs) states what that costs in full.

## Mutation decision order

The push path evaluates one mutation through these layers, in this order:

1. The request-level schema and deployment-policy gates in [`kizunasync._settings`](../reference/sql-pack.md#kizunasync_settings) run before any mutation is processed, and the table itself must be one your project configured for sync.
2. An insert or update locks its row `for no key update` under the caller's own policies, and holds that lock to the end of the push. The lock finds no row when one is absent, hidden from the caller's SELECT policy, excluded by the UPDATE policy, or excluded by a missing column-level UPDATE privilege; a delete takes no lock.
3. The row's latest change is checked next, so a delete that committed while an insert or update waited on the lock is seen. The caller's own delete, already queued earlier in this same push, always answers `DELETE_WINS`. An existing [tombstone](../resources/glossary.md#tombstone) instead answers `DELETE_WINS` when the caller already holds a pull grant for the [bucket](../resources/glossary.md#bucket) the row left, or `RLS_DENIED` with no row otherwise, so a verdict never confirms a deleted primary key the caller never received. [Sync rules & buckets](./sync-rules-and-buckets.md#1-understand-the-two-layers) covers that grant.
4. The row is rendered for the response: the row the lock read when there was one, otherwise a fresh read through the caller's SELECT policy.
5. A mutation naming a column your role may not `UPDATE` returns `COLUMN_DENIED` here, narrowed to the columns you may read.
6. An optional precondition is compared against the rendered row, and the requested insert, update, delete, or HLC apply then runs through the RLS-constrained helper.
7. The resulting verdict is recorded in [`kizunasync._verdicts`](../reference/sql-pack.md#kizunasync_verdicts), so the same mutation id replayed later returns the same answer to the user who pushed it, and `RLS_DENIED` with no row to anyone else.

In a non-atomic batch that decision is isolated per mutation, and processing continues after a rejection. In an atomic batch the first rejection aborts the batch subtransaction and rolls back every sibling effect. Two batches that lock the same rows in opposite orders can deadlock; Postgres aborts one side with a retryable error, and the client's own push retry resolves it.

## Typed rejections

| Reason | Server condition | `server_row` |
|---|---|---|
| `DELETE_WINS` | The row's latest change is a removal, and the caller already holds a pull grant for the bucket it was removed from | `null` |
| `PRECONDITION` | An expected visible column value differs | The current row when SELECT permits it, otherwise `null` |
| `RLS_DENIED` | The row write lacks permission, an update or delete affects no RLS-visible row, or a removal reached a caller with no grant for the bucket it left | The current row when readable but not writable, otherwise `null` |
| `COLUMN_DENIED` | The mutation writes a column `authenticated` may not `UPDATE`, under [Column-level privileges](../reference/sql-pack.md#column-level-privileges) | The current row narrowed to the columns the caller may read |
| `CONSTRAINT` | The apply path raises a class-23 integrity constraint, a class-22 data exception, or a bare `P0001` an app trigger raises | The pre-write row when visible, otherwise `null` |
| `SUPERSEDED` | Every masked column loses in HLC mode | The current row, or `null` when the caller may not read it |

The server never performs a privileged row render to improve a rejection. A caller who cannot SELECT the row receives `null`, so a refused write cannot become a side channel for the row's existence or contents.

Those six reasons are the whole vocabulary, closed in [Rejection reasons](../reference/protocol.md#rejection-reasons). A rejected verdict tells the client to undo the local change it applied optimistically. On the server a mutation is one unit, so a rejected verdict leaves no effect: none of its columns, transforms, change-log entries, or overwrite-journal entries are written, and only the recorded verdict persists. The client then emits `MUTATION_REJECTED` through [`kizunasync.on`](../reference/javascript/on.md) and keeps the record readable through [`rejections()`](../reference/javascript/rejections.md). The engine fails loudly on an unknown reason rather than applying a compensation the protocol never defined.

## Constraints and triggers

The SQL implementation wraps the row apply in one boundary and catches three kinds of failure raised inside it: `integrity_constraint_violation`, the Postgres class that covers class-23 CHECK, foreign-key, unique, not-null, and equivalent validation errors; `data_exception`, the class-22 errors that cover a value your column type refuses, including a precondition value that will not cast; and exact `P0001`, the SQLSTATE Postgres's default `RAISE EXCEPTION` carries when a [trigger function](https://supabase.com/docs/guides/database/postgres/triggers#trigger-functions) names no code of its own. All three become `CONSTRAINT` for that mutation alone; its writes roll back, and the rest of a non-atomic batch still applies.

The golden transcripts, meaning the recorded request and response pairs in the corpus, induce one class-22 failure: the pack's own raise on an increment against a non-numeric column, in `increment/006`, `increment/009`, and `increment/010`. The transcript grammar has no column types and no app triggers, so the SQL lane covers the class-23 and `P0001` paths directly. `push/006-constraint-not-a-wedge` exercises an absent-row `RLS_DENIED`, and it exercises the continued processing of the next mutation, despite what its name suggests. That case is therefore no evidence that the pack turns a validation error into a `CONSTRAINT` verdict.

An error outside those three, and any error the pack raises before the row is reached, such as an unknown configured table or a malformed batch, escapes the mutation decision and fails the whole call rather than becoming a fabricated `CONSTRAINT` verdict. [Validate writes](./validate-writes.md) walks through both paths side by side.

Both remote adapters mark SQLSTATE classes 22, 23, and 42 as permanent, and they never retry a failure they mark that way. The two adapters are the [`createRpcRemote`](../reference/javascript/create-rpc-remote.md) adapter from `kizunasync/supabase` and the Rust HTTP remote in `kizunasync-remote-http`. They mark exact `P0001` and exact `0A000` the same way. Class 42 has one exception: `42501` stays retryable. Row-level refusals already come back as an `RLS_DENIED` verdict, so an HTTP `42501` means a missing grant, a missing JWT, or role `anon` instead. A single write, or an atomic batch, owns its own failure outright, and a permanent failure that repeats five times against it [dead-letters](../resources/glossary.md#dead-letter) that write; a wider non-atomic slice is never charged for a shared failure, and the engine narrows it to the one write responsible before the budget applies. Network loss, timeouts, authentication expiry, 5xx responses, and unclassified failures stay retryable and consume none of it.

That classification is not a frozen cross-transport code system. Another conforming transport cannot read portable wire codes out of the current implementations.

## Request-level outcomes

Some outcomes sit outside a mutation verdict entirely:

- A stale `schema_version` returns `RESET_REQUIRED`, one of the two [lifecycle signals](../reference/protocol.md#lifecycle-signals), before any mutation is processed.
- A pull whose bucket omits a requested table's provisioned bucket column raises `KZL01` before the server builds a page.
- A pull whose caller cannot `SELECT` a key column of a requested table or its bucket column raises `KZL02` before the server builds a page, under [Column-level privileges](../reference/sql-pack.md#column-level-privileges).
- Deployment policies such as pull-only tables, a maximum batch size, or a required atomic mode raise request-level errors. The last two are the [`kizunasync._settings`](../cli/configuration.md) row on your own server.
- An unknown configured table or a missing required HLC raises rather than inventing a rejection reason.
- Internal bookkeeping failures and malformed protocol values abort loudly.

A verdict is a known domain outcome for one mutation. An error means the server could not safely produce that outcome at all.

## Evidence boundary

Golden transcripts cover RLS denial, precondition failure, delete-wins, HLC supersession, atomic abort, and replay. [Protocol evidence](../getting-started/status.md#protocol-evidence) gives the current counts. The SQL pack also implements the class-23 `CONSTRAINT` path, and the corpus exercises it only through the pack's own raise on a non-numeric increment in `increment/006`, `increment/009`, and `increment/010`. Correct behavior still depends on your policies and your trigger SQL, and no corpus can validate a project's own authorization rules.

## Related pages

- [Conflict resolution](./conflict-resolution.md)
- [Consistency model](./consistency-model.md)
- [Validate writes](./validate-writes.md)
- [Protocol reference](../reference/protocol.md)
