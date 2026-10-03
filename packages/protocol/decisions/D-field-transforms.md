# D-field-transforms: Field transforms are an optional transforms slot on update

<!-- kizunasync:decision
id: D-field-transforms
status: decided
-->

**Cites:** P:verdict-completeness-transforms-and-conflict-rejection, P:mutations-and-column-masked-conflict-resolution

## Question

How do increment and array-union writes reach the arbiter without becoming a fourth `op`?

## Decision

An `update` may carry optional `transforms`. They ride that update. They never form a fourth `op`. A column key MUST NOT appear in both `columns` and `transforms`.

Each transform applies at the arbiter and is not HLC-compared. A transform cannot `SUPERSEDE` by itself. The closed menu is `increment`, `arrayUnion`, and `arrayRemove`. Signed increment `by` is a schema exception to C-4, documented on `$defs/transform`.

When any transform ran, `applied` carries RLS-rendered `server_row` so the client can snap optimistic state.

A transform that is rejected rejects the whole update: none of its columns apply.

## Rejected

- **A fourth `op` for transforms.** Every existing mask, tombstone, and verdict rule is defined on insert/update/delete. A fourth verb would fork that matrix.
- **HLC-comparing transform operands.** Two increments on the same column would then drop one instead of both landing at the arbiter.
