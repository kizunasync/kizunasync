---
title: Remove an attachment
description: Forget one attachment row and get back the sandbox path to delete.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Remove an attachment

`attachmentRemove(reference)` deletes one attachment's local queue row outright and answers the sandbox path whose bytes the app still has to delete. Unlike [Cancel an attachment](./attachment-cancel.md), the reference is gone afterward: nothing is left for a later drive or retry to pick up.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import java.io.File

val path = kizunasync.attachmentRemove(reference)
path?.let { File(it).delete() }
```

### Remove before deleting the row it belongs to

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
kizunasync.attachmentRemove(reference)
kizunasync.from("todos").delete().eq("id", todoId).execute()
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column. |

## Returns

`String?`. The sandbox path whose bytes the app still has to delete, or `null` when the row carried no local path or did not exist.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The row could not be written. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The engine only deletes the queue row; it never touches the filesystem itself, so a present return value is a path the app owns and must clean up. A second call against the same reference answers `null`, because the row is already gone.

This is a stronger operation than [Vacuum attachments](./vacuum.md#notes), which only sweeps bytes no row references any more: `attachmentRemove` acts on one reference the app names, at the moment it names it, whether or not the transfer ever finished.

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.Engine`.

## Related reference

- [Get attachment status](./get-status.md)
- [Retry an attachment](./attachment-retry.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Vacuum attachments](./vacuum.md)
- [Swift: Remove an attachment](../swift/attachment-remove.md)
- [JavaScript: Remove an attachment](../javascript/attachment-remove.md)
