---
title: Inspect
description: Read the raw devtools snapshot of the local command queue.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Inspect

`inspect()` answers the same five-field snapshot [`KizunaSyncInspector.snapshot()`](./inspector.md#returns) reads, as a plain `JSONObject` rather than the typed `KizunaSyncInspectorSnapshot`. Most apps call [Inspector](./inspector.md) instead; this function is the one the typed reading is built on.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val raw = kizunasync.inspect()
val depth = raw.optInt("depth", 0)
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This function takes no arguments. |

## Returns

`JSONObject`, decoded from the engine's response, with these keys.

| Name | Type | Required | Description |
|---|---|---|---|
| `queued` | `JSONArray` | — | The head of the outbox, oldest first. |
| `depth` | `Int` | — | The same count [Outbox depth](./outbox-depth.md) returns. |
| `last_mutation_id` | `String?` | — | The exactly-once push watermark: the mutation id of the last entry the server confirmed applied, not the last mutation queued. `null` until a push lands. |
| `cursor` | `String` | — | The durable pull cursor, also on [Checkpoint](./checkpoint.md#returns). |
| `client_id` | `String` | — | The client's current registered identity. It changes after [Reset](./reset.md). |

## Errors

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | The bridge answered with bytes that do not decode to a JSON object. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

`last_mutation_id` is the watermark a completed push advances, not a record of what is queued. A device with ten mutations waiting in the outbox and none pushed answers `null` here even though `depth` reads `10`. [Inspector](./inspector.md) wraps this call, adds the bounded verdict ring, and answers a typed `KizunaSyncInspectorSnapshot`. Reach for `inspect()` directly only when the raw `JSONObject` is what the call site wants.

## Related reference

- [Inspector](./inspector.md)
- [Outbox depth](./outbox-depth.md)
- [Checkpoint](./checkpoint.md)
- [Dispose](./dispose.md)
- [Swift: Inspect](../swift/inspect.md)
