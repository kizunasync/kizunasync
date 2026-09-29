---
title: Watch an attachment
description: Receive a status snapshot on every transition of one attachment.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Watch an attachment

`watch(_:onStatus:)` registers a listener for one reference and returns the closure that removes it. The listener is handed the current status right away, so a view has something to render before any transfer moves.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let stop = try await kizunasync.watch(reference) { status in
  Task { @MainActor in render(status) }
}
```

### Stop with the view

```swift
// TodoApp/AttachmentView.swift
import KizunaSync
import SwiftUI

struct AttachmentView: View {
  let reference: String
  @State private var stop: (@Sendable () -> Void)?
  @State private var status: KizunaSyncAttachmentStatus?

  var body: some View {
    Text(status?.state ?? "missing")
      .task(id: reference) {
        stop?()
        stop = try? await kizunasync.watch(reference) { next in
          Task { @MainActor in status = next }
        }
      }
      .onDisappear { stop?() }
  }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column. Several listeners may watch the same reference. |
| `onStatus` | `@Sendable (KizunaSyncAttachmentStatus) -> Void` | Yes | Called with the current status when the watch is registered, and again whenever the engine delivers a round for this reference. It runs on the delivery thread the client owns, in emission order, and it may call back into the client. |

## Returns

`@Sendable () -> Void`, the unwatch closure. It is safe to call from any thread, including the main actor, because it hands the removal to a dedicated dispatch queue.

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The status delivered on registration reaches this listener alone, so adding a second watcher never re-fires the first. A reference with no queue row is reported as the state `missing` with no path, rather than as nothing at all. The fields are the ones [Get attachment status](./get-status.md#returns) documents.

Rounds are delivered when the engine has news to report: after [Sync](./sync.md) drives the queue, after [Attach a file](./from-file.md) imports bytes, and after [Resolve a download](./resolve-download.md) fetches them. There is no timer behind it, so a long upload reports its confirmed offset at those points rather than continuously.

Statuses arrive on the same delivery thread as the events of [Subscribe to events](./on.md), one at a time and in the order the engine produced them. Because that thread is not the caller's, the status handed over on registration can reach the listener after `watch(_:onStatus:)` has returned. A listener may call the client back, because the engine answers on its own thread. A listener that runs long delays every status and event queued behind it, so hand longer work to another queue or an actor, then return.

## Related reference

- [Get attachment status](./get-status.md)
- [Attach a file](./from-file.md)
- [Resolve a download](./resolve-download.md)
- [Subscribe to events](./on.md)
- [Kotlin: Watch an attachment](../kotlin/watch.md)
- [JavaScript: Watch an attachment](../javascript/watch.md)
