---
title: Inspector
description: Read one coherent snapshot of the local command queue, plus a ring of recent verdicts.
status: alpha
docType: reference
library: swift
pageKind: guide
audience: app-developer
---

# Swift: Inspector

`client.inspector()` builds and memoizes one `KizunaSyncInspector` per client: the first call subscribes it to the engine's event bus, and every later call on the same client answers the same instance. It pairs the raw [Inspect](./inspect.md) snapshot with a bounded ring of the refusals the client has seen, which is otherwise transient once the screen that showed a toast for it moves on.

## Examples

### Read a snapshot

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let inspector = try await kizunasync.inspector()
let snapshot = try await inspector.snapshot()
```

### Show the verdicts that arrived this session

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let inspector = try await kizunasync.inspector()
let stop = inspector.subscribe {
  Task { @MainActor in render(inspector.verdicts()) }
}
```

## Parameters

`KizunaSyncClient.inspector()` takes no arguments.

### `subscribe(_:)`

| Name | Type | Required | Description |
|---|---|---|---|
| `onChange` | `() -> Void` | Yes | Called after every engine event, not only the ones that enter the ring, and after `clear()`. It carries no payload, so a subscriber re-reads `verdicts()`. |

## Returns

| Name | Type | Required | Description |
|---|---|---|---|
| `snapshot()` | `() async throws -> KizunaSyncInspectorSnapshot` | — | One coherent read of the queue: `queued`, `depth`, `lastMutationId`, `cursor`, `clientId`. `lastMutationId` is the push watermark, nil until a push lands, not a record of what is queued. |
| `verdicts()` | `() -> [KizunaSyncInspectorVerdict]` | — | A copy of the ring, oldest first. It holds the 50 most recent entries and is not durable. |
| `subscribe(_:)` | `(@escaping () -> Void) -> () -> Void` | — | Registers `onChange` and returns the unsubscribe function. |
| `clear()` | `() -> Void` | — | Empties the ring and notifies every subscriber. It touches no stored data. |

### One entry of the ring

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `String` | — | The refused mutation, or the offender of a refused batch. |
| `kind` | `KizunaSyncInspectorVerdictKind` | — | `.rejected` for a per-mutation refusal, `.aborted` for an atomic batch the server aborted, `.overwritten` for a column a peer's write took. |
| `reason` | `String` | — | The server's reason code for `.rejected` and `.aborted`. For `.overwritten` it is `"<table>.<column>"` instead, because a conflict mode is a configuration fact rather than a verdict. |
| `at` | `Date` | — | When the client recorded the verdict, from the client's own clock. |

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | `inspector()` could not subscribe to the engine's event bus, because the client has no engine. |

`snapshot()` throws whatever [Inspect](./inspect.md#errors) throws, since it calls that method underneath.

## Notes

`KizunaSyncClient.inspector()` is safe to call more than once: the second and later calls answer the first instance rather than building a second subscription. [Dispose](./dispose.md) detaches it, so a screen that reads `verdicts()` after disposal sees whatever the ring held at that point and stops receiving new entries.

The ring is a short-lived read: it holds only the 50 most recent entries and is lost on restart. [List overwrites](./overwrites.md) is the durable twin for the `.overwritten` kind, backed by a table that survives a restart and carries the whole row rather than the ring's four fields alone.

Swift has no hooks at all, as [Introduction](./introduction.md#what-this-reference-covers) states. Pair `subscribe(_:)` with `@Published`, an `ObservableObject`, or a Combine subject the way [Subscribe to events](./on.md) already is in your app.

## Related reference

- [Inspect](./inspect.md)
- [Dispose](./dispose.md)
- [Subscribe to events](./on.md)
- [List overwrites](./overwrites.md)
- [Types](./types.md)
- [Kotlin: Inspector](../kotlin/inspector.md)
- [JavaScript: Inspector](../javascript/inspector.md)
