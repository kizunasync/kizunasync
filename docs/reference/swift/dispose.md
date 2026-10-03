---
title: Dispose
description: Close the engine and its store, and fail every later call loudly.
status: alpha
docType: reference
library: swift
pageKind: method
audience: app-developer
---

# Swift: Dispose

`dispose()` shuts down the engine behind the client and clears the table set `from(_:)` reads. Every later call to this client fails instead of touching a closed handle: `from(_:)` throws `UNKNOWN_TABLE` because its table set is now empty, and every other method throws `ENGINE_UNAVAILABLE` against the shut-down engine.

## Examples

### Basic

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync

syncScheduler.stop()
await kizunasync.dispose()
```

Stop the [Host scheduler](./scheduler.md) first, so no run starts against the closed engine and fails with `ENGINE_UNAVAILABLE`.

### Before opening another database

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync

syncScheduler.stop()
await kizunasync.dispose()
try await kizunasync.create(nextConfig)
syncScheduler.start()
```

`create(_:)` on the disposed handle opens the next database. `start()` subscribes the scheduler to the new engine's local writes, which a running scheduler would not do on its own.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This method takes no arguments. |

## Returns

`Void`. `dispose()` never throws: it detaches the inspector, if one was built, then shuts the engine down and discards any failure from that shutdown.

## Errors

`dispose()` itself raises nothing. `from(_:)` called on the client afterward throws `UNKNOWN_TABLE`, because `dispose()` also clears the table set; every other method throws `ENGINE_UNAVAILABLE`.

## Notes

Call `dispose()` before you build a second `KizunaSyncClient()` over the same database file.

Two open engines on one SQLite file are not supported, so [Initializing](./initializing.md) on a fresh handle has to wait for the previous one to close. The inspector `dispose()` detaches is the same one [`inspector()`](./inspector.md) memoized. A screen holding a reference to it stops receiving updates once this call returns.

## Related reference

- [Initializing](./initializing.md)
- [Inspect](./inspect.md)
- [Inspector](./inspector.md)
- [Kotlin: Dispose](../kotlin/dispose.md)
