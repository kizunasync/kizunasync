---
title: Reset
description: Wipe local sync state and start again from the bootstrap cursor.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Reset

`reset()` clears every local table the client owns, returns the cursor to its bootstrap value, and hands back the attachment file paths it could not delete itself. It is how a client recovers from a `RESET_REQUIRED` signal and how an app leaves one account for another.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import Foundation
import KizunaSync

let strandedPaths = try await kizunasync.reset()
for path in strandedPaths {
  try? FileManager.default.removeItem(atPath: path)
}
syncScheduler.wake()
```

### On the reset event

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let stop = try await kizunasync.on { event in
  if case .resetRequired = event {
    Task {
      _ = try? await kizunasync.reset()
      syncScheduler.wake()
    }
  }
}
```

`.resetRequired` carries `reason`: `reset_required` when the server's schema gate asks for the reset, and `identity_changed` when a token of another user reached the client. Resetting on every event also drops the previous user's unsynced writes when another user signs in, so check `reason` when those writes matter.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`[String]`, the sandbox paths of the attachment rows that had local bytes before the wipe. The engine has no file port of its own on this path, so deleting those files is the caller's job.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The local database could not be wiped or re-seeded. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

The call removes the rows, the outbox, the tombstones, the dead letters, the rejection journal, the attachment queue, and the client metadata in one transaction, then writes the bootstrap cursor and the configured schema version back. Queued writes are part of what it removes, so anything that has not reached the server is lost. Read [Outbox depth](./outbox-depth.md) first when that matters.

It also clears the soft block, whatever latched it, `RESET_REQUIRED` or an identity change, which is what lets the next [Sync](./sync.md) reach the wire again. It raises `LOCAL_CHANGED` so open screens reload, and no `QUEUE_DEPTH`, so the [Host scheduler](./scheduler.md) does not wake on its own: call its `wake()` after the reset, as the examples do, and the next run pulls again and refreshes `health().needsReset`. A `.byColumn` value set with [Set bucket](./set-bucket.md) lives in the open engine and survives. The owner of the local database is cleared, and every `.byOwner` bucket goes back to unset until a token names the next owner: the token set with [Set access token](./set-access-token.md) survives in memory, so the next pull or push records the user it names, and a fresh token from the next run does the same.

It mints a new `client_id` as well, so a device that switches accounts registers a fresh identity instead of colliding with the registration the previous user already owns. That makes `reset()` the whole account switch: the client stays open, and [Swift and Kotlin](../../getting-started/native-clients.md#8-show-sync-state) shows the button that runs it.

[Lifecycle signals](../../sync/protocol-overview.md#lifecycle-signals) describes when a server sends the signal that makes this necessary.

## Related reference

- [Sync](./sync.md)
- [Checkpoint](./checkpoint.md)
- [Set bucket](./set-bucket.md)
- [Vacuum attachments](./vacuum.md)
- [Kotlin: Reset](../kotlin/reset.md)
- [JavaScript: Reset](../javascript/reset.md)
