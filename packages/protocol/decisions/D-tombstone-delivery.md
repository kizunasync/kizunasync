# D-tombstone-delivery: A tombstone reaches only a caller who received a live row of its bucket

<!-- kizunasync:decision
id: D-tombstone-delivery
status: decided
-->

**Cites:** P:keyset-pagination-and-delivery-bound, P:mutations-and-column-masked-conflict-resolution, SQL:bucket-grants, SQL:tombstone-delivery

## Question

A tombstone carries a primary key and the bucket value the row left, and no policy can be evaluated on a row that is gone. Which callers may learn that a deleted primary key existed, through a pull page or through a push verdict?

## Decision

Every pull records a grant for each `(table, bucket value)` pair it delivers a live row from, with the empty string standing for an unbucketed table. The SQL pack keeps the grants in `_bucket_grants`, one row per user, table, and value, and only the pull writes them. A tombstone is delivered only for a pair the caller holds. Naming another tenant's bucket value therefore reveals none of its deleted primary keys, and a first pull carries no tombstone of a bucket value it had not received before.

A held pair is necessary but not sufficient. The pull also withholds a tombstone while the row's current state is deliverable to the caller, which means the row renders under the caller's policies and matches a requested bucket. A row that moved to another requested value, or was recreated where the caller can see it, travels as a row, and a client applies a page's rows before its tombstones, so delivering both would delete it. A device that pulls both sides of a move keeps the row, a device that received the row from the old value and pulls only that value drops it, and a caller who cannot see a recreated row still drops its stale copy. This is the removal rule PowerSync states for its buckets ("a row is only deleted from the client if it has been removed from all buckets synced to the client"), evaluated on the server.

Tombstones match on the bucket column alone. The other params of a bucket filter live rows only, so a bucket that names extra params still receives the deletes of its bucket value.

A push decides with the same grants. A mutation of a row whose latest change is a removal, meaning the row's newest tombstone is newer than every changelog entry of the row, answers `DELETE_WINS` only when the caller holds a grant for the bucket value that tombstone removed the row from. Any other caller gets `RLS_DENIED` with `server_row: null`, so a verdict never confirms a deleted primary key the caller never received. A delete that the same push applied earlier answers `DELETE_WINS` without a grant, because the caller made it. The table-config check runs before this one.

Grants never expire by age. A grant older than the tombstone retention cannot be proven unneeded, because the reap horizon moves only when a tombstone is actually reaped. `prune_clients()` deletes the grants of users missing from `auth.users`. The table is readable by `service_role` and by no client role. The reference oracle records the same grants for its single subject, whose Row Level Security analog admits only rows whose bucket column names it.

The rule leaves a residual. Members of the same bucket value receive the deleted primary keys of rows they never saw, and a member removed from a bucket keeps receiving the deletions of that bucket value. A table whose Row Level Security is finer than its bucket should mark removals with a soft-delete column instead, so each removal travels as an ordinary row update under the caller's policies.

## Rejected

- **Scoping tombstones by the bucket snapshot alone.** Any caller who names a bucket value would receive its deleted primary keys, whatever its policies let it read.
- **Replaying Row Level Security on a tombstone.** The row is gone, so no policy can run against it, and keeping a copy of every deleted row to evaluate one would add a second data store the pack does not otherwise hold.
- **Withholding a tombstone whenever a later changelog entry of the row exists.** A caller who cannot see a recreated row would keep a ghost copy of the deleted one.
- **Expiring grants with the tombstone retention.** The reap horizon moves only with a reaped tombstone, so an expired grant could withhold a delete the caller still needs.
