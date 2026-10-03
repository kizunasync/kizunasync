---
title: op-sqlite driver
description: Open op-sqlite as the local store on device, and verify it before a release.
status: alpha
docType: reference
library: expo
pageKind: method
audience: app-developer
---

# Expo: op-sqlite driver

`openOpSqliteDriver` names the `@op-engineering/op-sqlite` file for the Rust kernel. It is the alternative to [Open the SQLite driver](./open-expo-driver.md) on device: it replaces the `openExpoDriver('todos.db')` call that [Initializing](./initializing.md) passes to `createSupabaseKizunaSync` in `src/kizunasync.ts`, and nothing else in the app calls it. An app needs this page only when it already depends on op-sqlite for another reason.

It ships behind its own entry point, so Metro does not resolve the optional peer for an app that never imports it. The call is synchronous and never loads the peer, because the Rust kernel holds the only connection to the file. `location` is required, because the locator's whole job is to name the file the Rust kernel opens. It takes either an absolute directory path or the `file://` URI Expo's file-system APIs hand out. The scheme and a trailing slash come off, so the locator reports `<location>/<name>` with a plain directory. The locator carries the same NetInfo and `AppState` ports as `openExpoDriver`. [Verify op-sqlite](./verify-op-sqlite-driver.md) is where a live op-sqlite handle opens, for the five-step gate.

## Examples

### Basic

```ts
// src/kizunasync.ts (excerpt)
import { openOpSqliteDriver } from '@kizunasync/expo/op-sqlite'

const driver = openOpSqliteDriver('todos.db', { location: '/data/kizunasync' })
```

### Pass it to the client

This is `src/kizunasync.ts` from [Initializing](./initializing.md) with the database under the app's document directory. Everything except the driver stays the same.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { openOpSqliteDriver } from '@kizunasync/expo/op-sqlite'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import * as FileSystem from 'expo-file-system/legacy'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openOpSqliteDriver('todos.db', { location: FileSystem.documentDirectory ?? undefined }),
  config,
})
```

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | The database file name, joined with `location` to make the path the locator reports. |
| `options` | `Pick<TOpenOpSqliteOptions, 'location'>` | Yes | The directory for the database file. The type accepts `{}`, but a call without `location` throws. |
| `options.location` | `string` | Yes | Absolute directory for the database file, as a path or a `file://` URI. The scheme and a trailing slash are removed before it is joined with `name`. Required, because the Rust kernel has to be told which file to open. |

## Returns

`IStoreLocator`, returned synchronously.

| Name | Type | Required | Description |
|---|---|---|---|
| `databasePath` | `string` | — | `location` joined with `name`. [Rust engine](./rust-engine.md) opens that file over UniFFI on the app client's first engine call. |
| `loadNativeEngine` | `() => TNativeEngineLoadResult` | — | Loads the [Rust engine](./rust-engine.md) through `@kizunasync/rn-uniffi`, the same loader [`openExpoDriver`](./open-expo-driver.md) carries on device. The app client calls it once, on its first engine call. |
| `platformPorts.connectivity` | `IConnectivity` | — | The NetInfo port [`createExpoConnectivity()`](./create-expo-connectivity.md) builds with its default gate, which the app client follows when it is given no `connectivity` option. |
| `platformPorts.foreground` | `IForeground` | — | The `AppState` port [`createExpoForeground()`](./create-expo-foreground.md) builds, which the app client follows when it is given no `foreground` option. |

## Errors

`openOpSqliteDriver` throws a plain `Error` rather than a typed engine error, because it runs before the engine exists, while `src/kizunasync.ts` loads.

| Message | Condition |
|---|---|
| `openOpSqliteDriver requires options.location so the Rust engine can open the same file` | `location` was omitted or empty. |

A missing or unlinked op-sqlite peer does not fail this call, because the call never loads it. [`verifyOpSqliteDriver`](./verify-op-sqlite-driver.md) is where that shows up, as a failed check.

## Notes

This path is native only. There is no web build of op-sqlite, so an app that also runs on [Expo](https://expo.dev) web keeps [`openExpoDriver`](./open-expo-driver.md) for that target.

Only the `file://` scheme and one trailing slash come off `location`; nothing else is decoded, so a percent-encoded URI passes through as it arrived.

Run [Verify op-sqlite](./verify-op-sqlite-driver.md) on a device before a release that ships this driver.

A passing run is evidence for the five operations it performs, and for nothing else. [Match the test to the claim](../../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) draws that distinction.

[Drivers and the TCK](../drivers-and-tck.md#what-a-driver-needs-beyond-the-corpus) lists the obligations a driver carries past the corpus, including the cursor and attachment obligations that any store swap has to keep.

## Related reference

- [Verify op-sqlite](./verify-op-sqlite-driver.md)
- [Open the SQLite driver](./open-expo-driver.md)
- [Initializing](./initializing.md)
- [Rust engine](./rust-engine.md)
- [Drivers and the TCK](../drivers-and-tck.md)
