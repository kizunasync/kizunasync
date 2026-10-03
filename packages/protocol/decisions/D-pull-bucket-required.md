# D-pull-bucket-required: A bucketed table refuses an unscoped pull with KZL01

<!-- kizunasync:decision
id: D-pull-bucket-required
status: decided
-->

**Cites:** P:keyset-pagination-and-delivery-bound, SQL:pull-policy

## Question

How does the protocol stop a client from pulling a bucketed table without naming its bucket?

## Decision

A table provisioned with `bucket_column` refuses a pull whose bucket for that table omits the column. `kizunasync.pull` raises the pull-policy error `KZL01` (`raise exception 'kizunasync.pull(): table "<t>" is bucketed on "<c>": the pull bucket must name that column' using errcode = 'KZL01'`) before it builds a page, checked after the `RESET_REQUIRED` gate and before `CHECKPOINT_EXPIRED`. A pull that names more than 64 bucket entries is refused with `22023` before every gate.

Tombstone scope follows the same rule as row scope: a bucketed table's rows and tombstones are bucket-scoped, and an unbucketed table's stay table-scoped. The SQL pack reads a bucketed table's changelog and tombstones only for the requested bucket values, each cast through the column type once, so a value the type refuses fails the pull with its class-22 error; a row that leaves a bucket leaves that bucket a tombstone (`D-bucket-move-out`), and a tombstone reaches only a caller who received a live row of that bucket and cannot currently receive the row (`D-tombstone-delivery`). The reference oracle throws the same way. Both remotes, `rpc-remote.ts` in `@kizunasync/supabase` and the Rust `kizunasync-remote-http`, classify `KZL01` as definitive alongside `KZP01` and `KZP02`, so the host sees the transport code on `health.lastError` in JavaScript. Swift and Kotlin receive the catalog code `PERMANENT_TRANSPORT` instead, with the server's message, which names the table and its bucket column.

## Rejected

- **Deliver every tombstone to an unscoped pull.** Row Level Security cannot be replayed against a row that is gone, so an unscoped pull of a bucketed table's tombstones would leak every deleted primary key across every caller's tenants.
- **Silently withhold the tombstone.** Rows would arrive and deletes never would, and the client would diverge from the server with no signal that anything was wrong.
- **A per-table `tombstone_scope` opt-in.** Not needed: row scope decides tombstone scope on every table.
