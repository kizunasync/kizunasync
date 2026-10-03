# D-dedup-storage-model: Dedup watermark versus per-mutation verdict storage

<!-- kizunasync:decision
id: D-dedup-storage-model
status: open
-->

**Cites:** SQL:push-request-shape, P:session-guarantees-and-exactly-once-effect, P:verdict-completeness-transforms-and-conflict-rejection

## Question

The SQL stores per-mutation results in `_verdicts` and also records `_clients.last_mutation_id`. What is the long-term storage and retention relationship between those two mechanisms?

## What is not settled

Whether the watermark is a cache of the per-mutation ledger, a second source of truth, or a retention boundary. No wire byte chooses a storage model. No manifest case is blocked on this record: `push/003` and `push/007` are executable.

## What is already safe to rely on

A replay never applies the effect twice. The user who pushed the mutation gets the recorded kind and reason, and a `server_row` the verdict carried is rendered again from the row as it stands, because the ledger keeps no row copy. Any other user gets `RLS_DENIED` with no row (`D-verdict-ownership`). `push/003` observes the single effect through a later pull, and `push/007` observes the row rendered again. Transport is at-least-once; the mutation UUID is the idempotency key. Consumers must not infer a retention or compaction rule from the two tables both existing.
