# D-bucket-move-out: A row that leaves a bucket leaves that bucket a tombstone

<!-- kizunasync:decision
id: D-bucket-move-out
status: decided
-->

**Cites:** P:keyset-pagination-and-delivery-bound, SQL:bucket-move-out, SQL:tombstones-bucket-value, SQL:changelog-bucket-value

## Question

When a write moves a row to another value of its table's bucket column, what does a device that pulls only the old value receive?

## Decision

A write that changes a row's bucket-column value records a tombstone for the value the row left, in the same commit and at a lower `seq` than the write itself. The tombstone carries the snapshot of the old value, so it matches a pull whose params name that value, like the tombstone of a delete. The row reaches pulls of the new value through its changelog entry, which the SQL pack labels with the bucket value at write time (`_changelog.bucket_value`). A pull of a bucketed table reads only the entries labeled with a value it requests, after casting each requested value through the column type once.

Tombstones are keyed by `(table, pk, bucket value)`. A move-out and a later delete of the same row therefore keep one tombstone each, and a second move away from the same value refreshes that value's tombstone. The reference oracle stores tombstones the same way.

A move-out is not a delete. A pushed write answers `DELETE_WINS` only when the row's latest change is a removal (its newest tombstone is newer than every changelog entry of the row, or the same transaction queued a delete after its last write of the row) and, for a committed removal, the caller holds a grant for the bucket value it removed the row from (`D-tombstone-delivery`). A moved row answers like any other row under the caller's policies.

Which callers receive a move-out tombstone follows `D-tombstone-delivery`: a caller that received the row from the old value, and only while the row is not deliverable to it under the buckets it requests. A device that pulls both the old and the new value keeps the row, and a device that pulls only the old value removes it. `tombstones/004-bucket-move-out` pins the second case, and `push/002-rls-denied-not-a-wedge` pins the tombstone a reassigned row leaves its former owner.

## Rejected

- **No record for the old value.** No later change of the row reaches the old bucket, so a device that pulls only that bucket would keep the row indefinitely.
- **One tombstone per `(table, pk)`.** A later delete would overwrite the move-out's snapshot with the new value, so devices of the old value would never receive the removal.
