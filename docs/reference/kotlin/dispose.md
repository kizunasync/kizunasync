---
title: Dispose
description: Close the engine and its store, and fail every later call loudly.
status: alpha
docType: reference
library: kotlin
pageKind: method
audience: app-developer
---

# Kotlin: Dispose

`dispose()` shuts down the engine behind the client and clears the table set `from(table)` reads. Every later call to this client fails instead of touching a closed handle: `from(table)` throws `UNKNOWN_TABLE` because its table set is now empty, and every other function throws `KizunaSyncError.Engine` with `ENGINE_UNAVAILABLE` against the shut-down engine.

## Examples

### Basic

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
syncScheduler.stop()
kizunasync.dispose()
```

Stop the [Host scheduler](./scheduler.md) first, so no run starts against the closed engine and fails with `ENGINE_UNAVAILABLE`.

### Before opening another database

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
syncScheduler.stop()
kizunasync.dispose()
kizunasync.create(nextConfig)
syncScheduler.start()
```

`create` on the disposed handle opens the next database. `start()` subscribes the scheduler to the new engine's local writes, which a running scheduler would not do on its own.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `(none)` | — | — | This function takes no arguments. |

## Returns

`Unit`. `dispose()` never throws: it detaches the inspector, if one was built, then shuts the engine down and discards any failure from that shutdown.

## Errors

`dispose()` itself raises nothing. `from(table)` called on the client afterward throws `KizunaSyncError.Engine` with `UNKNOWN_TABLE`, because `dispose()` also clears the table set; every other function throws `KizunaSyncError.Engine` with `ENGINE_UNAVAILABLE`.

## Notes

Call `dispose()` before you build a second `KizunaSyncClient()` over the same database file.

Two open engines on one SQLite file are not supported, so [Initializing](./initializing.md) on a fresh handle has to wait for the previous one to close. The inspector `dispose()` detaches is the same one [`inspector()`](./inspector.md) memoized. A screen holding a reference to it stops receiving updates once this call returns. `dispose()` also cancels the client's internal coroutine scope after the shutdown call. An `unsubscribe` or `unwatch` closure invoked after this call has no scope left to run its cleanup on.

## Related reference

- [Initializing](./initializing.md)
- [Inspect](./inspect.md)
- [Inspector](./inspector.md)
- [Swift: Dispose](../swift/dispose.md)
