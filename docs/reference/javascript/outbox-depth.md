---
title: Outbox depth
description: Count the mutations waiting for a verdict.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Outbox depth

`getOutboxDepth()` counts the queued mutations that have not received a verdict. It is a read of the local outbox table, so it answers offline and costs no request.

## Examples

### Basic

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const depth = await kizunasync.getOutboxDepth()
```

### Keep a badge current without polling

```ts
// src/pending-badge.ts
import { EEngineEventType } from 'kizunasync'
import { kizunasync } from './kizunasync'

const badge = document.querySelector('#pending-count')

export const stopPendingBadge = kizunasync.on((event) => {
  if (event.type === EEngineEventType.QUEUE_DEPTH && badge !== null) {
    badge.textContent = String(event.depth)
  }
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`Promise<number>`, the number of rows in the outbox.

The count is per mutation, not per call: a write that matched three rows queues three entries. It falls when a verdict clears an entry, whether that verdict applied the write or rejected it, and when the retry budget dead-letters an entry. It does not fall because a request failed, since a failed push leaves every entry queued for the next attempt.

## Notes

A depth above zero means writes are waiting, and says nothing about why. [Sync health](./sync-health.md) is the value that separates a queue waiting on a backoff from one waiting on no network at all, and [Show sync state in your UI](../../sync/offline-writes.md#2-show-sync-state-in-your-ui) pairs the two.

The `QUEUE_DEPTH` event carries the same number and is raised after every local write, so a UI can subscribe through [Subscribe to events](./on.md) instead of re-reading. It is raised by the write, not by a run, so the depth it reports is the one the next run drains.

React and [Vue](https://vuejs.org) apps read both values through `useSyncStatus`, which wraps this method and the health snapshot together and returns the count as `outboxDepth`; [React: useSyncStatus](../react/use-sync-status.md) documents the whole result.

## Related reference

- [Sync](./sync.md)
- [Sync health](./sync-health.md)
- [Subscribe to events](./on.md)
- [Push once](./push-once.md)
- [Swift: Outbox depth](../swift/outbox-depth.md)
- [Kotlin: Outbox depth](../kotlin/outbox-depth.md)
