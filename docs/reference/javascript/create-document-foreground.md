---
title: Create the document foreground
description: Build the app-became-visible port from a document, catching the returns visibilitychange alone misses.
status: alpha
docType: reference
library: javascript
pageKind: method
audience: app-developer
---

# JavaScript: Create the document foreground

`createDocumentForeground(target)` from `@kizunasync/supabase` builds an [`IForeground`](./types.md#ports) over a `document`-shaped object.

The `createSupabaseKizunaSync` call in `src/kizunasync.ts`, shown on [Initializing](./initializing.md#create-the-app-client), builds one over `document` by itself when neither its `foreground` option nor the driver supplies a port. [The browser driver](./create-web-worker-driver.md) supplies none, so nothing in a standard browser app calls this factory. Read this page to watch a different document, such as an iframe's own, or to see which page events count as a return to the foreground.

## Examples

### Basic

```ts
// src/kizunasync.ts (excerpt)
import { createDocumentForeground } from '@kizunasync/supabase'

const foreground = createDocumentForeground(document)
```

### Pass it to the client

To watch an iframe, pass its `contentDocument` in place of `document`.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createDocumentForeground, createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  foreground: createDocumentForeground(document),
})
```

An explicit `foreground` wins over the driver's port and over the default. Unlike the default, which checks for `document` first, this module reads `document` as it loads, so it does not suit a module a static render imports.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `target` | `IForegroundDocument` | Yes | A `document`-shaped object: `visibilityState`, `addEventListener`, `removeEventListener`, and an optional `defaultView` for `pageshow`. Narrow enough that a test fake can implement it with no DOM lib types. |

## Returns

`IForeground`, the value [Initializing](./initializing.md#parameters) takes as its `foreground` argument.

| Name | Type | Required | Description |
|---|---|---|---|
| `subscribe` | `(onForeground: () => void) => () => void` | — | Fires on a `visibilitychange` to `'visible'`, on the target's own `resume` event, and on a `pageshow` whose `persisted` is `true`. Returns the function that removes all three listeners. |

## Errors

This factory throws nothing.

## Notes

`visibilitychange` alone misses two returns to life that the [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api) defines. A frozen tab runs no timers and no fetch callbacks, and it gets a `resume` event when the browser unfreezes it. A page restored from the back/forward cache gets `pageshow` with `persisted: true`, and it never re-fires `visibilitychange`. The port observes `resume` on the target itself. It observes `pageshow` on `target.defaultView` when that exists, and on the target otherwise.

`createSupabaseKizunaSync` composes this port with `refreshOnForeground` and the reconnect nudge [Initializing](./initializing.md#notes) describes. On [Expo](https://expo.dev) and [React Native](https://reactnative.dev), the Expo driver carries [`createExpoForeground()`](../expo/create-expo-foreground.md) on device, so the composition uses that port and builds no document port.

## Related reference

- [Initializing](./initializing.md)
- [Sync](./sync.md)
- [Types](./types.md)
- [Expo: Create the foreground port](../expo/create-expo-foreground.md)
