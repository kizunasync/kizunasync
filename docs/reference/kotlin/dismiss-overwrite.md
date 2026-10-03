---
title: Dismiss an overwrite
description: Acknowledge one journal entry so it stops appearing in the list.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Dismiss an overwrite

`dismissOverwrite(id)` marks one overwrite journal entry acknowledged. The entry stays in the local database and can be read back with `includeDismissed = true`, but does not appear in the default list a screen shows.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val acknowledged = kizunasync.dismissOverwrite(entryId)
```

### Clear what the user has seen

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
for (entry in kizunasync.overwrites()) {
    kizunasync.dismissOverwrite(entry.id)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | `Long` | Yes | The `id` of the entry, as [List overwrites](./overwrites.md#returns) reports it. |

## Returns

`Boolean`. `true` when an entry carried that id, whether it was already dismissed or not; `false` only when no entry carries that id.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The journal could not be written. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Dismissing changes nothing about the column's value: the peer's write already stands, and this is a read-state flag for the interface, not a way to reassert the local value. To write the column again, apply it again with [Update data](./update-data.md).

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.Engine`.

## Related reference

- [List overwrites](./overwrites.md)
- [Update data](./update-data.md)
- [Inspector](./inspector.md)
- [Swift: Dismiss an overwrite](../swift/dismiss-overwrite.md)
- [JavaScript: Dismiss an overwrite](../javascript/dismiss-overwrite.md)
