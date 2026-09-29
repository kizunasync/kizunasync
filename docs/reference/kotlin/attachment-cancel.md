---
title: Cancel an attachment
description: Stop one transfer at the app's request without spending the retry budget.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Cancel an attachment

`attachmentCancel(reference)` stops one attachment's transfer at the app's request. The row lands `failed` but not `permanent`, so the next drive may take it again; canceling is not a budget charge.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
val canceled = kizunasync.attachmentCancel(reference)
```

### Let the user stop a large upload

```kotlin
// app/src/main/kotlin/com/example/todo/TodoScreen.kt (excerpt)
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import kotlinx.coroutines.launch

Button(onClick = { scope.launch { kizunasync.attachmentCancel(reference) } }) {
    Text("Cancel upload")
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column. |

## Returns

`Boolean`. `true` when a row carried the reference, `false` when none did.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The row could not be written. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Cancel does not stop bytes already in flight to the transport mid-request. It marks the row so the queue stops driving it. Unlike an ordinary transfer failure, it does not count against `attachmentAttempts`. That difference tells a canceled row apart from a budget-stopped one in [Get attachment status](./get-status.md#returns): both read `state: "failed"`, and only the budget-stopped one reads `permanent: true`.

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.Engine`.

## Related reference

- [Get attachment status](./get-status.md)
- [Retry an attachment](./attachment-retry.md)
- [Remove an attachment](./attachment-remove.md)
- [Watch an attachment](./watch.md)
- [Swift: Cancel an attachment](../swift/attachment-cancel.md)
- [JavaScript: Cancel an attachment](../javascript/attachment-cancel.md)
