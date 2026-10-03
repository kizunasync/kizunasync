# D-verdict-ownership: A replayed mutation id answers only the user who pushed it

<!-- kizunasync:decision
id: D-verdict-ownership
status: decided
-->

**Cites:** P:session-guarantees-and-exactly-once-effect, P:verdict-completeness-transforms-and-conflict-rejection, SQL:client-pruning

## Question

A push that repeats a recorded `mutation_id` is answered from the verdict ledger, and a mutation id is not a secret: a pulled conflict entry names the id of the write that won. Who may read a recorded verdict through a replay, and what does the ledger keep of the row it answered with?

## Decision

The ledger records, beside each verdict, the `auth.uid()` of the user who pushed the mutation and the mutation's table and primary key. It stores the verdict with its `server_row` set to `null`, so it holds no copy of an application row.

A replay by that user never applies the mutation again. It returns the recorded kind and reason. When the recorded verdict carries a `server_row`, which every rejection and every applied transform does, the server renders the recorded row again under the user's current Row Level Security. When the user cannot read the row at the replay, or its table has no `_config` row at that point, there is no row to render: a rejection carries `server_row: null`, and an applied verdict leaves `server_row` out, because the applied arm of the verdict carries a `server_row` only as column values. An applied verdict that carried no `server_row` returns without one.

A replay by any other user returns `rejected(RLS_DENIED)` with `server_row: null`, whatever was recorded, and nothing is applied or recorded. A mutation id read from a pulled conflict entry therefore reveals neither the verdict nor the row. A verdict recorded for a caller with no `auth.uid()` answers `RLS_DENIED` to every caller that has one.

`prune_clients()` deletes verdicts recorded longer ago than `_settings.client_ttl_days`, and a mutation replayed after that is decided again.

`push/007-replay-renders-current-row` pins the owner's replay: the row changed after the push that recorded the verdict, and the retry returns the recorded reason with the row as it stands. The transcript grammar has one subject, so the replay by another user is covered by the SQL lane, in `rpc-replay-ownership.test.ts`, not by a transcript.

## Rejected

- **Answering a replay from the ledger to any caller.** Winner ids ride pulled conflict entries to every reader of the row, so any reader could replay one and receive the owner's verdict and the row the owner was answered with.
- **Keeping the row copy in the ledger.** A retry would return the row as it stood at the first push, including one the user's policies forbid it from reading, and the ledger would hold copies of application rows for as long as it keeps the verdict.
