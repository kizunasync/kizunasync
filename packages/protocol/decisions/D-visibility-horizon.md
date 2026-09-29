# D-visibility-horizon: Fencing is the Postgres visibility horizon

<!-- kizunasync:decision
id: D-visibility-horizon
status: decided
-->

**Cites:** P:keyset-pagination-and-delivery-bound, SQL:visibility-horizon

## Question

How does pull avoid skipping a row whose sequence was allocated before a still-open transaction commits?

## Decision

Fencing is the Postgres visibility horizon: the largest commit-ordered sequence number visible in the pull's snapshot. The SQL pack assigns every change's sequence number when the writing transaction commits. `kizunasync.track_change` and `kizunasync.track_delete` queue the change in `kizunasync._change_pending`, and a deferred constraint trigger, `kizunasync._stamp_change`, numbers each queued change at commit while it holds one transaction-scoped advisory lock.

Only `kizunasync._stamp_change` draws from `kizunasync._change_seq`, and only while it holds that lock. Postgres makes a committing transaction visible before it releases the transaction's locks, so a transaction draws a number only after every earlier drawer is visible or aborted. The numbers any snapshot sees therefore form a gapless prefix, apart from numbers an aborted commit consumed.

A pull takes one snapshot and advances the cursor to the largest sequence number visible in it, and no later commit can land below that number. The SQL pack returns that number as a flat checkpoint cursor on the page that closes the checkpoint, and a continuation page carries the checkpoint its transfer started from (`D-cursor-opaque-token`); the pack still honors a composite cursor. An open transaction has no sequence number, so it never holds back other commits: a change is deliverable as soon as its transaction's commit is visible.

The TypeScript reference oracle keeps the refined hole model. It sees in-flight effects in memory and records each gap in a composite cursor for re-delivery. The two implementations refuse to skip a late commit for different reasons: in the pack a late commit draws a number above every visible one, and the oracle re-delivers each recorded hole once it commits. Both deliver a committed change as soon as its commit is visible, and they differ in the cursor they emit. The three fencing transcripts are oracle evidence. The SQL evidence is the pack's concurrency tests, `packages/supabase-pack/tests/pull-fencing-*.test.ts`.

The cost falls on commits. Transactions that change synced tables run their commit step one at a time, including the WAL flush, so synced-write commits per second have a ceiling set by the disk's flush latency; transactions that touch no synced table are unaffected. A transaction that changes many synced rows holds the lock while it numbers them. `SET CONSTRAINTS ALL IMMEDIATE` numbers changes early and holds the lock until commit. `PREPARE TRANSACTION` holds it until `COMMIT PREPARED` or `ROLLBACK PREPARED`. A user's own deferred constraint trigger can deadlock with the lock, and Postgres then aborts one side. `statement_timeout` applies to a `COMMIT` that waits for the lock. The sequence keeps `CACHE 1`, and nothing but the stamp may call `nextval` on it.

Compatibility: the cursor contract is `D-cursor-opaque-token`. A client persists and echoes the token without parsing it, the SQL pack accepts a composite token as well as the flat one it emits, and the three fencing transcripts exercise the reference oracle.

## Rejected

- **A write-time sequence with an xmin-bounded prefix.** A transaction with the older xid draws a higher sequence and commits while a younger open transaction holds lower ones, and the pull passes them.
- **A cursor that carries in-flight transaction ids.** It changes the wire grammar, and its plain form still skips a sequence drawn after the snapshot.
- **In-flight markers read from `pg_locks`.** Correctness depends on every writer taking a marker and on `CACHE 1`, every pull scans the lock table, the freshness stall remains, and reading the markers and taking the snapshot are not one atomic step.
- **Trigger arrival time plus a finite overlap window.** Re-delivery can be idempotent under latest-state-only apply, but a transaction that outlives the window can still be skipped. A finite window is not provably gap-free.
