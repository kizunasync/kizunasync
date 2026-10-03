---
title: Checkpoint
description: Read the durable pull cursor and the soft-block flag.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Checkpoint

`checkpoint()` reads the durable sync state: the cursor the last closed pull boundary wrote, whether the client is soft-blocked, and why. It makes no request.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let state = try await kizunasync.checkpoint()
if state.softBlocked {
  _ = try await kizunasync.reset()
}
```

### Seed a cursor

```swift
// TodoClientTests.swift (excerpt)
import KizunaSync

try await kizunasync.seedCheckpoint("0")
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | `checkpoint()` takes no arguments. |

### `seedCheckpoint(_:)`

| Name | Type | Required | Description |
|---|---|---|---|
| `cursor` | `String` | Yes | Cursor written straight into the local database, without touching rows, tombstones, or the outbox. `"0"` is the bootstrap value a fresh database starts from. |

## Returns

`KizunaSyncCheckpoint`, with these fields.

| Name | Type | Required | Description |
|---|---|---|---|
| `cursor` | `String` | — | Opaque server position. It advances only when a pull sequence closes, never mid-page, and it reads `"0"`, the bootstrap value, before the first pull of a fresh database. Treat it as a token, not as a timestamp. |
| `softBlocked` | `Bool` | — | `true` once the server answered `RESET_REQUIRED`, or once a token named a different user than the one the store belongs to. While it is `true`, pull and push return without a request and the durable cursor is left alone. |
| `softBlockReason` | `String?` | — | `"reset_required"` or `"identity_changed"`, naming which of the two latched the block. `nil` while `softBlocked` is `false`. |

`seedCheckpoint(_:)` returns `Void`.

## Errors

| Code | Condition |
|---|---|
| `STORE` | The local database could not be read or written. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

A cursor that is ahead of the rows the device holds makes the next pull skip everything between, so `seedCheckpoint(_:)` belongs in tests and in a controlled migration rather than in ordinary app code. The safe way to start over is [Reset](./reset.md), which wipes local state and returns the cursor to the bootstrap value.

[Checkpoints](../../sync/consistency-model.md#checkpoints) explains what a closed boundary guarantees, and [Cursors and fencing](../../sync/protocol-overview.md#cursors-and-fencing) covers what the server does with the value.

## Related reference

- [Sync](./sync.md)
- [Pull once](./pull-once.md)
- [Reset](./reset.md)
- [Types](./types.md)
- [Kotlin: Checkpoint](../kotlin/checkpoint.md)
- [JavaScript: Checkpoint](../javascript/checkpoint.md)
