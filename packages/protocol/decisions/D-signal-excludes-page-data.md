# D-signal-excludes-page-data: A signal response carries no page data

<!-- kizunasync:decision
id: D-signal-excludes-page-data
status: decided
-->

**Cites:** P:cursor-monotonicity-rebase-and-atomic-checkpoints, P:schema-version-signalling

## Question

When pull or push returns a lifecycle signal, may that envelope also carry rows, tombstones, or verdicts?

## Decision

No. A signal response has empty `rows` and `tombstones`, `has_more: false`, and the incoming cursor. Push `RESET_REQUIRED` is `{ "signal": { "type": "RESET_REQUIRED" } }` with no verdicts. The client must not treat a signal as a page.

## Rejected

- **Piggy-backing a partial page on a signal.** A client that advanced the cursor from mixed bytes would not know whether the signal or the page was authoritative.
