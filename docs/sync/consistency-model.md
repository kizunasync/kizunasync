---
title: Consistency model
description: The checkpoint, session, retry, convergence, and retention guarantees implemented by Kizuna.
status: alpha
docType: concept
audience: app-developer
---

# Consistency model

The consistency model is the set of promises Kizuna keeps about what a device reads and what becomes of what it writes. Kizuna implements [causal+ consistency to checkpoints](../resources/glossary.md#causal-to-checkpoints), all four session guarantees per device, and [column last-writer-wins](../resources/glossary.md#column-last-writer-wins-column-lww) on server arrival order by default.

The model exists because an offline-first app answers a read before the server has seen the matching write. That leaves two questions an ordinary database never asks you: when does a change made elsewhere become visible, and what happens to a local write the server later refuses. A committed pull boundary answers the first, and an explicit [verdict](../resources/glossary.md#verdict) per mutation answers the second.

Every promise covers only the rows the caller's policies permit and the [buckets](../resources/glossary.md#bucket) the pull requested, and each one assumes the device syncs successfully before retention expires its [cursor](../resources/glossary.md#cursor). Kizuna never promises two users the same dataset when their [Row Level Security](https://grokipedia.com/page/Row-level_security) visibility differs, however long both sync. Supabase documents what a caller may read in [SELECT policies](https://supabase.com/docs/guides/database/postgres/row-level-security#select-policies), and Kizuna adds nothing to that decision: a pull delivers a row only when the caller's own policy renders it.

## Checkpoints

A pull can span several pages. Each page carries up to `limit` entries from one stream of rows and tombstones in `(seq, table, pk)` order, and the page that reaches the end of that stream closes the run, even when it holds exactly `limit` entries. The engine stages those pages and, at that closing boundary, commits their rows, [tombstones](../resources/glossary.md#tombstone), final cursor, and staging cleanup in one local transaction. A read therefore sees the previous [checkpoint](../resources/glossary.md#checkpoint) or the completed next one, so a screen shows the run of pages it already had or the whole next run, never half of one. [Checkpoint and rebase rules](../reference/protocol.md#checkpoint-and-rebase-rules) fixes that boundary on the wire.

That boundary is what "to checkpoints" qualifies. A remote page becomes visible when the pull that carries it completes, not while its pages are arriving, and [`getCheckpoint()`](../reference/javascript/checkpoint.md) reports the cursor the last one committed. [Swift: Checkpoint](../reference/swift/checkpoint.md#returns) and [Kotlin: Checkpoint](../reference/kotlin/checkpoint.md#returns) document the same fields for native apps.

When the [outbox](../resources/glossary.md#outbox) is not empty the checkpoint commits all the same, and the engine replays the pending mutations over that snapshot in the same transaction. Your unsent edits stay on screen instead of flickering away, and uncontested remote columns appear underneath them.

The engine tests cover that transaction structure. Whether the local database survives an abrupt process or device kill depends on the [SQLite](https://grokipedia.com/page/SQLite) driver, the filesystem, the journal mode, and the platform. The repository holds no driver-by-driver kill matrix, so the checkpoint is an atomic write the engine performs rather than a measured survival property. [Test offline behavior](../operations/test-offline-behavior.md) states what the current tests do and do not establish.

## The four session guarantees

| Guarantee | Kizuna mechanism | Boundary |
|---|---|---|
| **Read your writes** | A local mutation is visible in the local store at once, and outbox replay overlays pending assigns onto an incoming checkpoint | A rejected or permanently abandoned mutation is reconciled and surfaced rather than dropped quietly |
| **Monotonic reads** | The visible checkpoint state and its cursor never move backwards | A rehydrate replaces the expired local snapshot instead of continuing its old history |
| **Monotonic writes** | The engine processes a device's outbox in issue order | A [dead-lettered](../resources/glossary.md#dead-letter) mutation is the recorded exception that lets a later mutation proceed |
| **Writes follow reads** | One global server sequence orders a session write after the prefix observed before that write | RLS and bucket filtering can hide earlier rows whose sequence positions precede the write |

The [TLA+](https://grokipedia.com/page/TLA%2B) session model states these as four invariants: confirmed writes stay contained in observed state, the read position never regresses, issue order survives once recorded dead letters are filtered out, and a write lands after the read watermark that preceded it.

Read together, they say a device reads its own writes back, never slides backwards through the server sequence, and sends its writes in the order you made them. Each holds inside what the caller may see, and each exception is written down: a refused write, an abandoned write, and a local database rebuilt after cursor expiry all surface in the app.

## Retry and exactly-once effect

The network delivers at least once, so a push can commit on the server and lose its acknowledgement on the way back regardless. Every mutation carries an [idempotency](https://grokipedia.com/page/Idempotence) [UUID](https://grokipedia.com/page/Universally_unique_identifier) and the server stores the verdict it returned for that UUID, so replaying the mutation returns the recorded verdict instead of applying the write a second time.

That is an exactly-once effect rather than exactly-once transport: the delivery repeats and the effect does not. How the client registry's single `last_mutation_id` watermark relates to the per-mutation verdict ledger is an open protocol question, and the observable behavior is fixed either way by [Exactly-once effect and dead letters](../reference/protocol.md#exactly-once-effect-and-dead-letters).

## Dead letters and liveness

Only a remote error the adapter classifies `retryable: false` consumes the [dead-letter](../resources/glossary.md#dead-letter) budget, and a lone queued write or an atomic batch owns that budget outright: after five consecutive permanent failures against it, the engine records a `DEAD_LETTER`, removes that entry, and lets the rest of the queue move. A permanent failure of a wider, non-atomic slice is never charged to the slice itself, because the response names no mutation within it as the cause: the engine narrows the slice instead, halved when the server names `KZP02` (over `max_batch_size`) or cut to the head write for any other permanent code, and resends at once, so the retries converge on the one write that then owns its own budget. That event arrives through [`kizunasync.on`](../reference/javascript/on.md), and [`getSyncHealth()`](../reference/javascript/sync-health.md) carries the failure streak behind it.

Network loss, request timeouts, a missing authentication session ([`AUTH_SESSION_MISSING`](../reference/javascript/sync.md#errors)), a session lookup that does not settle within ten seconds (`AUTH_SESSION_TIMEOUT`), 5xx responses, and unclassified failures all stay retryable, and none of them consumes that budget. Supabase owns the token lifecycle in [Auth sessions](https://supabase.com/docs/guides/auth/sessions). Kizuna adds only the ten-second deadline around the session lookup, so a hung refresh fails one sync run rather than hanging it. `sync()` still pulls after a push failure, so a refused write never holds remote rows back, unless the failure is retryable: the network or the session would fail the pull the same way, and the call reports the push failure instead. That is the cost of never discarding a write the server never refused.

Transport error codes are not a portable wire vocabulary. The classification above is the adapters' own behavior, and another conforming transport cannot infer wire codes from it.

## Convergence and conflicts

Accepted writes converge through a single [Postgres](https://grokipedia.com/page/PostgreSQL) arbiter. In the default [`arrival` mode](./conflict-resolution.md#arrival-mode) the later accepted server arrival holds a contested column; in [`hlc` mode](./conflict-resolution.md#hlc-mode) the clamped origin [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) is the per-column ordering key. Writes that name different columns can both survive when the validation gates permit both.

Rejected writes converge through compensating local state. The server returns one reason and the `server_row` the caller's SELECT policy renders, or `null` when no row may be returned. A hard delete leaves a tombstone, and a later mutation for that row is rejected with `DELETE_WINS`, one of the six [rejection reasons](../reference/protocol.md#rejection-reasons), when the caller already pulled a live copy of the [bucket](../resources/glossary.md#bucket) the row left; a caller who never received that row gets `RLS_DENIED` and no row instead, so a verdict never confirms a deleted primary key the caller never saw.

Convergence is eventual rather than immediate. Two devices agree once three things hold for both: each has resumed successful pulls, each has stayed inside the retention window or rehydrated after `CHECKPOINT_EXPIRED`, and each is authorized for the same rows. `CHECKPOINT_EXPIRED` is one of the two [lifecycle signals](../reference/protocol.md#lifecycle-signals). The server judges it by the checkpoint a pull sequence started from, never by the page the sequence has reached: a rehydration from the beginning always completes, and a sequence that started from a checkpoint the reaper has since passed expires even between its pages.

## Freshness and fencing

Realtime [wake-ups](../resources/glossary.md#wake-up) cut delay and carry no correctness data. A missed hint waits for the next scheduled pull and does not remove a change from the server sequence, which is why [`realtimeWakeups`](../reference/javascript/define-config.md#parameters) is a freshness setting rather than a correctness one.

The SQL pack numbers each change when its transaction commits, so a pull can take the largest sequence number visible in its snapshot as its [consistency horizon](../resources/glossary.md#consistency-horizon): no later commit can land below it. An open transaction has no number yet and never holds back other commits, so a change is deliverable as soon as its transaction's commit is visible. Writes pay for that. Transactions that change synced tables commit one at a time, which caps synced-write commits per second at a rate that depends on the disk's flush latency. [Fencing and horizons](./fencing-and-horizons.md) covers the mechanism, its costs, and the cursor grammar.

## What the model does not provide

- Same-column multi-value merge or [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type) semantics. Two writes to one column resolve to one value.
- Offline enforcement of global uniqueness, inventory, balance, or other coordinated invariants. Those are decided when the mutation reaches Postgres.
- Guaranteed sub-second visibility. Freshness depends on the poll interval, the wake-up, and when the writing transaction commits.
- Identical datasets across callers with different RLS or bucket scopes.
- Durability across an abrupt process or device kill on every driver and platform, which no current test matrix measures.
- Client-side recovery of an overwritten value. [`conflict_journal`](../cli/configuration.md#kizunasync_config) keeps loser values on the server and pull may attach them as optional `conflicts`. The journal is off until you turn it on, and [Collaborative fields](./collaborative-fields.md#4-restore-an-overwritten-assign-from-the-journal) shows the client side.

## Related pages

- [Conflict resolution](./conflict-resolution.md)
- [Fencing and horizons](./fencing-and-horizons.md)
- [Design trade-offs](../resources/design-tradeoffs.md)
- [Protocol reference](../reference/protocol.md)
