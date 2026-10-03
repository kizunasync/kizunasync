---
title: Subscribe to events
description: Receive engine events and unsubscribe when the screen goes away.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Subscribe to events

`on` registers a handler for the events the engine raises as writes are applied and runs settle, and returns the function that removes it. It is the signal a native app refreshes a screen from, because there is no live query on this client.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val stop = kizunasync.on { event ->
    events.tryEmit(event)
}
```

### Unsubscribe with the screen

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import androidx.compose.runtime.DisposableEffect
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

DisposableEffect(Unit) {
    val job = scope.launch {
        val stop = kizunasync.on { event -> events.tryEmit(event) }
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
| `handler` | `(KizunaSyncEngineEvent) -> Unit` | Yes | Called once per event, in emission order, on the delivery thread the client owns. It may call back into the client. |

### The events it receives

| Name | Type | Required | Description |
|---|---|---|---|
| `LocalChanged` | — | — | Raised after every local write, after a pull boundary commits rows or replays the outbox over them, after a rejected verdict reverts a row, after a dead letter reverts optimistic rows, and after [Reset](./reset.md). |
| `QueueDepth` | `depth: UInt` | — | Raised by each local write with the depth the next run will drain, the same number [Outbox depth](./outbox-depth.md) reports. The [Host scheduler](./scheduler.md) wakes a run on a depth above zero. |
| `MutationRejected` | `mutationId: String`, `reason: String` | — | Raised once per refused write, after the revert and the journal entry land. |
| `BatchAborted` | `offenderMutationId: String`, `reason: String` | — | Raised once for an atomic batch the server refused, naming the member that caused it. |
| `DeadLetter` | `mutationId: String`, `reason: String` | — | Raised once per write the retry budget dropped. `reason` is `PERMANENT_TRANSPORT` after five consecutive failures, except a batch-too-large refusal (`KZP02`) of an atomic batch, which is dropped at once with the server's own message as `reason`. |
| `ColumnOverwritten` | `table: String`, `pk: String`, `column: String`, `loserValueJson: String`, `winnerMutationId: String`, `conflictMode: String` | — | Raised for each column-level conflict a pull reported, carrying the value that lost as JSON. |
| `CheckpointExpired` | — | — | Raised when the server invalidated the pull token. The next pull restarts the keyset and the closing boundary replaces the local snapshot. |
| `ResetRequired` | `reason: String?` | — | Raised when pull or push returned the reset signal, with `reason` `reset_required`, or when a token named another user than the owner of the local database, with `reason` `identity_changed`, as [Set access token](./set-access-token.md#notes) describes. The client soft-blocks until [Reset](./reset.md) runs. |

## Returns

`() -> Unit`, the unsubscribe function. It is safe to call from any thread, including main, because it hands the removal to the client's own coroutine scope.

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Events arrive on one delivery thread that the client owns, one at a time and in the order the engine emitted them, never on the thread that made the call. A handler may call the client back, because the engine answers on its own thread while the delivery thread waits for the answer. A handler that throws does not stop the events after it. The client catches the throwable and logs it at `WARNING` on the `java.util.logging` logger `com.kizunasync.kizunasync`, which Android forwards to logcat.

Attachment statuses from [Watch an attachment](./watch.md) share that thread, so a handler that runs long delays every event and status queued behind it. Hand longer work to a `Flow`, a channel, or another dispatcher, then return. The examples above do that.

Every handler stays registered until its function is called, so a screen that subscribes when it appears unsubscribes when it goes away. [Offline writes](../../sync/offline-writes.md#4-subscribe-to-engine-events) shows the pattern in an app, and [Fetch data](./fetch-data.md) is what a handler re-runs to get the new rows.

## Related reference

- [Fetch data](./fetch-data.md)
- [Outbox depth](./outbox-depth.md)
- [List rejections](./rejections.md)
- [Sync](./sync.md)
- [Swift: Subscribe to events](../swift/on.md)
- [JavaScript: Subscribe to events](../javascript/on.md)
