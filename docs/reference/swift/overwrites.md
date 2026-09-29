---
title: List overwrites
description: Read the journal of local column values a peer's write replaced.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: List overwrites

`overwrites(includeDismissed:)` reads the local journal a pull writes when a column this device changed loses to a peer's write for the same row and column: the local value is replaced, and the entry records what was lost and who won. Each entry carries the losing value, so a screen can tell the user their edit did not survive.

## Examples

### Basic

```swift
// TodoApp/TodoListView.swift (excerpt)
import KizunaSync

let entries = try await kizunasync.overwrites()
for entry in entries {
  print("\(entry.table).\(entry.column) lost to \(entry.winnerMutationId)")
}
```

### Show the value that was lost

```swift
// TodoApp/TodoListView.swift (excerpt)
import Foundation
import KizunaSync

let entries = try await kizunasync.overwrites()
guard let entry = entries.first, let data = entry.loserValueJson.data(using: .utf8) else { return }
let loserValue = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `includeDismissed` | `Bool` | No | Whether entries already acknowledged with [Dismiss an overwrite](./dismiss-overwrite.md) are returned. Default: `false`. |

## Returns

`[KizunaSyncOverwrite]`, newest first, with these fields.

| Name | Type | Required | Description |
|---|---|---|---|
| `id` | `Int64` | — | The journal row's own identifier, the value [Dismiss an overwrite](./dismiss-overwrite.md#parameters) takes. |
| `table` | `String` | — | The synced table the overwritten row belongs to. |
| `pk` | `String` | — | The row's primary key. |
| `column` | `String` | — | The column whose value was replaced. |
| `loserValueJson` | `String` | — | The value this device wrote, before the peer's write replaced it, encoded as JSON. |
| `winnerMutationId` | `String` | — | The exactly-once identifier of the peer write that won. |
| `conflictMode` | `String` | — | The rule that decided it: `"arrival"` or `"hlc"`, from that table's [`conflictMode`](./initializing.md#parameters). |
| `winnerSeq` | `String?` | — | The changelog sequence the winning write arrived on, from the pull page that recorded the conflict. |
| `at` | `Int64` | — | When the journal recorded it, in milliseconds since the Unix epoch. |
| `dismissed` | `Bool` | — | Whether the entry has been acknowledged. Always `false` unless `includeDismissed` is `true`. |

## Errors

| Code | Condition |
|---|---|
| `STORE` | The journal could not be read. |
| `ENGINE_UNAVAILABLE` | The bridge answered with an envelope carrying no code, which is not a gradeable failure. |
| `ENGINE_UNAVAILABLE` | The client has no engine because [Initializing](./initializing.md) has not run. |

## Notes

An overwrite is a column-level outcome, not a row rejection: the mutation that wrote the losing value was still accepted, and only this one column's value came from the peer instead. The row and every other column it carries reflect the peer's push. [Conflict resolution](../../sync/conflict-resolution.md) explains when a table resolves by arrival order and when it resolves by the origin clock.

[Inspector](./inspector.md#returns) also records a `.overwritten` entry in its short-lived ring the moment the event fires, with `reason` set to `"<table>.<column>"`. This journal is the durable twin: it survives a restart and carries the full row, while the ring is for the session a screen was open.

This method reaches the kernel through the same JSON-RPC `call` every typed method uses underneath; it behaves like any other client method and raises the same `KizunaSyncError.engine`.

## Related reference

- [Dismiss an overwrite](./dismiss-overwrite.md)
- [Inspector](./inspector.md)
- [List rejections](./rejections.md)
- [Types](./types.md)
- [Kotlin: List overwrites](../kotlin/overwrites.md)
- [JavaScript: List overwrites](../javascript/overwrites.md)
