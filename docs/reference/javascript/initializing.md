---
title: Initializing
description: Create the JavaScript app client once, at module scope, against a provisioned Supabase project.
status: alpha
docType: reference
library: javascript
pageKind: initializing
audience: app-developer
---

# JavaScript: Initializing

`createSupabaseKizunaSync(options)` builds the app client over a Supabase project that `kizunasync init` has provisioned. It derives the protocol remote, the session gate, the Storage transfer, and the Realtime doorbell from the supabase-js client and the config you pass, then hands everything to `createKizunaSync`. `createKizunaSync(driver, remote, config, options?)` builds the same client without the Supabase composition, for a hand-assembled remote.

An app creates the client once, at module scope, in `src/kizunasync.ts`, and every other file imports it from there. Creating it checks the config and opens nothing: the engine opens, and sync starts, on the first call that needs them, so the module is safe to import during a static render or server-side rendering. [Vite](../../getting-started/vite.md) wires that module into a browser app from install to the first synced row, and [Vanilla JavaScript](../../getting-started/vanilla-js.md) does the same without a framework.

## Examples

### Create the app client

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
})
```

That is the whole module. [Open the browser driver](./create-web-worker-driver.md) brings the browser's network signal, and the composition watches the document for the tab coming back, so no platform port is passed by hand. The client follows `supabase.auth` on its own: an app with its own sign-in screen signs in with supabase-js, and the next pull runs under that session. The engine fills the `byOwner` bucket with the signed-in user, so no [`setBucket`](./set-bucket.md) call is needed for it.

### Use it from any file

```ts
// src/todo-list.ts
import { kizunasync } from './kizunasync'

const { data } = await kizunasync.from('todos').select('id, title, done')
```

The first call that needs the engine opens it, here the read, which answers from the local database at once. The automatic loop starts with that open and runs its first sync right away, so the server's rows arrive without a call to [`sync()`](./sync.md), and [Subscribe to events](./on.md) tells a view when to read again.

### Sign in anonymously on the first run

An app whose first screen has no sign-in passes `anonymousSignIn: true`. Anonymous sign-ins must be enabled on the Supabase project.

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  anonymousSignIn: true,
})
```

When a sync attempt finds no session, the client calls [`recoverAnonymousSession`](./recover-anonymous-session.md), which restores a persisted or refreshable session first and signs in a new anonymous user only when there is none. A recovery that fails, for example because the network drops mid-request, fails only that attempt, and the loop retries on its next one.

### With attachments

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebFileStore, createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byOwner('user_id'),
      attachments: { image_path: attachment('todo-images') },
    },
  },
})

const fileStore = createWebFileStore()

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  fileStore,
})
```

A `fileStore` alone is enough: the composition builds [the Storage transfer](./create-supabase-transfer.md) over the same client. [Browser file store](./create-web-file-store.md) opens its sandbox on the first attachment call that reads or writes bytes, so building it here touches no storage, and a browser without OPFS fails that call with `STORE_UNAVAILABLE` rather than the module's import. The attachment column borrows `user_id` from the `byOwner` bucket as the owner column its object keys derive from. Omitting either port while a table declares `attachment()` throws [`ATTACHMENT_PORTS_MISSING`](../../operations/troubleshooting.md#attachment_ports_missing).

### Without the Supabase composition

```ts
// src/kizunasync.ts
import { createKizunaSync, defineConfig } from '@kizunasync/core'
import { createRpcRemote } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({ tables: { todos: { sync: 'read-write' } } })

