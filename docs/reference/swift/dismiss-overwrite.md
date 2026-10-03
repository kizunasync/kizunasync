---
title: Dismiss an overwrite
description: Acknowledge one journal entry so it stops appearing in the list.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Dismiss an overwrite

`dismissOverwrite(_:)` marks one overwrite journal entry acknowledged. The entry stays in the local database and can be read back with `includeDismissed: true`, but does not appear in the default list a screen shows.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let acknowledged = try await kizunasync.dismissOverwrite(entryId)
```

### Clear what the user has seen

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

for entry in try await kizunasync.overwrites() {
  _ = try await kizunasync.dismissOverwrite(entry.id)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | `Int64` | Yes | The `id` of the entry, as [List overwrites](./overwrites.md#returns) reports it. |

## Returns

`Bool`. `true` when an entry carried that id, whether it was already dismissed or not; `false` only when no entry carries that id.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The journal could not be written. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Dismissing changes nothing about the column's value: the peer's write already stands, and this is a read-state flag for the interface, not a way to reassert the local value. To write the column again, apply it again with [Update data](./update-data.md).

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.engine`.

## Related reference

- [List overwrites](./overwrites.md)
- [Update data](./update-data.md)
- [Inspector](./inspector.md)
- [Kotlin: Dismiss an overwrite](../kotlin/dismiss-overwrite.md)
- [JavaScript: Dismiss an overwrite](../javascript/dismiss-overwrite.md)
