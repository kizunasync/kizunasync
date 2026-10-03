---
title: Cancel an attachment
description: Stop one transfer at the app's request without spending the retry budget.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Cancel an attachment

`attachmentCancel(_:)` stops one attachment's transfer at the app's request. The row lands `failed` but not `permanent`, so the next drive may take it again; canceling is not a budget charge.

## Examples

### Basic

```swift
// TodoApp/AttachmentView.swift (excerpt)
import KizunaSync

let canceled = try await kizunasync.attachmentCancel(reference)
```

### Let the user stop a large upload

```swift
// TodoApp/AttachmentView.swift (excerpt)
import KizunaSync
import SwiftUI

Button("Cancel upload") {
  Task { _ = try? await kizunasync.attachmentCancel(reference) }
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column. |

## Returns

`Bool`. `true` when a row carried the reference, `false` when none did.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The row could not be written. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Cancel does not stop bytes already in flight to the transport mid-request. It marks the row so the queue stops driving it. Unlike an ordinary transfer failure, it does not count against `attachmentAttempts`. That difference tells a canceled row apart from a budget-stopped one in [Get attachment status](./get-status.md#returns): both read `state: "failed"`, and only the budget-stopped one reads `permanent: true`.

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.engine`.

## Related reference

- [Get attachment status](./get-status.md)
- [Retry an attachment](./attachment-retry.md)
- [Remove an attachment](./attachment-remove.md)
- [Watch an attachment](./watch.md)
- [Kotlin: Cancel an attachment](../kotlin/attachment-cancel.md)
- [JavaScript: Cancel an attachment](../javascript/attachment-cancel.md)
