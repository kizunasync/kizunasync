# D-page-cap-and-checkpoint-boundary: Pull page cap, limit accounting, and the checkpoint boundary

<!-- kizunasync:decision
id: D-page-cap-and-checkpoint-boundary
status: decided
-->

**Cites:** P:cursor-monotonicity-rebase-and-atomic-checkpoints, SQL:default-page-limit, SQL:pull-scan-cap, SQL:pull-bucket-cap

## Question

What is the fourth pull argument called, what does `limit` count, how much work may one page do, and when is a checkpoint closed?

## Decision

Pull names its page cap `limit`. The argument is wire-visible through PostgREST, so the schema, the SQL signature, and the TypeScript request type all use that spelling. The default is 500. A `limit` below 1 is refused by both implementations, the SQL pack and the reference oracle, with SQLSTATE `22023`; the transcript format has no step for a pull that raises, so no transcript pins that refusal. A pull names at most 64 bucket entries, and both implementations refuse a longer list with the same SQLSTATE before any gate runs.

A page is a prefix of one stream: the deliverable rows and the deliverable tombstones together, ordered by `(seq, table, pk)`. The stream has no ties, because `seq` comes from one global sequence and a tombstone owns its `seq`. A page holds at most `limit` entries, rows and tombstones counted together. The rows go in `rows` and the tombstones in `tombstones`, and each list keeps stream order.

When the remaining stream holds `limit` entries or fewer, the page carries all of them and closes the checkpoint: the cursor is the checkpoint token the visibility horizon computed, which carries no start, and `has_more` is `false`. An exact fit closes the checkpoint as well. The reference oracle also keeps `has_more: true` on that page while its refined cursor carries holes (`D-visibility-horizon`).

Otherwise the page is a continuation page. It carries the first `limit` entries of the stream and returns `has_more: true`, and its cursor is `<start>:<seq of its last entry>`. The start is the incoming token's start when it has one, otherwise the incoming token's high-water, so the whole transfer carries the checkpoint it started from (`D-cursor-opaque-token`). The reference oracle also keeps the holes below that `seq`.

A page also stops once the server has examined `max_pull_scan` candidates of the stream, counting the rows it withholds, because the caller's policies hide them or no bucket entry matches, together with the entries it delivers. The SQL pack reads the cap from `_settings.max_pull_scan`, default 5000, and a transcript declares it as `context.server.max_pull_scan`. A page the cap stops is a continuation page even when it holds fewer than `limit` entries, none included: it returns `has_more: true` and the cursor `<start>:<seq of the last candidate examined>`, which can lie above its last entry's `seq`. A stream that ends exactly at the cap closes the checkpoint like an exact fit. `pull/005-scan-cap-continues-below-the-limit` pins a capped page.

A pull response that is a lifecycle signal carries no page data: empty `rows` and `tombstones`, `has_more: false`, and the incoming cursor.

## Rejected

- **`page_limit` as the argument name.** PostgREST exposes argument names on the wire. A second spelling would be a second contract.
- **Counting only rows, or only tombstones, against the cap.** Mixed pages would then have no single bound a client could reason about.
- **Closing the checkpoint on `has_more: true`.** The engine stages those pages. The local transaction that publishes the cursor waits for the closing boundary.
- **Tombstones only on the final page.** When a tombstone leads the pending stream, no row can precede it, so the only progress left is one page that holds the whole remaining backlog.
- **An exact fit keeps the checkpoint open.** It costs a round trip that returns an empty page.
- **Bounding a page by `limit` alone.** A page that withholds most of what it reads, under a policy stricter than the bucket or extra bucket params, would read the whole backlog in one call.
