---
title: Outbox depth
description: Count the local writes waiting for a sync run.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Outbox depth

`outboxDepth()` counts the queued mutations that no run has settled. It is the number a screen shows as pending work, and it reaches zero once every write has an applied or rejected verdict.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val pending = kizunasync.outboxDepth()
```

### Keep a badge in sync

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncEngineEvent

val stop = kizunasync.on { event ->
    if (event is KizunaSyncEngineEvent.QueueDepth) {
        badge.value = event.depth.toInt()
    }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This function takes no arguments. |

## Returns

`Int`, the number of outbox entries that are not in flight. A write that a push is carrying right now is not counted, so the number drops as verdicts arrive rather than after the whole run finishes.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The local database could not be read. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Every successful write raises `QUEUE_DEPTH` with the same number, so a view can follow the count through [Subscribe to events](./on.md#returns) instead of polling this function. A depth that never falls means the runs are failing; the reason is in the last error a run threw, and a write the retry budget finally dropped appears in [List rejections](./rejections.md) with kind `DEAD_LETTER`.

The count says nothing about attachment bytes. An upload that is queued after the outbox drains is tracked by [Get attachment status](./get-status.md).

## Related reference

- [Sync](./sync.md)
- [Subscribe to events](./on.md)
- [List rejections](./rejections.md)
- [Swift: Outbox depth](../swift/outbox-depth.md)
- [JavaScript: Outbox depth](../javascript/outbox-depth.md)
