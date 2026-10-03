---
title: Troubleshooting
description: Diagnose implemented engine, attachment, browser-storage, authorization, and local-device failures without relying on unverified guarantees.
status: alpha
docType: how-to
audience: app-developer
---

# Troubleshooting

Find the cause of a Kizuna failure and know which fix is safe to apply. Start from the error code and the runtime that produced it, then read the section below that names it. The examples match the current monorepo implementation.

The sections below each cover one failure. [The browser store and the leader-tab election](#local-web-database-will-not-open) explains why a web client cannot open its database. [BUCKET_UNSET](#bucket_unset) and [ATTACHMENT_PORTS_MISSING](#attachment_ports_missing) are configuration errors the client raises before anything reaches the network. [`KZL01`](#kzl01) is the server refusing a pull whose bucket does not name a table's provisioned bucket column. [`KZL02` and `COLUMN_DENIED`](#kzl02-and-column_denied) are the server refusing to read or write a column `authenticated` lacks the Postgres privilege for. [A server verdict on a queued write](#a-local-write-is-rejected-and-compensated) covers rejection and compensation. [A soft block after switching accounts](#sync-soft-blocks-after-switching-accounts) tells that failure apart from an ordinary sign-out. [An unreachable local service](#expo-or-a-physical-device-cannot-reach-local-services) and [a client that stops syncing after a background or a token expiry](#sync-goes-quiet-after-sleep-background-or-a-token-expiry) are the two ways a device stops reaching your project. [A database connection that fails with `UnknownIssuer`](#a-database-connection-fails-with-unknownissuer) is the CLI refusing a database whose certificate chain it cannot verify. [The stamp trigger is missing, disabled, or not deferred](#the-stamp-trigger-is-missing-disabled-or-not-deferred) repairs the trigger itself, and [changes queued without a sequence number](#changes-queued-without-a-sequence-number) recovers a database left with committed changes it never numbered. [Quick reference](#quick-reference) is the one-line-per-code table.

## Before you begin

- Enable Kizuna debug logging only in a development environment you control.
- Record `kizunasync.engine`, which is `'rust'`, its one value, under the rules in [Engine selection](../getting-started/status.md#engine-selection), and the driver in use.
- Preserve local data before clearing a database or calling [`reset()`](../reference/javascript/reset.md).
- For local Supabase failures, follow [Local Supabase](../cli/local-supabase.md#3-inspect-the-running-services) and run `bun run db:status`. Do not reset the database as a diagnostic shortcut. Supabase documents the stack in [Local development](https://supabase.com/docs/guides/local-development#quickstart), and Kizuna adds only its own migration to it.

## Local web database will not open

One tab wins an exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) named after the database. That tab starts a worker and compiles the Rust core to [WebAssembly](https://grokipedia.com/page/WebAssembly). It then installs the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool, or the relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) store where that pool is unavailable. [`createWebWorkerDriver`](../reference/javascript/create-web-worker-driver.md) therefore opens nothing on the page itself. Every other tab becomes a follower and sends its calls to the leading tab over a `BroadcastChannel`. Two tabs therefore never contend for the same access handles.

Three failures reach the page from there, under three different codes. When the engine itself refuses an open, it answers with its own failure envelope, and the driver hands the page the code that envelope carries.

The one you are most likely to meet is a held store, which a reload race produces. The departing page still holds its access handles when the next one asks for them. The worker retries that pool ten times over about 1.8 seconds. It then reports `STORE_BUSY` with `retryable` set to true, naming the database: `OPFS store for "your-db.db" is held by another browser context`.

Close the other tab, or let the reload settle and try again. The context holding the pool releases it.

It does not fall back to IndexedDB there, deliberately, because swapping a durable store for an empty one would look like a healthy client that had lost every local row.

A worker that cannot install either store reports `STORE_UNAVAILABLE` with both errors in one message, which is what a browser without `navigator.storage.getDirectory` and without `IndexedDB` produces. That one is not retryable: the same open in the same browser refuses again.

Safari Private Browsing refuses the OPFS directory itself, so there the worker opens a private in-memory store with `durability: 'none'` instead of failing, and its writes last only as long as the tab.

`ENGINE_UNAVAILABLE` is the third code, and it means the transport had no engine to give rather than a store it could not open: a worker that died under the leading tab, or a follower whose leader tab went away before answering. The dead worker fails that tab's calls and the database moves to another tab; the failed tab keeps reporting the real reason rather than quietly reconnecting through its neighbor.

Build one client per app context. [Create the app client](../getting-started/vite.md#3-create-the-app-client) builds it once, at module scope in `src/kizunasync.ts`, and every other file imports that one value, so a page never holds two clients on the same database:

```ts
// src/kizunasync.ts
import { byOwner, defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

const config = defineConfig({
  tables: { todos: { sync: 'read-write', bucket: byOwner('user_id') } },
})

export const kizunasync = createSupabaseKizunaSync({ supabase, driver: createWebWorkerDriver('todos.db'), config })
```

Creating the client opens nothing. The tab joins the election and the worker starts on the first call that needs the engine, so a store that cannot open fails that call, and the hook that made it, rather than the import. [Initializing](../reference/javascript/initializing.md#errors) lists what every member of the client does after a failed open.

Call [`kizunasync.dispose()`](../reference/javascript/initializing.md) during an intentional teardown: it stops the scheduler, closes the engine, and terminates the worker. The driver itself has no `close()`.

The driver advertises the `multiTab` capability that [Drivers and the TCK](../reference/drivers-and-tck.md#port-model) defines. The repository's [Bun](https://bun.sh) tests cover the transport protocol against a scripted worker. They also cover the leader election and the handover to a follower tab. The [Playwright](https://playwright.dev) suite in `packages/web/conformance` runs the real browser round trip. Treat crash durability as unverified for the browsers you ship to. The OPFS pool reports `full` durability and the IndexedDB fallback reports `relaxed`. No test here kills a browser process and resumes it, so neither claim carries that evidence. Clearing site storage destroys local state, so keep it as a last recovery step that the person using the app has approved.

You should now see one client per app context, with no open-failure line in the console.

## `BUCKET_UNSET`

A [bucketed](../resources/glossary.md#bucket) table starts with no value for the column its bucket compares against, and the engine holds that value as an empty string until it has a real one. A [pull](../sync/protocol-overview.md#pull) refuses rather than sending the empty value: it fails with `BUCKET_UNSET` and the message `bucket unset`, and the error is not retryable, so every later attempt fails the same way until the value exists.

The engine fails loudly instead of guessing the scope to copy, and instead of returning an empty result that would look like an empty table. Which fix applies depends on the kind of bucket the table declares.

A [`byOwner`](../sync/sync-rules-and-buckets.md#byownercolumn) bucket is filled by the engine. It reads the `sub` claim of the first access token the app client hands it, records that user as the owner of the local store, and fills every `byOwner` column with the user's id. After a restart it fills them again from the owner the store kept, with no token and no network, so the user's rows stay readable offline. A `byOwner` table therefore reports `BUCKET_UNSET` only while no signed-in session has reached the engine on that device. Sign the user in with supabase-js, which the app client follows on its own, or pass `anonymousSignIn: true` to [`createSupabaseKizunaSync`](../reference/javascript/initializing.md#parameters) when the first run has no sign-in screen. Supabase documents the session in [User sessions](https://supabase.com/docs/guides/auth/sessions#what-is-a-session). Kizuna uses only the user id from it, as a pull parameter and never as an authorization decision.

A [`byColumn`](../sync/sync-rules-and-buckets.md#bycolumncolumn) bucket takes its value from your app, which calls [`setBucket`](../reference/javascript/set-bucket.md) with the active tenant or workspace identifier before the first pull of that table. For a table declared with `bucket: byColumn('workspace_id')`:

```ts
// src/workspace.ts
import { kizunasync } from './kizunasync'

export function openWorkspace(workspaceId: string): void {
  kizunasync.setBucket({ workspace_id: workspaceId })
}
```

Swift and Kotlin set the same value with [Swift: Set bucket](../reference/swift/set-bucket.md) and [Kotlin: Set bucket](../reference/kotlin/set-bucket.md), and their engine fills an owner bucket (`.byOwner` in Swift, `KizunaSyncBucket.ByOwner` in Kotlin) from the access token the same way. You should now see the next pull succeed, and [`getSyncHealth()`](../reference/javascript/sync-health.md#returns) report no `BUCKET_UNSET` in `lastError`, because the pull request carries a non-empty value for every declared bucket key.

Give each scope its own local database when two scopes must not share one. The other option is a reset and account-switch policy the person using the app has approved.

[`setBucket`](../reference/javascript/set-bucket.md) replaces a table's local scope the moment you name a value that differs from the one it kept: the next pull re-bootstraps every synced table and the local snapshot ends up holding only the new value's rows. Queued outbox writes stay, and no remote attachment is deleted. Repeating the same value, or filling in a bucket key for the first time, arms no rehydration.

## `KZL01`

A table [provisioned](../cli/cli.md#kizunasync-init) with a `bucket_column` refuses a pull whose bucket omits that column. [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull) raises the pull-policy error before it builds a page:

```text
kizunasync.pull(): table "todos" is bucketed on "user_id": the pull bucket must name that column
```

The engine surfaces it as a transport failure rather than a typed local error, the same as [`KZP01`](../reference/sql-pack.md#kizunasyncpush): [`getSyncHealth()`](../reference/javascript/sync-health.md#returns) carries it on `lastError.code`, and Swift and Kotlin throw it from `KizunaSyncError.engine(code:message:)`.

Declare a `bucket` in [`defineConfig`](../reference/javascript/define-config.md#parameters) that matches the provisioned column: [`byOwner('<column>')`](../sync/sync-rules-and-buckets.md#byownercolumn) when the column holds the owner's user id, which the engine fills, or [`byColumn('<column>')`](../sync/sync-rules-and-buckets.md#bycolumncolumn) for any other scope, which [`setBucket`](../reference/javascript/set-bucket.md) fills. If the table needs no bucket at all, provision it without a `bucket_column` instead:

```bash
kizunasync sync --add todos --yes   # no --bucket-column: unbucketed, table-scoped
```

You should now see the pull succeed instead of failing with `KZL01`, because the request's bucket names the column the table was provisioned with, or the table carries no bucket column requirement at all.

## `KZL02` and `COLUMN_DENIED`

`authenticated` needs `SELECT` on every column of a table's [row key](../sync/sync-rules-and-buckets.md#row-keys) and on its [bucket](../resources/glossary.md#bucket) column, when it has one, or every pull of that table fails with `KZL02`, the same transport-failure shape as [`KZL01`](#kzl01): [`getSyncHealth()`](../reference/javascript/sync-health.md#returns) carries it on `lastError.code`, and Swift and Kotlin throw it from `KizunaSyncError.engine(code:message:)`. `authenticated` also needs `UPDATE` on every column a mutation writes, or that one write is rejected with reason `COLUMN_DENIED` rather than applied, and `server_row` carries the row narrowed to the columns you may read; [Validation rejections](../sync/conflict-resolution.md#validation-rejections) covers the shape every rejection reason shares.

[Column-level privileges](../reference/sql-pack.md#column-level-privileges) are a Postgres feature Supabase documents as advanced and not something its CLI or `supabase db diff` manages, so a hand-applied `REVOKE` goes unnoticed until a pull or a push hits it. Run [`kizunasync doctor`](../cli/cli.md#kizunasync-doctor) and read its `column-privileges` check: it names every column `authenticated` cannot read or write on a synced table, and it is the diagnostic for both failures here.

Grant the column back to `authenticated`, `SELECT` for `KZL02` and `UPDATE` for `COLUMN_DENIED`, in SQL or from the dashboard. Or stop needing it: drop a bucket the column no longer has to scope, drop the column from the mutation's `columns`, or move the column into a table `kizunasync` does not sync.

You should now see the pull and the write succeed instead of failing with `KZL02` or rejected with `COLUMN_DENIED`.

## `ATTACHMENT_PORTS_MISSING`

When any configured table declares a column through the [attachment](../sync/sync-rules-and-buckets.md#attachments) helper, the app client requires both `fileStore` and `transfer`, and creating it throws `ATTACHMENT_PORTS_MISSING` when either is absent. Those two are the attachment ports. An app client built without them and with no attachment column still has `kizunasync.attachments`, and every call on it rejects with the same code. [`createSupabaseKizunaSync`](../reference/javascript/initializing.md#parameters) builds the transfer from the Supabase client once you pass a `fileStore`, so on the web the file store is the one option to add, and [Media and attachments](../attachments/media-and-attachments.md#2-wire-the-file-and-transfer-ports) walks the same wiring end to end:

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

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: createWebWorkerDriver('todos.db'),
  config,
  fileStore: createWebFileStore(),
})
```

[`createWebFileStore`](../reference/javascript/create-web-file-store.md) returns the store at once and opens its sandbox on the first attachment call that reads or writes bytes, so the module stays safe to import during a static render. A browser without OPFS fails that call with `STORE_UNAVAILABLE`. The transfer the composition builds is [`createSupabaseTransfer`](../reference/javascript/create-supabase-transfer.md), which uploads through the Storage API Supabase documents in [Resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) and switches to it above 6 MiB. Pass `transfer` yourself only to replace it.

On iOS and Android an [Expo](https://expo.dev) app opens its file store with [`openExpoFileStore`](../reference/expo/open-expo-file-store.md) from `@kizunasync/expo/file-store`, and it replaces the transfer's download with [`createExpoSupabaseDownload`](../reference/expo/create-expo-supabase-download.md) from `@kizunasync/expo/transfer`, which reads the bytes with Expo's fetch directly, with no `Blob` round-trip. [Compose the whole transfer port](../reference/expo/create-expo-supabase-download.md#compose-the-whole-transfer-port) shows that `transfer` option, and the store touches no file system until the first attachment call:

```ts
// src/kizunasync.ts
import { attachment, byOwner, defineConfig } from '@kizunasync/core'
import { openExpoDriver } from '@kizunasync/expo'
import { openExpoFileStore } from '@kizunasync/expo/file-store'
import { createExpoSupabaseDownload } from '@kizunasync/expo/transfer'
import { createSupabaseKizunaSync, createSupabaseTransfer } from '@kizunasync/supabase'
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

const fileStore = openExpoFileStore()
const ports = { client: supabase, fileStore }

export const kizunasync = createSupabaseKizunaSync({
  supabase,
  driver: openExpoDriver('todos.db'),
  config,
  fileStore,
  transfer: { ...createSupabaseTransfer(ports), download: createExpoSupabaseDownload(ports) },
})
```

On Expo web, pass [`createWebFileStore()`](../reference/javascript/create-web-file-store.md) as `fileStore` and leave `transfer` out, as the web module above does.

If an attachment omits `ownerColumn`, the table has to use a [`byOwner`](../sync/sync-rules-and-buckets.md#byownercolumn) bucket so the config resolver can infer it, and creating the client throws `CONFIG_INVALID` otherwise. On a table with any other bucket, pass it explicitly:

```ts
// src/kizunasync.ts (excerpt)
import { attachment, byColumn, defineConfig } from '@kizunasync/core'

const config = defineConfig({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byColumn('workspace_id'),
      attachments: { image_path: attachment('todo-images', { ownerColumn: 'user_id' }) },
    },
  },
})
```

[`fromFile`](../reference/javascript/from-file.md) returns `{ ref, sha256, size, mediaType, localUri }`. `ref` is the Storage object key, and `fromFile` has already written it into the column the `attachment` helper names. You should now see the module that creates the client load without throwing, because every table declaring an attachment column has both `fileStore` and `transfer`.

Swift and Kotlin throw the same `ATTACHMENT_PORTS_MISSING` code from [`fromFile`](../reference/swift/from-file.md#errors) and [`fromFile`](../reference/kotlin/from-file.md#errors). They throw it when `attachmentRoot` is unset. `attachmentRoot` is the directory the native client owns for attachment bytes. Bytes upload only after the outbox drains, as [Bytes upload after the outbox drains](../attachments/media-and-attachments.md#5-bytes-upload-after-the-outbox-drains) describes.

## A local write is rejected and compensated

`MUTATION_REJECTED` is a server [verdict](../resources/glossary.md#verdict) and not necessarily a transport failure. [`on`](../reference/javascript/on.md) delivers it:

```ts
// src/rejection-log.ts
import { EEngineEventType } from '@kizunasync/core'
import { kizunasync } from './kizunasync'

export const unsubscribe = kizunasync.on((event) => {
  if (event.type === EEngineEventType.MUTATION_REJECTED) {
    console.warn(event.mutationId, event.reason)
  }
})
```

The current reasons are `RLS_DENIED`, `COLUMN_DENIED`, `DELETE_WINS`, `PRECONDITION`, `SUPERSEDED`, and `CONSTRAINT`, and [Validation rejections](../sync/conflict-resolution.md#validation-rejections) gives the condition behind each one. The engine compensates local state, records the durable rejection journal entry, and removes the rejected mutation from the [outbox](../resources/glossary.md#outbox).

For `RLS_DENIED`, verify four things. The [JWT](https://grokipedia.com/page/JSON_Web_Token) belongs to the identity that created the pending write. The INSERT `WITH CHECK` policy, and the UPDATE or DELETE `USING` and `WITH CHECK` policies, cover the intended operation. The mutation carries the owner or tenant columns those policies read. An account switch did not leave another identity's outbox behind.

An insert that leaves out a `byOwner` column gets the store owner's id from the engine, but only once a signed-in session has named that owner. An insert made before the first sign-in on the device keeps the row as written, so a policy that checks the owner column can reject it.

Supabase documents that policy shape in [Write a policy for each operation](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation). Kizuna adds nothing to it, and runs every row write under the calling user's own policies, on push rather than at write time.

A stalled long-lived session is a different failure and must not be read as `RLS_DENIED`. A Supabase access token is short-lived and the client refreshes it in the background, and Supabase gives the expiry guidance in [Recommended values for access token expiration](https://supabase.com/docs/guides/auth/sessions#what-are-recommended-values-for-access-token-jwt-expiration). A backgrounded tab or app can miss that refresh, and the next poll then reaches [PostgREST](https://postgrest.org/) with a dead Bearer, which returns `PGRST301` and stays retryable, or with no user JWT at all, which runs as role `anon` and returns SQLSTATE `42501`.

The two outcomes differ in what they decide. `42501` on `pull` or `push` is a GRANT or role failure about the call itself, of the kind Supabase separates in [Grants and policies](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies). The adapter marks it retryable, and the write stays queued. The pack grants EXECUTE on both functions to the signed-in role, which [Grants and security](../reference/sql-pack.md#grants-and-security) records. Row-level refusal arrives instead as HTTP 200 carrying reason `RLS_DENIED`. That is a decision about that row, and an unmodified retry gets the same answer. [`createSupabaseKizunaSync`](../reference/javascript/initializing.md#parameters) and the native [`KizunaSyncScheduler`](../getting-started/native-clients.md#6-start-the-host-scheduler) refresh the session on foreground before polling. A missing user JWT raises `AUTH_SESSION_MISSING`. It never falls back to the publishable key as Bearer, which would run as the [`anon` role](https://supabase.com/docs/guides/database/postgres/row-level-security#authenticated-and-unauthenticated-roles).

Flush or resolve pending writes before you change identity. [`reset()`](../reference/javascript/reset.md) deletes the [local store](../resources/glossary.md#local-store), the outbox, and attachment references, so use it only as an intentional account-switch action the person using the app has approved, after preserving anything worth keeping. After the reset the engine records the signed-in user as the store's new owner, fills the `byOwner` buckets with that user's id, and the client hydrates under that user.

Inspect the journal with [`rejections()`](../reference/javascript/rejections.md) and acknowledge an entry with [`dismissRejection`](../reference/javascript/dismiss-rejection.md). You should now see the write you re-make after the fix survive its next push: no `MUTATION_REJECTED` event for the new mutation id, no new entry from `rejections()`, and `getOutboxDepth()` back at zero.

Dismissal hides an entry from the default listing and does not delete it. [Offline writes](../sync/offline-writes.md#3-handle-a-rejection) shows the same journal driving a UI.

## Sync soft-blocks after switching accounts

The engine reads the `sub` claim of every access token it receives and remembers which user its local store belongs to. A token naming a different user latches a soft block with reason `identity_changed`, emits [`RESET_REQUIRED`](../reference/javascript/on.md#returns) carrying that reason, and holds it on [`getSyncHealth()`](../reference/javascript/sync-health.md#returns)'s `softBlockReason` until [`reset()`](../reference/javascript/reset.md) runs. Nothing here is `RLS_DENIED` or a dead letter: the engine never guesses that a queued write belongs to the account that is no longer signed in, and it never applies it under the new one either. Signing out clears the token instead of changing identity, so it never triggers this block: sync pauses with `AUTH_SESSION_MISSING` until a session returns, and signing back in as the same user resumes without a reset.

You should now see `softBlockReason` report `identity_changed` after switching accounts on one client, and `null` again immediately after `reset()` runs and the client re-hydrates under the new identity.

## Expo or a physical device cannot reach local services

Separate two failures:

- If Expo cannot load the JavaScript bundle, diagnose Metro reachability.
- If the app loads but Supabase calls fail, diagnose `EXPO_PUBLIC_SUPABASE_URL` and the local stack. [Expo / React Native](../getting-started/expo.md#2-connect-supabase) shows where that value is read.

Start the local stack from your app project on the development machine with [`supabase start`](https://supabase.com/docs/reference/cli/supabase-start), then print its endpoints and keys with [`supabase status`](https://supabase.com/docs/reference/cli/supabase-status):

:::tabs{group=pm}
```bash tab=npm
npx supabase start
npx supabase status
```

```bash tab=pnpm
pnpm dlx supabase start
pnpm dlx supabase status
```

```bash tab=yarn
yarn dlx supabase start
yarn dlx supabase status
```

```bash tab=bun
bunx supabase start
bunx supabase status
```
:::

On a physical device, `127.0.0.1` is the device itself. Set the URL in your app's `.env.local` to the Project URL that `supabase status` prints, with `127.0.0.1` replaced by the development machine's reachable LAN address, and keep the device on a network that allows peer traffic. The port is `54321` unless your `supabase/config.toml` sets another one:

```bash
EXPO_PUBLIC_SUPABASE_URL=http://<development-machine-lan-ip>:54321
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key-from-supabase-status>
```

Then restart or reload the Expo process so public environment variables are read again.

Opening the Studio URL that `supabase status` prints proves the development machine can reach its own stack. It proves nothing about the phone. The repository's host and unit tests do not cover physical-device execution or a TLS and network matrix.

Confirm device-to-machine connectivity separately. You should now see a sync started on the device complete instead of failing in transport.

## Sync goes quiet after sleep, background, or a token expiry

The automatic loop arms its next tick before each attempt runs. No outcome of an attempt decides whether there is a next one. The loop runs its first attempt as soon as the app client is first used, then polls every 15 seconds by default, at a random point between half the interval and the full interval, and keeps at most one attempt in flight. It grows the retry delay with the failure streak, up to a 30 second ceiling. It wakes at once on a local write, a return of connectivity, a return to the foreground, or a [Realtime](https://supabase.com/docs/guides/realtime) signal. [`sync()`](../reference/javascript/sync.md) is the same run performed on demand. An attempt that never answers therefore slows the loop down without stopping it.

Read the current state with [`getSyncHealth()`](../reference/javascript/sync-health.md#returns), or with [`useSyncStatus`](../reference/react/use-sync-status.md) in [React](https://react.dev) and [`useSyncStatus`](../reference/vue/use-sync-status.md) in [Vue](https://vuejs.org). `stalled` means the request in flight has not settled for two poll ticks and the loop is waiting for it rather than starting a second one. `backoff` means the last attempt failed and the next is delayed by the failure streak. `offline` means the connectivity port reports no network, so no attempt is made at all. `nextAttemptAt` carries the epoch milliseconds of the next automatic attempt, and the two hooks expose the same value as `nextRetryAt`.

Every request carries a deadline, and each expiry is retryable rather than fatal: 30 seconds for an engine RPC on [`createRpcRemote`](../reference/javascript/create-rpc-remote.md), 10 seconds for `auth.getSession()` and the foreground refresh (`AUTH_SESSION_TIMEOUT`, the `sessionTimeoutMs` option in [Initializing](../reference/javascript/initializing.md#parameters)), 30 seconds for an attachment control request, and 120 seconds for its bytes (`ATTACHMENT_TRANSFER_TIMEOUT`, both configurable on [`createSupabaseTransfer`](../reference/javascript/create-supabase-transfer.md)). A blown deadline surfaces as a failure the loop retries.

In browsers, a socket dropped while the tab was backgrounded emits no channel error, so Realtime can go quiet without reporting anything. Kizuna treats Realtime only as a wake hint, so a dropped socket delays a pull rather than losing one.

Create the Supabase client with `realtime: { worker: true, heartbeatCallback: (status) => { if (status === 'disconnected') { supabase.realtime.connect() } } }` so the heartbeat keeps running under timer throttling and the socket reconnects itself. Supabase gives that configuration, the worker flag included, in [Implement heartbeatCallback for explicit reconnection](https://supabase.com/docs/guides/troubleshooting/realtime-handling-silent-disconnections-in-backgrounded-applications-592794#step-1-implement-heartbeatcallback-for-explicit-reconnection).

On React Native, [`openExpoDriver`](../reference/expo/open-expo-driver.md) carries the device's `AppState` foreground signal and its NetInfo connectivity signal, so [`createSupabaseKizunaSync`](../reference/javascript/initializing.md) refreshes the session and wakes sync on resume with nothing passed by hand. Add an `AppState` listener that calls [`startAutoRefresh`](https://supabase.com/docs/reference/javascript/auth-startautorefresh#examples) and `supabase.realtime.connect()` when the app becomes active, and `stopAutoRefresh` when it leaves. Supabase shows that pairing in [Reconnect when a React Native app comes to the foreground](https://supabase.com/docs/guides/troubleshooting/realtime-heartbeat-messages#reconnect-when-react-native-app-comes-to-foreground).

The driver's connectivity signal is [`createExpoConnectivity`](../reference/expo/create-expo-connectivity.md) with its default gate, NetInfo's `isConnected`, which keeps a working link from being reported as offline. Once you have pointed the reachability probe at your own backend, pass `connectivity: createExpoConnectivity({ gate: 'internet-reachable' })` to `createSupabaseKizunaSync`, which replaces the driver's signal.

You should now see `getSyncHealth()` leave `stalled` once the in-flight request settles, with `nextAttemptAt` moved forward and `consecutiveFailures` back at zero after the first success.

## A database connection fails with `UnknownIssuer`

`kizunasync` verifies the certificate chain of every database connection that uses TLS, which includes every connection to a host that is not loopback. When that chain does not end at a root certificate the CLI trusts, the connection fails. A command that needs the database stops with the reason and the remedy, and `kizunasync doctor` prints the same lines under each database check:

```text
could not connect to the database:
    error performing TLS handshake: invalid peer certificate: UnknownIssuer: the server's certificate chain is signed by a CA the client does not trust; hosted Supabase chains end at the embedded Supabase Root 2021 CA, so re-check the host; for another CA pass `sslrootcert=<path to its PEM>` in the URL
```

The CLI trusts Mozilla's root certificates plus a built-in copy of Supabase Root 2021 CA, the root of Supabase's database certificates. A hosted Supabase database presents a chain that ends at that root, on the pooler and on the direct host alike, so a connection string copied from your project's Connect panel verifies as it is. When such a string fails with `UnknownIssuer`, compare its host with the one the dashboard shows before you change anything else.

For a database whose certificate comes from another certificate authority, such as a self-hosted Postgres server with a private CA, give the CLI that authority's certificate. Save it as a PEM file and pass its path in libpq's `sslrootcert` parameter:

:::tabs{group=pm}
```bash tab=npm
npx kizunasync doctor --db-url "postgresql://postgres:<password>@db.example.com:5432/postgres?sslrootcert=/path/to/ca.pem"
```

```bash tab=pnpm
pnpm dlx kizunasync doctor --db-url "postgresql://postgres:<password>@db.example.com:5432/postgres?sslrootcert=/path/to/ca.pem"
```

```bash tab=yarn
yarn dlx kizunasync doctor --db-url "postgresql://postgres:<password>@db.example.com:5432/postgres?sslrootcert=/path/to/ca.pem"
```

```bash tab=bun
bunx kizunasync doctor --db-url "postgresql://postgres:<password>@db.example.com:5432/postgres?sslrootcert=/path/to/ca.pem"
```
:::

The CLI trusts every certificate in that file on top of its built-in roots, and it still checks that the server's certificate names the host in the URL. A file the CLI cannot read, or one that holds no certificate it can parse, fails the connection with an error that starts `could not load sslrootcert=` and names the path and the reason. [Database connection](../cli/cli.md#database-connection) describes how the CLI chooses TLS for each host.

You should now see the command get past the connection, with no `UnknownIssuer` line in its output.

## The stamp trigger is missing, disabled, or not deferred

`kizunasync doctor`'s [`change-stamp`](../cli/cli.md#kizunasync-doctor) check fails when the commit-time stamp cannot run. Two triggers make it. The statement trigger `kizunasync_arm_stamp` on [`kizunasync._change_pending`](../reference/sql-pack.md#kizunasync_change_pending) runs [`_arm_stamp()`](../reference/sql-pack.md#kizunasync_arm_stamp), which inserts one [`kizunasync._stamp_marker`](../reference/sql-pack.md#kizunasync_stamp_marker) row the first time a transaction queues a change. The deferred constraint trigger `kizunasync_stamp_transaction` on that marker table runs [`_stamp_transaction()`](../reference/sql-pack.md#kizunasync_stamp_transaction), which numbers every change the transaction queued as it commits. The check fails when the marker table or either trigger is missing, when a trigger is disabled, or when `kizunasync_stamp_transaction` exists without both `deferrable` and `initially deferred`.

On a project whose ledger is up to date with the pack, re-apply the pack. [`kizunasync upgrade --reapply`](../cli/cli.md#kizunasync-upgrade) runs every pack file the ledger records again, in one transaction, and the pack creates the marker table when it is missing and drops and creates both triggers again, the stamp trigger with its deferred timing. Your settings, your synced tables, and the changes already recorded stay as they were:

:::tabs{group=pm}
```bash tab=npm
npx kizunasync upgrade --reapply --yes
```

```bash tab=pnpm
pnpm dlx kizunasync upgrade --reapply --yes
```

```bash tab=yarn
yarn dlx kizunasync upgrade --reapply --yes
```

```bash tab=bun
bunx kizunasync upgrade --reapply --yes
```
:::

The SQL below repairs the triggers by hand, which also works on a project whose ledger is not up to date. A missing `_stamp_marker` table needs the re-apply above. If the check names a trigger disabled, re-enable both:

```sql
-- Supabase SQL editor or psql
alter table kizunasync._change_pending enable trigger kizunasync_arm_stamp;
alter table kizunasync._stamp_marker enable trigger kizunasync_stamp_transaction;
```

If the check names a trigger missing or not deferred, recreate both:

```sql
-- Supabase SQL editor or psql
drop trigger if exists kizunasync_arm_stamp on kizunasync._change_pending;
create trigger kizunasync_arm_stamp
  after insert on kizunasync._change_pending
  for each statement execute function kizunasync._arm_stamp();

drop trigger if exists kizunasync_stamp_transaction on kizunasync._stamp_marker;
create constraint trigger kizunasync_stamp_transaction
  after insert on kizunasync._stamp_marker
  deferrable initially deferred
  for each row execute function kizunasync._stamp_transaction();
```

A disabled `kizunasync_stamp_transaction` also leaves behind the `_stamp_marker` rows of the transactions that wrote meanwhile, and the restored stamp deletes every marker row it can see, so the next transaction it numbers clears them without a statement of yours.

Run `kizunasync doctor` again. If it now reports queued changes, [Changes queued without a sequence number](#changes-queued-without-a-sequence-number) covers the rest.

## Changes queued without a sequence number

`kizunasync doctor`'s [`change-stamp`](../cli/cli.md#kizunasync-doctor) check fails when a row sits committed in [`kizunasync._change_pending`](../reference/sql-pack.md#kizunasync_change_pending). That happens only when a stamp trigger, `kizunasync_arm_stamp` or [`kizunasync_stamp_transaction`](../reference/sql-pack.md#kizunasync_stamp_transaction), was missing or disabled while a client wrote to a synced table: the capture triggers still queue the change, but nothing draws it a sequence number or moves it into `_changelog` or `_tombstones`, so it commits exactly as queued and no pull ever delivers it.

```text
3 queued change(s) committed without a sequence number, so no pull delivers them: restore the stamp trigger, then write to any synced table or commit one transaction that arms the stamp as Troubleshooting shows under "Changes queued without a sequence number"
```

Restore the triggers first: [The stamp trigger is missing, disabled, or not deferred](#the-stamp-trigger-is-missing-disabled-or-not-deferred) covers the repairs. That step numbers nothing by itself, because the stamp runs only in a transaction that arms it, and the rows sitting in the queue committed before you restored the triggers.

Once both stamp triggers are back, the next commit that writes to any synced table numbers the stuck changes ahead of its own, in the order they were queued, with the bucket label each one carries. It also links every conflict-journal entry that names one of them to the number that change drew. To number them at once instead, commit one transaction that arms the stamp:

```sql
-- Supabase SQL editor or psql
begin;
insert into kizunasync._stamp_marker values (pg_current_xact_id()) on conflict (xid) do nothing;
commit;
```

The insert writes no row of yours: the marker it adds runs the stamp at commit, and the stamp deletes the marker again. When a write earlier in the same transaction already armed the stamp, `on conflict (xid) do nothing` skips the insert, so the statement is safe in any transaction.

A writer that uses `REPEATABLE READ` or `SERIALIZABLE` isolation can fail once while the leftovers are cleared. The first transaction that runs the stamp after you restore the triggers, the one above or an application's write, numbers and deletes every leftover row it can see. A concurrent writer whose snapshot was taken before that commit still sees the same rows, so its stamp fails at commit with `40001`, `could not serialize access due to concurrent delete`, and the whole transaction rolls back, its own write included. Retrying it succeeds, which is what the Postgres documentation tells an application to do after any [serialization failure](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ). Writers under `READ COMMITTED`, the Postgres default, take a new snapshot for every statement and never hit this failure, and once the leftovers are gone a stamp sees only its own transaction's rows, so the conflict does not recur.

You should now see `kizunasync doctor` pass `change-stamp`, and the next pull deliver the rows that had been stuck, together with the conflict-journal entries recorded against them.

## Quick reference

| Error/event | Meaning | First check |
|---|---|---|
| [web database open failure](#local-web-database-will-not-open) | no persistent store, or the leading tab's worker died | one client per context; [`kizunasync.dispose()`](../reference/javascript/initializing.md) on teardown |
| [`BUCKET_UNSET`](#bucket_unset) | a configured pull equality is empty | `byOwner`: sign a user in, or pass `anonymousSignIn: true`; `byColumn`: call [`setBucket`](../reference/javascript/set-bucket.md) for its key |
| [`KZL01`](#kzl01) | a pull's bucket omits a requested table's provisioned bucket column | declare `bucket: byOwner('<column>')` or `byColumn('<column>')` matching the provisioned column, or provision the table without a bucket column via `kizunasync sync` |
| [`KZL02`](#kzl02-and-column_denied) | `authenticated` cannot `SELECT` a key column of a table or its bucket column | grant `SELECT` on the column, or run `kizunasync doctor`'s `column-privileges` check to find it |
| [`COLUMN_DENIED`](#kzl02-and-column_denied) | a mutation writes a column `authenticated` cannot `UPDATE` | grant `UPDATE` on the column, drop it from the mutation, or run `kizunasync doctor`'s `column-privileges` check to find it |
| `LOCAL_UNSUPPORTED` | a query builder call has no local implementation | use a [supported filter](../reference/javascript/using-filters.md#unsupported-operators) or read the row and decide the operation yourself |
| [`ATTACHMENT_PORTS_MISSING`](#attachment_ports_missing) | attachment config lacks ports, or an attachment call on a client built without them (JS); `attachmentRoot` unset (native) | pass matching file store and transfer, or set `attachmentRoot` on [`KizunaSyncClient.create`](../getting-started/native-clients.md#3-create-the-app-client) |
| `CONFIG_INVALID`: attachment needs `ownerColumn` | no explicit owner and no [`byOwner`](../sync/sync-rules-and-buckets.md#byownercolumn) inference | set `ownerColumn` in the [attachment field](../attachments/media-and-attachments.md#1-declare-the-attachment-column-in-your-config) |
| `AUTH_SESSION_MISSING` | pull/push without a user JWT | refresh the [session](https://supabase.com/docs/guides/auth/sessions#what-is-a-session); never send only the publishable key as Bearer |
| [`MUTATION_REJECTED` / `RLS_DENIED`](#a-local-write-is-rejected-and-compensated) | application-table policy rejected the mutation (HTTP 200 [verdict](../reference/status-taxonomy.md#wire-status-values)) | JWT, mutation columns, and [the policy for that operation](https://supabase.com/docs/guides/database/postgres/row-level-security#write-a-policy-for-each-operation). Not a transport `42501` |
| [`RESET_REQUIRED` (`identity_changed`)](#sync-soft-blocks-after-switching-accounts) | a token named a different user than the one the local store belongs to | call [`reset()`](../reference/javascript/reset.md) and re-hydrate under the new identity |
| SQLSTATE `42501` on pull/push | [GRANT EXECUTE](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) / role `anon` / missing JWT | retryable; refresh the session. Other `42xxx` stay permanent |
| network/transport error | remote did not return a [protocol response](../sync/protocol-overview.md#retry-semantics) | endpoint, credentials, local stack, device routing |
| `AUTH_SESSION_TIMEOUT` | `auth.getSession()` or the foreground refresh did not settle in time | retryable; check the network and the auth endpoint; see [`sessionTimeoutMs`](../reference/javascript/initializing.md#parameters) |
| `ATTACHMENT_TRANSFER_TIMEOUT` | an attachment request blew its deadline | retryable on the next sync; [TUS](https://tus.io/protocols/resumable-upload) resumes from the saved [upload URL](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) |
| [`health.phase = stalled`](#sync-goes-quiet-after-sleep-background-or-a-token-expiry) | an attempt has not settled for two poll ticks | wait for the request deadline; a wake does not start a second attempt. See [Sync health](../reference/javascript/sync-health.md) |
| [`UnknownIssuer`](#a-database-connection-fails-with-unknownissuer) | the database's certificate chain does not end at a root the CLI trusts | compare the host with your project's Connect panel; for another CA, pass `sslrootcert=<path>` in the connection URL |

## Next steps

- [Offline writes and the outbox](../sync/offline-writes.md)
- [Media and attachments](../attachments/media-and-attachments.md)
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md)
- [Local Supabase](../cli/local-supabase.md)
