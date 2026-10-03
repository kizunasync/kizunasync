# D-outbox-rebase: The client rebases its outbox instead of holding back the checkpoint

<!-- kizunasync:decision
id: D-outbox-rebase
status: decided
-->

**Cites:** P:cursor-monotonicity-rebase-and-atomic-checkpoints, P:session-guarantees-and-exactly-once-effect

## Question

When a pull closes (`has_more: false`) and the outbox is still non-empty, does the client publish the new checkpoint?

## Decision

Yes. At a `has_more: false` boundary the client commits staged rows, tombstones, and the server cursor even when the outbox is non-empty, then replays pending outbox mutations in FIFO order inside the same local transaction. Pending local assigns overlay the newly committed snapshot. A pulled tombstone plus a pending non-delete does not resurrect the row; the outbox entry remains and a later push returns `DELETE_WINS`.

Read-your-writes is preserved by replay, not by withholding the checkpoint. Uncontested server columns become visible while a pending mutation is still queued. A stuck outbox does not delay independent remote rows.

The live MUST-PASS family is `rebase/001`–`004`. Checkpoint hold-back is not part of the protocol.

## Rejected

- **Withholding the checkpoint while the outbox is non-empty.** Independent remote writes would stay invisible until a local mutation drained, including a mutation that might never succeed.
- **Row-level hold-back.** The checkpoint is a single cursor. Holding some rows and publishing others would split the snapshot the session guarantees talk about.
