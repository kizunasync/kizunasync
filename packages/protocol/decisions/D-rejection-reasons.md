# D-rejection-reasons: Rejection reasons are a closed six-literal union

<!-- kizunasync:decision
id: D-rejection-reasons
status: decided
-->

**Cites:** P:verdict-completeness-transforms-and-conflict-rejection, P:mutations-and-column-masked-conflict-resolution, P:protocol-is-the-product-the-corpus-is-the-arbiter

## Question

Which reason literals may a rejected verdict carry, and what does each one mean when the row is absent or hidden?

## Decision

The closed union is `PRECONDITION`, `RLS_DENIED`, `COLUMN_DENIED`, `CONSTRAINT`, `DELETE_WINS`, and `SUPERSEDED`. Unknown values fail loudly on every bridge.

`server_row` is rendered under the caller's SELECT policy. It is `null` when the row is deleted or invisible; otherwise it carries the RLS-visible compensating state. A rejection cannot become a privileged row read.

`SUPERSEDED` means an HLC mutation for which every masked column lost.

A non-insert against a row that does not exist, or that the caller cannot see, reports `RLS_DENIED`, not `CONSTRAINT`. The caller-scoped RLS path cannot tell "absent" from "hidden" without a privileged existence oracle, so both land as `RLS_DENIED`.

`CONSTRAINT` is an error raised while the mutation's row is applied: class 23, an integrity constraint the write breaks; class 22, a data exception such as a value its column type refuses, including a precondition value; `P0001`, which an app trigger raises when it calls `raise exception` without a SQLSTATE of its own; or `428C9`, which a value for a column generated always raises, such as an insert that names an identity key. Only that mutation is rejected. Its writes roll back, and the rest of a non-atomic batch still applies.

`DELETE_WINS` means the row's latest change is a removal that the caller may know about: a delete the same push made, or a committed tombstone of a bucket value the caller received a live row of. A deleted row the caller never received reports `RLS_DENIED` with `server_row: null` for every op (`D-tombstone-delivery`).

`COLUMN_DENIED` means the row itself is writable under RLS, but the mutation names a column the caller's role may not `UPDATE` under Postgres's own column-level privileges. `server_row` carries the row narrowed to the columns the caller may read, the same rendering `RLS_DENIED` uses.

`push/006-constraint-not-a-wedge` pins `RLS_DENIED` with `server_row: null`. It does not exercise a class-23 failure. The transcript grammar has no column types and no app triggers, so the SQL lane covers the class-22 and `P0001` rejections, in `rpc-verdict.test.ts`.

On the client, an explicit rejected verdict is compensated to `server_row`, recorded in the rejection journal, removed from the outbox, and surfaced as `MUTATION_REJECTED`. It is not the transport-error dead-letter path.

## Rejected

- **An open string reason.** Drivers would invent spellings and the corpus could not pin compensation.
- **`CONSTRAINT` for an absent or hidden row.** That would leak, or guess, which case occurred, and it would steal the class-23 literal.
- **Failing the whole push on a class-22 error or a `P0001`.** Both are permanent for the mutation that raised them, so a push that fails on one fails again on every retry, and the mutations queued behind it never reach the server.
- **Map column refusals onto `RLS_DENIED`.** The client could not tell a hidden row from a forbidden column, and the row is visible: an `RLS_DENIED` reader would read the write as unauthorized on the whole row rather than narrowed to one column.