export const kizunasync = createKizunaSync(createWebWorkerDriver('todos.db'), createRpcRemote(supabase), config)
```

This client reads no session of its own. supabase-js still attaches its session to each RPC call, but the engine learns who the user is only from the tokens the app passes to [Set access token](./set-access-token.md), and a `byOwner` bucket stays unset until one arrives.

## Parameters

`createSupabaseKizunaSync(options)`:

| Name | Type | Required | Description |
|---|---|---|---|
| `supabase` | `SupabaseClient` | Yes | The supabase-js client. Its `auth` slice gates every pull and push, its `realtime` slice backs the derived doorbell, and its `supabaseUrl` and `supabaseKey` seed `nativeHttpRemote` when both are strings. |
| `driver` | `IStoreLocator` | Yes | The [SQLite](https://grokipedia.com/page/SQLite) database the Rust kernel opens, or the engine the driver already runs, plus the platform's own network and foreground signals as `platformPorts`. [Open the browser driver](./create-web-worker-driver.md) returns one for the browser. |
| `config` | `TKizunaSyncConfig` | Yes | The resolved value [Define config](./define-config.md#returns) returns. |
| `anonymousSignIn` | `boolean \| { captchaToken: () => Promise<string> }` | No | When the session read before a pull or push finds no session, calls [`recoverAnonymousSession`](./recover-anonymous-session.md) and reads the session again. `{ captchaToken }` supplies the token a captcha-protected project needs for that sign-in. The recovery runs under `sessionTimeoutMs`, and a failed or timed-out recovery fails that attempt, so the next attempt tries again. Default: none, so the app signs in by itself and the gate only reads. |
| `connectivity` | `IConnectivity` | No | Network port. A run reaches no wire while `isOnline()` is false, and a false to true transition wakes the scheduler. Default: the driver's `platformPorts.connectivity`, else always online. |
| `fileStore` | `IFileStore` | No | Local blob sandbox for attachment bytes. Required when any table declares `attachment()`. Default: none. |
| `transfer` | `ITransfer` | No | Byte mover for attachments. Default: [the Supabase Storage transfer](./create-supabase-transfer.md) over the same client when `fileStore` is set, none otherwise. |
| `wakeup` | `IWakeup` | No | Server-change hint, a debounced pull now and never a data path. Default: [the Realtime doorbell](./create-realtime-wakeup.md) over `Object.keys(config.tables)` when `realtimeWakeups` is true in the config, none otherwise. |
| `wakeupOptions.topicPrefix` | `string` | No | Channel topic prefix on the derived doorbell. Ignored when `wakeup` is passed. Default: `'kizunasync'`. |
| `wakeupOptions.private` | `boolean` | No | Opens each derived channel as private, so [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#how-it-works) gates it. Default: `true`. |
| `wakeupOptions.logger` | `ILogger` | No | Sink for the doorbell's channel transitions. Default: the logger built from `logging`. |
| `wakeupOptions.setTimer` / `wakeupOptions.clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Timer pair for the doorbell's re-subscribe backoff. Default: the platform timers. |
| `remoteOptions.localOnlyColumns` | `readonly string[]` | No | Device-only columns stripped from every mutation before push. Pull is unaffected. Default: none. |
| `remoteOptions.requestTimeoutMs` | `number` | No | How long one pull or push may take before the request is aborted and the attempt fails retryably. A value at or below `0` disables the deadline. Default: `30000`. |
| `foreground` | `IForeground` | No | App-became-visible port. Default: the driver's `platformPorts.foreground`, else [the document source](./create-document-foreground.md) on the web, which fires on `visibilitychange` to visible, on `resume`, and on a `pageshow` whose `persisted` is true; none where `document` is undefined. The browser driver carries no foreground port, so a browser app gets the document source. |
| `refreshOnForeground` | `boolean` | No | When true, a foreground signal calls `auth.refreshSession()` and applies the new token before the scheduler wakes. A failed refresh is logged, and the wake runs regardless. Default: `true`. |
| `sessionTimeoutMs` | `number` | No | How long `auth.getSession()` before every pull and push, the anonymous recovery, and the foreground `auth.refreshSession()` may take before the attempt fails retryably with `AUTH_SESSION_TIMEOUT`. A value at or below `0` disables the deadline. Default: `DEFAULT_SESSION_TIMEOUT_MS` (`10000`). |
| `pollIntervalMs` | `number` | No | Jittered poll fallback. Above `0` the engine reschedules a run at a random point between half the interval and the whole interval. A `pollIntervalMs` in [Define config](./define-config.md#parameters) wins over this option. Default: `15000`. |
| `shouldSyncAutomatically` | `() => boolean` | No | Asked on every automatic wake: the first attempt when the loop starts, the poll tick, a return to connectivity, a Realtime wakeup, a return to the foreground, and a local write. While it answers `false` the wake starts no run and leaves [Sync health](./sync-health.md) as it was. An explicit [`sync()`](./sync.md) runs regardless. Default: none, so every automatic wake runs. |
| `setTimer` / `clearTimer` | `(callback: () => void, delayMs: number) => unknown` / `(handle: unknown) => void` | No | Timer pair for the poll fallback and the session deadlines. Default: the platform `setTimeout` and `clearTimeout`. |
| `schemaVersion` | `number` | No | The schema version carried on every pull and push and stored in the checkpoint. Default: `1`. |
| `inspector` | `boolean` | No | Builds [the Inspector](./inspector.md) handle. Default: on when `process.env.NODE_ENV` is `'development'` or `'test'`, off otherwise, including a runtime without `process`. |
| `logging.level` | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'` | No | Lowest level emitted. Default: `'silent'`. |
| `logging.logger` | `ILogger` | No | Bring-your-own sink. When set, every log is forwarded to it verbatim and the level is not consulted. Default: none. |
| `clientId` | `string` | No | Identifies this client on the wire and in the server's client registry, which keys rows by this value. Must be a uuid string: a value of any other shape throws `TEngineError` with code `CONFIG_INVALID` and the message `clientId "<value>" is not a uuid (the server registry keys clients by one)`. Default: a uuid v4 minted when the client is built. `reset()` mints a fresh one, so a device that switches accounts registers another identity instead of colliding with the previous user's registration. |
| `now` | `() => string` | No | ISO timestamp source for mutations and journal rows. Default: `new Date().toISOString()`. |
| `uuid` | `() => string` | No | Id minting for mutation ids and for a primary key the caller omitted. Default: `crypto.randomUUID()` where the runtime exposes it. |
| `nativeHttpRemote.url` | `string` | No | Project URL the [UniFFI](https://mozilla.github.io/uniffi-rs/) engine opens its own HTTP remote against. Default: the client's `supabaseUrl`. |
| `nativeHttpRemote.publishableKey` | `string` | No | Publishable key for that remote. Default: the client's `supabaseKey`. `anonKey` is also accepted as an alias. |
| `nativeHttpRemote.accessToken` | `string` | No | Initial user [JWT](https://grokipedia.com/page/JSON_Web_Token) for that remote. Later rotations go through [Set access token](./set-access-token.md). Default: none. |
| `uniffiHandle` | `TUniffiHandle` | No | Pre-linked UniFFI handle (`create`, `call`, `callAsync`, `subscribe`, `unsubscribe`, `shutdown`), preferred over probing `@kizunasync/rn-uniffi`. Default: none. |

`createKizunaSync(driver, remote, config, options?)` takes the same `options` minus `supabase`, `anonymousSignIn`, `wakeupOptions`, `remoteOptions`, `refreshOnForeground`, and `sessionTimeoutMs`, which belong to the Supabase composition:

| Name | Type | Required | Description |
|---|---|---|---|
| `driver` | `IStoreLocator` | Yes | The SQLite database the Rust kernel opens, or the engine the driver already runs, with the driver's `platformPorts`. |
| `remote` | `IProtocolRemote` | Yes | The `pull` and `push` pair. [Create the RPC remote](./create-rpc-remote.md) builds it over supabase-js. |
| `config` | `TKizunaSyncConfig` | Yes | The resolved value [Define config](./define-config.md#returns) returns. |
| `options` | `IKizunaSyncOptions` | No | `wakeup` and `transfer` are taken as passed, with no derivation. `connectivity` and `foreground` fall back to the driver's `platformPorts`, and `foreground` has no document default here. Default: `{}`. |

## Returns

An `IKizunaSync` client. It is a plain object, so members can be destructured. Building it opens nothing. The first call to any member opens the engine, once for the client's lifetime, except for `connectivity`, `setRemoteAccessToken`, `dispose`, and a read of the `inspector` or `attachments` property.

| Name | Type | Required | Description |
|---|---|---|---|
| `from` | `(table: string) => ILocalFromBuilder` | — | Entry point for [Fetch data](./fetch-data.md), [Insert data](./insert-data.md), [Update data](./update-data.md), and [Delete data](./delete-data.md). A table absent from the config throws `UNKNOWN_TABLE` at once. `from()` itself opens nothing; awaiting the builder does. |
| `on` | `(handler: (event: TEngineEvent) => void) => () => void` | — | Engine event subscription. See [Subscribe to events](./on.md#returns). |
| `setBucket` | `(params: TBucketParams) => void` | — | Fills a `byColumn` bucket value; the engine fills a `byOwner` bucket itself. See [Set bucket](./set-bucket.md#parameters). |
| `sync` | `() => Promise<void>` | — | One push then pull cycle. See [Sync](./sync.md). |
| `pullOnce` | `() => Promise<void>` | — | See [Pull once](./pull-once.md). |
| `pushOnce` | `() => Promise<void>` | — | See [Push once](./push-once.md). |
| `getCheckpoint` | `() => Promise<TCheckpointState>` | — | See [Checkpoint](./checkpoint.md). |
| `getOutboxDepth` | `() => Promise<number>` | — | See [Outbox depth](./outbox-depth.md). |
| `getSyncHealth` | `() => ISyncHealth` | — | Synchronous snapshot of the automatic loop. See [Sync health](./sync-health.md#returns). |
| `onSyncHealth` | `(listener: (health: ISyncHealth) => void) => () => void` | — | Every loop transition. See [Sync health](./sync-health.md). |
| `rejections` | `(options?: { includeDismissed?: boolean }) => Promise<TRejectionRecord[]>` | — | See [List rejections](./rejections.md). |
| `dismissRejection` | `(mutationId: TUuid) => Promise<void>` | — | See [Dismiss a rejection](./dismiss-rejection.md). |
| `overwrites` | `(options?: { includeDismissed?: boolean }) => Promise<TOverwriteRecord[]>` | — | See [List overwrites](./overwrites.md). |
| `dismissOverwrite` | `(id: number) => Promise<void>` | — | See [Dismiss an overwrite](./dismiss-overwrite.md). |
| `reset` | `() => Promise<void>` | — | See [Reset](./reset.md). |
| `seedCheckpoint` | `(cursor: string) => Promise<void>` | — | Writes a persisted durable cursor so the next pull carries it. |
| `dispose` | `() => void` | — | Releases the sync scheduler, the connectivity and foreground subscriptions, the wakeup channel, and the auth state subscription, and closes the engine, which terminates the browser worker where one is running. Called before the first use, it opens nothing: every later engine call fails with `ENGINE_UNAVAILABLE` saying the client was disposed, and [Sync health](./sync-health.md) reads `idle`. |
| `engine` | `'rust'` | — | Which core is executing this client. Diagnostics, not a switch, and one value: the client runs the Rust core or fails its open with `ENGINE_UNAVAILABLE`. Reading it opens the engine, and throws the open's error when the open fails. |
| `inspector` | `IInspector \| null` | — | `null` when the inspector is off. Reading the property opens nothing; its methods open the engine. See [Inspector](./inspector.md). |
| `attachments` | `IAttachmentClient` | — | Always present. Reading the property opens nothing; its methods open the engine. On a client built without both `fileStore` and `transfer`, every method rejects with `ATTACHMENT_PORTS_MISSING` and `watch` returns an unsubscribe that does nothing. See [Attach a file](./from-file.md). |
| `connectivity` | `IConnectivity` | — | The network port the automatic loop follows: the `connectivity` option, else the driver's `platformPorts.connectivity`, else always online. Reading it opens nothing. [React: useSyncStatus](../react/use-sync-status.md) and [Vue: useSyncStatus](../vue/use-sync-status.md) read it for `isOnline`. |
| `setRemoteAccessToken` | `(token: string \| null) => Promise<void>` | — | Before the first use it opens nothing: the client keeps the latest token and hands it to the engine ahead of every other call when the engine opens. See [Set access token](./set-access-token.md). |

## Errors

Creating the client throws only for a configuration it can check on its own:

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | A table declares `attachment()` but `fileStore` or `transfer` is absent. [Troubleshooting](../../operations/troubleshooting.md#attachment_ports_missing) shows the fix. |
| `CONFIG_INVALID` | `clientId` was supplied and is not a uuid string; a table's `sync` or `conflict` value is not one the client recognizes; `pullLimit` is not a positive integer; `schemaVersion` is not an integer; `pollIntervalMs` is negative or not a number; or an attachment column resolves no owner column, because its `attachment()` passed no `ownerColumn` and the table has no `byOwner` bucket to borrow it from. |

Opening the engine happens on the first call that needs it, and a failed open surfaces there, never at import:

| Code | Condition |
|---|---|
| `ENGINE_UNAVAILABLE` | This runtime can load no Rust engine, such as Expo Go or a Node platform without its N-API package, and the message names what to install. Also raised by every engine call on a client disposed before its first use. |
| `CONFIG_INVALID` | The engine's own config check refused a table, such as `byOwner('id')`, because the engine cannot fill the primary key column with the owner. |
| Any other catalog code | A store the engine could not open, such as `STORE_BUSY` when another process holds the database. |

A failed open is kept as one typed `TEngineError`, and the client never tries to open again. The call that opened it and every later promise-returning call reject with that same error, `setBucket` and a read of `engine` throw it, `on` and the attachment and inspector subscriptions stay silent, and [Sync health](./sync-health.md) reports it: `getSyncHealth()` returns phase `backoff` with the error as `lastError`, and an `onSyncHealth` listener hears that snapshot once. A hook built on the client therefore shows one stable error state instead of crashing a render. [Open the browser driver](./create-web-worker-driver.md#errors) lists how a browser store that cannot open fails.

## Notes

The composition reads `auth.getSession()` before every pull and push, applies the token to the engine, and subscribes to `auth.onAuthStateChange` so a refreshed session reaches the engine without another call from you. A missing session raises the retryable `AUTH_SESSION_MISSING`, after the anonymous recovery when `anonymousSignIn` is set, rather than falling back to the publishable key, which would run the pull and push RPCs as the [`anon` role](https://supabase.com/docs/guides/database/postgres/row-level-security#authenticated-and-unauthenticated-roles): those RPCs are granted only to `authenticated`, so an anon call would fail a different way. [Create the Storage transfer](./create-supabase-transfer.md#parameters) documents the separate publishable-key fallback a resumable upload takes when the Storage bucket allows it.

The first session token the engine sees names the user the local database belongs to. The engine keeps that owner in the database, fills every `byOwner` bucket with it, and fills the owner column of an [insert](./insert-data.md) that leaves it out. After a restart both are filled from the database before any session is read, offline included. A token of another user on the same device soft-blocks sync with `identity_changed` until [`reset()`](./reset.md) runs, so writes queued under one user never go out under another. An account switch is a `reset()`, which [Sync soft-blocks after switching accounts](../../operations/troubleshooting.md#sync-soft-blocks-after-switching-accounts) walks through. [`setBucket`](./set-bucket.md) is for `byColumn` buckets, whose value only the app knows.

On a foreground signal the composition refreshes the session, calls `realtime.connect()` when the client holds channels but the socket reports disconnected, and only then wakes the scheduler. That reconnect matters because a backgrounded tab can lose its socket without a status event, which Supabase describes in [handling silent disconnections](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794#understanding-the-problem-why-realtime-stops-silently).

On Expo and [React Native](https://reactnative.dev), [Expo: Open the SQLite driver](../expo/open-expo-driver.md) returns a driver that carries the device's own network and foreground ports, and [Expo: Initializing](../expo/initializing.md#parameters) lists the options that composition takes.

## Next steps

1. Provide the client: import `kizunasync` from `src/kizunasync.ts` wherever the UI needs it. [React: Initializing](../react/initializing.md) and [Vue: Initializing](../vue/initializing.md) hand it to the component tree, and [Vanilla JavaScript](../../getting-started/vanilla-js.md#4-provide-it-to-the-app) imports it from the entry file.
2. Sign in: sign in with supabase-js wherever your app already does, as Supabase describes in [Auth](https://supabase.com/docs/guides/auth), or pass `anonymousSignIn: true` when the first run has no sign-in screen.
3. Read: [Fetch data](./fetch-data.md) answers from the local database, and [Subscribe to events](./on.md) tells a view when to read again.
4. Write: [Insert data](./insert-data.md), [Update data](./update-data.md), and [Delete data](./delete-data.md) commit locally and queue the change for the server.
5. Show sync state: [Sync health](./sync-health.md) and [Outbox depth](./outbox-depth.md) feed an indicator.

Nothing else has to run for the data to move. The client syncs once as soon as it opens, after every local write, on a poll every 15 seconds or so (a random point between half the interval and the whole of it), when the network or the tab comes back, and on a Realtime doorbell signal, so [Sync](./sync.md) is for a **Sync now** button, a pull-to-refresh, or a test.

## Related reference

- [Installing](./installing.md)
- [Define config](./define-config.md)
- [Sync](./sync.md)
- [List overwrites](./overwrites.md)
- [Open the browser driver](./create-web-worker-driver.md)
- [React: Initializing](../react/initializing.md)
- [Vue: Initializing](../vue/initializing.md)
- [Swift: Initializing](../swift/initializing.md)
- [Kotlin: Initializing](../kotlin/initializing.md)
