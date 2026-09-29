---
title: Watch an attachment
description: Receive a status snapshot on every transition of one attachment.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Watch an attachment

`watch` registers a listener for one reference and returns the function that removes it. The listener is handed the current status right away, so a view has something to render before any transfer moves.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val stop = kizunasync.watch(reference) { status ->
    statuses.tryEmit(status)
}
```

### Stop with the view

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import androidx.compose.runtime.DisposableEffect
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

DisposableEffect(reference) {
    val job = scope.launch {
        val stop = kizunasync.watch(reference) { status -> statuses.tryEmit(status) }
        try {
            awaitCancellation()
        } finally {
            stop()
        }
    }
    onDispose { job.cancel() }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column. Several listeners may watch the same reference. |
| `handler` | `(KizunaSyncAttachmentStatus) -> Unit` | Yes | Called with the current status when the watch is registered, and again whenever the engine delivers a round for this reference. It runs on the delivery thread the client owns, in emission order, and it may call back into the client. |

## Returns

`() -> Unit`, the unwatch function. It is safe to call from any thread, including main, because it hands the removal to the client's own coroutine scope.

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The status delivered on registration reaches this listener alone, so adding a second watcher never re-fires the first. A reference with no queue row is reported as the state `missing` with no path, rather than as nothing at all. The fields are the ones [Get attachment status](./get-status.md#returns) documents.

Rounds are delivered when the engine has news to report: after [Sync](./sync.md) drives the queue, after [Attach a file](./from-file.md) imports bytes, and after [Resolve a download](./resolve-download.md) fetches them. There is no timer behind it, so a long upload reports its confirmed offset at those points rather than continuously.

Statuses arrive on the same delivery thread as the events of [Subscribe to events](./on.md), one at a time and in the order the engine produced them. Because that thread is not the caller's, the status handed over on registration can reach the handler after `watch` has returned. A handler may call the client back, because the engine answers on its own thread. A handler that throws does not stop the statuses after it, and a handler that runs long delays every status and event queued behind it, so hand longer work to a `Flow`, a channel, or another dispatcher, then return.

## Related reference

- [Get attachment status](./get-status.md)
- [Attach a file](./from-file.md)
- [Resolve a download](./resolve-download.md)
- [Subscribe to events](./on.md)
- [Swift: Watch an attachment](../swift/watch.md)
- [JavaScript: Watch an attachment](../javascript/watch.md)
