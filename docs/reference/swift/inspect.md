---
title: Inspect
description: Read the raw devtools snapshot of the local command queue.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Inspect

`inspect()` answers the same five-field snapshot [`KizunaSyncInspector.snapshot()`](./inspector.md#returns) reads, decoded as a plain dictionary rather than the typed `KizunaSyncInspectorSnapshot`. Most apps call [Inspector](./inspector.md) instead; this method is the one the typed reading is built on.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let raw = try await kizunasync.inspect()
let depth = raw["depth"] as? Int ?? 0
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`[String: Any]`, decoded from the engine's JSON, with these keys.

| Name | Type | Required | Description |
|---|---|---|---|
| `queued` | `[[String: Any]]` | — | The head of the outbox, oldest first. |
| `depth` | `Int` | — | The same count [Outbox depth](./outbox-depth.md) returns. |
| `last_mutation_id` | `String?` | — | The exactly-once push watermark: the mutation id of the last entry the server confirmed applied, not the last mutation queued. `nil` until a push lands. |
| `cursor` | `String` | — | The durable pull cursor, also on [Checkpoint](./checkpoint.md#returns). |
| `client_id` | `String` | — | The client's current registered identity. It changes after [Reset](./reset.md). |

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The bridge answered with bytes that do not decode to a JSON object. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

`last_mutation_id` is the watermark a completed push advances, not a record of what is queued. A device with ten mutations waiting in the outbox and none pushed answers `nil` here even though `depth` reads `10`. [Inspector](./inspector.md) wraps this call, adds the bounded verdict ring, and answers a typed `KizunaSyncInspectorSnapshot`. Reach for `inspect()` directly only when the raw dictionary is what the call site wants.

## Related reference

- [Inspector](./inspector.md)
- [Outbox depth](./outbox-depth.md)
- [Checkpoint](./checkpoint.md)
- [Dispose](./dispose.md)
- [Kotlin: Inspect](../kotlin/inspect.md)
