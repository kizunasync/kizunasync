---
title: Retry an attachment
description: Take a permanently failed attachment back and make it a drive candidate again.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Retry an attachment

`attachmentRetry(_:)` forgives a permanently failed attachment's transfer budget: the row returns to `queued` with its attempt count cleared, so the next drive claims it again.

## Examples

### Basic

```swift
// TodoApp/AttachmentView.swift (excerpt)
import KizunaSync

let retried = try await kizunasync.attachmentRetry(reference)
```

### Offer retry only on a permanent failure

```swift
// TodoApp/AttachmentView.swift (excerpt)
import KizunaSync

if let status = try await kizunasync.getStatus(reference), status.permanent {
  _ = try await kizunasync.attachmentRetry(reference)
}
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `reference` | `String` | Yes | The value stored in the row's attachment column, as [Attach a file](./from-file.md#returns) produced it. |

## Returns

`Bool`. `true` when a row carried the reference, `false` when none did.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The row could not be written. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

Retrying clears every trace of the spent budget: `state` returns to `queued`, `permanent` to `false`, and the attempt count to zero, so the row reads exactly like one that has never been driven. It does nothing to a row that is merely `failed` and still retryable; the next scheduled drive already claims that one on its own. Reach for this only after the budget is spent, which [Get attachment status](./get-status.md#returns) reports as `permanent: true`; that budget is `attachmentAttempts` in [Initializing](./initializing.md#parameters), five attempts by default.

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.engine`.

## Related reference

- [Get attachment status](./get-status.md)
- [Cancel an attachment](./attachment-cancel.md)
- [Remove an attachment](./attachment-remove.md)
- [Watch an attachment](./watch.md)
- [Kotlin: Retry an attachment](../kotlin/attachment-retry.md)
- [JavaScript: Retry an attachment](../javascript/attachment-retry.md)
