---
title: Dismiss a rejection
description: Acknowledge one journal entry so it stops appearing in the list.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Dismiss a rejection

`dismissRejection` marks one journal entry acknowledged. The entry stays in the local database and can be read back, but does not appear in the default list a screen shows.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val acknowledged = kizunasync.dismissRejection(mutationId)
```

### Clear what the user has seen

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
for (entry in kizunasync.rejections()) {
    kizunasync.dismissRejection(entry.mutationId)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `mutationId` | `String` | Yes | The `mutationId` of the entry, as [List rejections](./rejections.md#returns) reports it. |

## Returns

`Boolean`. `true` when an entry carried that id, whether it was already dismissed or not; `false` only when no entry carries that id.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The journal could not be updated. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Dismissing changes nothing about the write itself. The local row was already reverted when the rejection was journalled, so this is a read-state flag for the interface, not a retry: to try the change again, apply it again with [Update data](./update-data.md) after fixing what the server objected to.

A later run that journals the same mutation id replaces the entry and clears the flag, so a repeated failure comes back into view rather than staying hidden. Read the dismissed entries with `rejections(includeDismissed = true)`.

## Related reference

- [List rejections](./rejections.md)
- [Update data](./update-data.md)
- [Subscribe to events](./on.md)
- [Swift: Dismiss a rejection](../swift/dismiss-rejection.md)
- [JavaScript: Dismiss a rejection](../javascript/dismiss-rejection.md)
