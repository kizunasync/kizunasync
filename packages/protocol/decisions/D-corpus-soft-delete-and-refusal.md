# D-corpus-soft-delete-and-refusal: Corpus grammar: soft-delete column and expected local refusal

<!-- kizunasync:decision
id: D-corpus-soft-delete-and-refusal
status: decided
-->

**Cites:** P:the-golden-corpus-and-deterministic-placeholders

## Question

How does a transcript name a table's soft-delete column, and how does a `local` step say the client must refuse the write?

## Decision

`context.server.tables[*]` may carry an optional `soft_delete_column` string. It names the column that marks a row as deleted at the application level, the same role `softDelete` plays in a client config. A table that omits it accepts hard deletes.

The `local` step may carry an optional `expect_error` string holding one of the codes in `spec/engine-errors.json`. When it is present the client must refuse that mutation with a local error whose code equals the value, and the step must leave the outbox depth unchanged. When it is absent a throwing `local` step remains a failure.

The schema keeps the field a plain string. The harness checks the value against the error catalog, so a code added to the catalog needs no schema edit.

`lifecycle/004-soft-delete-violation` uses both fields. Both executors map a refused `local` step through the same rule. The reference server accepts the field without acting on it, because a refusal never reaches the wire.

## Rejected

- **A new step kind for local refusal.** The existing `local` step already is the write. A second kind would split every executor.
- **Putting the soft-delete column only in client config, not in the transcript context.** Then a corpus case could not pin the refusal.
