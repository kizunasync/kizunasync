---
title: Pull once
description: Make exactly one pull request and apply it only when the page closes the checkpoint.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Pull once

`pullOnce()` makes exactly one pull request and never pushes. A page that closes the [checkpoint](../../resources/glossary.md#checkpoint) boundary commits every row and tombstone staged since the sequence began; a continuation page stages its rows and tombstones invisibly and moves the keyset position instead.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

await kizunasync.pullOnce()
```

### Read incoming rows without sending queued writes

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

await kizunasync.pullOnce()

const { cursor } = await kizunasync.getCheckpoint()
```

A bootstrap larger than `pullLimit` spans several calls, and only the last one commits. The [cursor](../../resources/glossary.md#cursor) stays where it was until then, so it cannot tell a finished sequence from an unfinished one. [Sync](./sync.md) is what drains a long sequence: it loops on the keyset position this method advances internally, which no public method reports.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

The request is built from the config: one bucket per configured table carrying that table's runtime values, the cursor, the schema version from the `schemaVersion` option on [Initializing](./initializing.md#parameters), and `pullLimit` from [Define config](./define-config.md#parameters) as the page limit.

## Returns

`Promise<void>` that settles when the single request has been reconciled. The call returns without reaching the wire when the client is soft-blocked, which [Checkpoint](./checkpoint.md#returns) reports and [Reset](./reset.md) clears.

### What one call changes

| Name | Type | Required | Description |
|---|---|---|---|
| Staged rows and tombstones | — | — | A continuation page stages its rows and tombstones where no local read can see them, and records the keyset position the next call resumes from. Nothing is visible until a boundary closes. |
| Local rows | `TLocalRow[]` | — | Written only on a boundary page, in one transaction that also replays the outbox over them, so a pulled row never clobbers a write already queued. |
| Checkpoint cursor | `TCursor` | — | Advanced only on a boundary page, written exactly as the server sent it. Read it with [Checkpoint](./checkpoint.md). |
| Conflict journal rows | — | — | Recorded when the page carries them, for tables whose `conflict_journal` column is on. |

### Events, and what raises them

| Name | Type | Required | Description |
|---|---|---|---|
| `LOCAL_CHANGED` | `{ type: 'LOCAL_CHANGED' }` | — | Raised on a boundary that committed rows or replayed the outbox over them. |
| `COLUMN_OVERWRITTEN` | `TEngineEvent` | — | Raised once per journalled overwrite the page delivered, after the row is recorded. |
| `CHECKPOINT_EXPIRED` | `{ type: 'CHECKPOINT_EXPIRED' }` | — | Raised when the server invalidates the pull token. Staged pages are dropped, the keyset restarts from the beginning on the next call, and that fresh sequence replaces local rows rather than merging into them, so a row the server does not send is dropped locally. |
| `RESET_REQUIRED` | `{ type: 'RESET_REQUIRED'; reason?: 'reset_required' \| 'identity_changed' }` | — | Raised when the schema version is below the server minimum (`reason: 'reset_required'`) or a token of another user than the one the local database belongs to reached the engine (`reason: 'identity_changed'`). Nothing is applied, the durable cursor is untouched, and the client soft-blocks until [Reset](./reset.md) resolves it. |

## Errors

| Code | Condition |
|---|---|
| `BUCKET_UNSET` | A configured bucket column has no value. Call [Set bucket](./set-bucket.md) after sign-in. |
| `UNKNOWN_TABLE` | A configured table produced no bucket at all, so no wire-valid request could be built. |
| `UNKNOWN_SIGNAL` | The page carried a lifecycle signal outside the closed set above. |
| `UNKNOWN_OP` | The outbox replay that runs over the committed page met a row carrying an operation outside insert, update, and delete. |

A transport failure abandons the sequence in flight: the staged page and the keyset position are dropped, the durable cursor, the outbox, and the soft-block are left alone, and the error is re-thrown. The next call therefore resumes from the last committed cursor rather than from a half-finished position.

## Notes

This method does not consult the connectivity port. A call made while the port reports no network reaches the wire regardless and fails there, unlike [Sync](./sync.md), which returns without an attempt.

The staging rule is what makes a long first pull safe to interrupt: rows appear all at once or not at all, which is the boundary [Protocol overview](../../sync/protocol-overview.md#pull) describes and [Consistency model](../../sync/consistency-model.md#checkpoints) states as a guarantee.

Use it when the app needs incoming rows without sending queued writes, for example on a screen that opens read-only. Everything else is better served by [Sync](./sync.md), which pushes first and then drains the whole pull sequence.

## Related reference

- [Sync](./sync.md)
- [Push once](./push-once.md)
- [Checkpoint](./checkpoint.md)
- [Set bucket](./set-bucket.md)
- [Swift: Pull once](../swift/pull-once.md)
- [Kotlin: Pull once](../kotlin/pull-once.md)
