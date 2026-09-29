# D-atomic-batch-abort: An atomic batch aborts with one outcome

<!-- kizunasync:decision
id: D-atomic-batch-abort
status: decided
-->

**Cites:** P:verdict-completeness-transforms-and-conflict-rejection, SQL:push-request-shape

## Question

When `batch.atomic` is true and one mutation is rejected, what commits and what does the response contain?

## Decision

The first rejection rolls the batch subtransaction back. Sibling effects do not commit. The response contains one `batch` object with `outcome: "aborted"`, the offending mutation, reason, and server row. No `_verdicts` rows are recorded for that attempt, so the client may send the same bytes again.

`push/005` pins the all-or-nothing revert. The live SQL honors `atomic: true`.

## Rejected

- **Per-mutation verdicts on an atomic abort.** Partial apply would contradict the flag the client set.
- **Recording verdicts for an aborted attempt.** A retry would then look like a replay of a committed batch.
