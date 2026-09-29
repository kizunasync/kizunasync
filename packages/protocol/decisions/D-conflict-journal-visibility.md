# D-conflict-journal-visibility: Conflict-journal visibility is an optional conflicts array

<!-- kizunasync:decision
id: D-conflict-journal-visibility
status: decided
-->

**Cites:** P:mutations-and-column-masked-conflict-resolution

## Question

When a table journals overwritten column values, how do those losers reach a client without leaking rows the page withheld?

## Decision

Pull may attach an optional `conflicts` array, omitted when empty. Entries join the journal to the delivered page by `winner_seq`, and only when the winning row's primary key is already in `rows`. The array never reveals a row the page withheld.

Authenticated clients hold no `SELECT` on `_conflict_journal`. Only `service_role` does. The engine persists `_kizunasync_overwrites` and emits `COLUMN_OVERWRITTEN` for each entry, except one its own write won.

An entry whose `winner_mutation_id` is one of the last 1000 writes this device pushed and saw applied is the device's own write taking the column, so the engine neither persists nor emits it. The engine keeps those ids in `_kizunasync_pushed`, and a reset clears them. The page on the wire is unchanged.

`conflict/004-journal-on-winning-pull` pins the bytes.

## Rejected

- **Granting `SELECT` on `_conflict_journal` to `authenticated`.** Losers for rows the caller cannot see would leak.
- **Attaching conflicts for a winner that is not in `rows`.** Same leak, through the journal instead of the page.
