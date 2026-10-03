---
title: Subscribe to events
description: Receive engine events and unsubscribe when the screen goes away.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Subscribe to events

`on(_:)` registers a handler for the events the engine raises as writes are applied and runs settle, and returns the closure that removes it. It is the signal a native app refreshes a screen from, because there is no live query on this client.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let stop = try await kizunasync.on { event in
  Task { @MainActor in reload(after: event) }
}
```

### Unsubscribe with the screen

```swift
// TodoApp/BoardView.swift
import KizunaSync
import SwiftUI

struct BoardView: View {
  @State private var stop: (@Sendable () -> Void)?

  var body: some View {
    List(titles, id: \.self) { Text($0) }
      .task {
        stop = try? await kizunasync.on { event in
          Task { @MainActor in reload(after: event) }
        }
      }
      .onDisappear { stop?() }
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `handler` | `@Sendable (KizunaSyncEngineEvent) -> Void` | Yes | Called once per event, in emission order, on the delivery thread the client owns. It may call back into the client. |

### The events it receives

| Name | Type | Required | Description |
|---|---|---|---|
| `.localChanged` | — | — | Raised after every local write, after a pull boundary commits rows or replays the outbox over them, after a rejected verdict reverts a row, after a dead letter reverts optimistic rows, and after [Reset](./reset.md). |
| `.queueDepth` | `depth: UInt32` | — | Raised by each local write with the depth the next run will drain, the same number [Outbox depth](./outbox-depth.md) reports. The [Host scheduler](./scheduler.md) wakes a run on a depth above zero. |
| `.mutationRejected` | `mutationId: String`, `reason: String` | — | Raised once per refused write, after the revert and the journal entry land. |
| `.batchAborted` | `offenderMutationId: String`, `reason: String` | — | Raised once for an atomic batch the server refused, naming the member that caused it. |
| `.deadLetter` | `mutationId: String`, `reason: String` | — | Raised once per write the retry budget dropped. `reason` is `PERMANENT_TRANSPORT` after five consecutive failures, except a batch-too-large refusal (`KZP02`) of an atomic batch, which is dropped at once with the server's own message as `reason`. |
| `.columnOverwritten` | `table: String`, `pk: String`, `column: String`, `loserValueJson: String`, `winnerMutationId: String`, `conflictMode: String` | — | Raised for each column-level conflict a pull reported, carrying the value that lost as JSON. |
| `.checkpointExpired` | — | — | Raised when the server invalidated the pull token. The next pull restarts the keyset and the closing boundary replaces the local snapshot. |
| `.resetRequired` | `reason: String?` | — | Raised when pull or push returned the reset signal, with `reason` `reset_required`, or when a token named another user than the owner of the local database, with `reason` `identity_changed`, as [Set access token](./set-access-token.md#notes) describes. The client soft-blocks until [Reset](./reset.md) runs. |

## Returns

`@Sendable () -> Void`, the unsubscribe closure. It is safe to call from any thread, including the main actor, because it hands the removal to a dedicated dispatch queue.

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Events arrive on one delivery thread that the client owns, one at a time and in the order the engine emitted them, never on the thread that made the call. A handler may call the client back, because the engine answers on its own thread while the delivery thread waits for the answer.

Attachment statuses from [Watch an attachment](./watch.md) share that thread, so a handler that runs long delays every event and status queued behind it. Hand longer work to another queue, an actor, or a Combine subject, then return. The examples above hand the event to the main actor.

Every handler stays registered until its closure is called, so a screen that subscribes on appear unsubscribes on disappear. [Offline writes](../../sync/offline-writes.md#4-subscribe-to-engine-events) shows the pattern in an app, and [Fetch data](./fetch-data.md) is what a handler re-runs to get the new rows.

## Related reference

- [Fetch data](./fetch-data.md)
- [Outbox depth](./outbox-depth.md)
- [List rejections](./rejections.md)
- [Sync](./sync.md)
- [Kotlin: Subscribe to events](../kotlin/on.md)
- [JavaScript: Subscribe to events](../javascript/on.md)
