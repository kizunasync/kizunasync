---
title: Initializing
description: Open the Kotlin client against a provisioned Supabase project.
status: alpha
docType: reference
library: kotlin
pageKind: initializing
audience: app-developer
---

# Kotlin: Initializing

`KizunaSyncClient()` allocates an idle handle and `create` builds the engine behind it from a [`KizunaSyncClientConfig`](./types.md#client-and-configuration). The configuration is encoded to JSON and handed to the Rust engine, which opens the local database, resolves the remote, and refuses any field it cannot invent. A handle that has not been created throws on every other method, so `create` runs once per database file, before the first read or write.

An app creates the client once, when it starts, in one file the rest of the app shares, such as `TodoSync.kt`, and opens it before the first screen reads. [Swift and Kotlin](../../getting-started/native-clients.md#3-create-the-app-client) shows that file in full, with the app's root, the sign-in, and the host scheduler around this call.

## Examples

### Open the client

This is `TodoSync.kt` from [step 3 of Swift and Kotlin](../../getting-started/native-clients.md#3-create-the-app-client). `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` come from `Supabase.kt` in [step 2](../../getting-started/native-clients.md#2-connect-supabase) of that guide.

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt
package com.example.todo

import android.content.Context
import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncRemoteConfig
import com.kizunasync.kizunasync.KizunaSyncTableConfig
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

val kizunasync = KizunaSyncClient()

private val openLock = Mutex()
private var isOpen = false

/** Opens the local database once per process. A failed open is forgotten, so the next call tries again. */
suspend fun openKizunaSync(context: Context) {
    openLock.withLock {
        if (!isOpen) {
            kizunasync.create(
                KizunaSyncClientConfig(
                    tables = mapOf("todos" to KizunaSyncTableConfig(bucket = KizunaSyncBucket.ByOwner("user_id"))),
                    databasePath = File(context.filesDir, "kizunasync.sqlite").absolutePath,
                    remote = KizunaSyncRemoteConfig(url = SUPABASE_URL, publishableKey = SUPABASE_PUBLISHABLE_KEY),
                ),
            )
            isOpen = true
        }
    }
}
```

`KizunaSyncBucket.ByOwner("user_id")` makes `user_id` an owner bucket. The engine fills its value with the user the first session token names, whether `create` or [Set access token](./set-access-token.md) hands it over, keeps that owner in the local database, and writes it into `user_id` on every insert that leaves the column out, so the app never calls [Set bucket](./set-bucket.md) for this table. `publishableKey` takes the project's [publishable key](https://supabase.com/docs/guides/getting-started/api-keys#publishable-keys-and-public-components). The config needs no session and passes no `accessToken`: the [Host scheduler](./scheduler.md) hands the client the signed-in user's [JWT](https://grokipedia.com/page/JSON_Web_Token) before every sync, and [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) judges every push under it. `create` makes no network call, so the client opens offline and before anyone signs in. Keep the handle alive for the life of the database; opening a second client on the same file is not supported.

### With attachments

The same open, for a `todos` table with an `image_path` attachment column.

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
package com.example.todo

import android.content.Context
import com.kizunasync.kizunasync.KizunaSyncAttachmentSpec
import com.kizunasync.kizunasync.KizunaSyncBucket
import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncRemoteConfig
import com.kizunasync.kizunasync.KizunaSyncTableConfig
import java.io.File
import kotlinx.coroutines.sync.withLock

suspend fun openKizunaSync(context: Context) {
    openLock.withLock {
        if (!isOpen) {
            kizunasync.create(
                KizunaSyncClientConfig(
                    tables = mapOf(
                        "todos" to KizunaSyncTableConfig(
                            bucket = KizunaSyncBucket.ByOwner("user_id"),
                            attachments = mapOf(
                                "image_path" to KizunaSyncAttachmentSpec(storageBucket = "todos", ownerColumn = "user_id"),
                            ),
                        ),
                    ),
                    databasePath = File(context.filesDir, "kizunasync.sqlite").absolutePath,
                    remote = KizunaSyncRemoteConfig(url = SUPABASE_URL, publishableKey = SUPABASE_PUBLISHABLE_KEY),
                    attachmentRoot = File(context.filesDir, "kizunasync-attachments").absolutePath,
                ),
            )
            isOpen = true
        }
    }
}
```

### Offline, in a host test

```kotlin
// TodoClientTest.kt
package com.example.todo

import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncTableConfig
import java.io.File
import kotlin.test.Test
import kotlinx.coroutines.runBlocking

class TodoClientTest {
    @Test
    fun opensWithoutARemote() = runBlocking {
        val databaseFile = File.createTempFile("todos-test", ".sqlite")
        val client = KizunaSyncClient()
        client.create(
            KizunaSyncClientConfig(
                tables = mapOf("todos" to KizunaSyncTableConfig()),
                databasePath = databaseFile.absolutePath,
            ),
        )
        client.dispose()
    }
}
```

`clientId` is left unset here, so the client mints its own uuid for the device. A packaged build of the library (the `.aar` an app links) refuses a missing `remote` with `CONFIG_INVALID`; only a build without the `http` Cargo feature, such as this package's own JVM test target, falls back to an offline scripted remote.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `config` | `KizunaSyncClientConfig` | Yes | The whole client configuration, encoded to JSON by `toJson()` and passed to the engine. |
| `config.clientId` | `String?` | No | Stable identifier for this device, registered in `kizunasync._clients.client_id`, a `uuid` column. A non-uuid `clientId` is refused rather than let the server refuse it later. The store keeps the identity from the first `create` onward: a later call with a different `clientId` does not change it, and only [Reset](./reset.md) mints and keeps a new one. Default: `null`, a uuid the client mints for the device, sent as `deviceId`. |
| `config.schemaVersion` | `Int` | No | Schema generation sent on every pull, so a server that moved on can answer `RESET_REQUIRED`. Default: `1`. |
| `config.tables` | `Map<String, KizunaSyncTableConfig>` | Yes | Synced tables, keyed by table name. A table absent from this map is neither pulled nor writable. |
| `config.tables.<name>.bucket` | `KizunaSyncBucket` | No | Which rows of this table the device pulls. `KizunaSyncBucket.ByOwner(column)` names a column that holds the owning user's id: the engine fills the bucket with the user the first session token names, the one `remote.accessToken` passes or the first [Set access token](./set-access-token.md) call, keeps that owner in the local database across launches, and fills the column on an insert that leaves it out, so the app never calls [Set bucket](./set-bucket.md) for it. `KizunaSyncBucket.ByColumn(column)` names a column whose value the app sets with [Set bucket](./set-bucket.md), and the first pull fails with `BUCKET_UNSET` until it does. `KizunaSyncBucket.None` declares a table with no [bucket](../../resources/glossary.md#bucket), which pulls every row [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) permits on a table provisioned without a bucket column; a table provisioned with one refuses an unscoped pull with `KZL01`. Default: `KizunaSyncBucket.None`. |
| `config.tables.<name>.attachments` | `Map<String, KizunaSyncAttachmentSpec>` | No | Attachment columns of this table, keyed by column name. Default: empty. |
| `config.tables.<name>.attachments.<column>.storageBucket` | `String` | Yes | Supabase Storage bucket the object is written to. An empty value is refused. |
| `config.tables.<name>.attachments.<column>.ownerColumn` | `String` | Yes | Column whose value opens the object key, so a Storage policy can scope objects to their owner. An empty value is refused. |
| `config.tables.<name>.softDeleteColumn` | `String?` | No | Column that marks a row as deleted at the application level. A filter-targeted delete on this table stamps this column instead of removing the row, the row leaves every read until [`includeDeleted()`](./fetch-data.md#parameters) asks for it, and the low-level `apply(op = KizunaSyncOp.Delete)` is refused with `SOFT_DELETE_VIOLATION`. See [Delete data](./delete-data.md#notes). Default: `null`, and hard deletes are allowed. |
| `config.tables.<name>.conflictMode` | `KizunaSyncConflictMode` | No | Which rule resolves two writes to one of this table's columns. `Arrival` trusts server order and adds no stamp, so its push carries no `hlc` field. `Hlc` compares the origin clock stamp `apply` attaches, `"<rfc3339>|0|<node>"`, minted once per client. See [Conflict resolution](../../sync/conflict-resolution.md). Default: `Arrival`. |
| `config.tables.<name>.syncMode` | `KizunaSyncSyncMode` | No | Which directions this table syncs in. `ReadWrite` pulls the table and pushes its local writes. `PullOnly` makes it a read-only local cache: the engine refuses every local write to it with `LOCAL_UNSUPPORTED` before the write reaches the outbox. Only `PullOnly` reaches the engine, as `sync_mode`. See [Set the sync mode](../../sync/sync-rules-and-buckets.md#4-set-the-sync-mode). Default: `ReadWrite`. |
| `config.tables.<name>.key` | `List<String>` | No | The table's primary-key columns in key order. Their values name each row on the device and on the server, so the list matches the primary key `kizunasync sync` records for the table. [Row keys](../../sync/sync-rules-and-buckets.md#row-keys) lists the column types a key accepts. The engine receives it only when it differs from `["id"]`, and a table with `attachments` keeps that default. Default: `listOf("id")`. |
| `config.databasePath` | `String?` | No | Path of the [SQLite](https://grokipedia.com/page/SQLite) file. `":memory:"` opens a throwaway database, and a parent directory that does not exist is an error rather than a silent fallback. Default: `null`, which is an in-memory database. |
| `config.remote` | `KizunaSyncRemoteConfig?` | No | The [PostgREST](https://postgrest.org/) remote. A packaged build of the library refuses `null` with `CONFIG_INVALID`; only a build without the `http` Cargo feature falls back to a scripted remote that reaches no network, which suits offline host tests only. Default: `null`. |
| `config.remote.url` | `String` | Yes with a remote | Project URL such as `https://abc.supabase.co`, without the `/rest/v1` suffix. Must be `https`; plain `http` is accepted on a loopback or local-network host only (`localhost`, a `.local` name, or an IP address in a loopback, private, or link-local range, such as the `192.168.x.x` address a device uses to reach a local stack), and anything else is `CONFIG_INVALID`. |
| `config.remote.publishableKey` | `String` | Yes with a remote | The project's publishable key, sent as `apikey` on every call. JSON also accepts `anon_key`. |
| `config.remote.accessToken` | `String?` | No | A signed-in user's JWT, issued by Supabase [Auth](https://supabase.com/docs/guides/auth), when one is at hand at create time. Pull and push need a token, because the `kizunasync` functions are granted to the `authenticated` role. The engine reads this token for its user exactly as [Set access token](./set-access-token.md) does: on a new database it records the owner and fills the owner buckets, and a token of another user than the stored owner soft-blocks sync with `identity_changed`. Leave it `null` to open without a session; the [Host scheduler](./scheduler.md) hands the client a token before every sync. Default: `null`. |
| `config.remote.schema` | `String?` | No | PostgREST schema profile the sync functions live in. Default: `null`, which uses `kizunasync`. |
| `config.remote.localOnlyColumns` | `List<String>` | No | Device-only columns stripped from every mutation before push, because the server has no column to apply them to. Pull is unaffected. Default: empty. |
| `config.attachmentRoot` | `String?` | No | Directory the client owns for attachment bytes; it is created if missing. Required as soon as any table declares `attachments`. Default: `null`. |
| `config.defaultLimit` | `Int?` | No | Rows one pull page asks for. Default: `null`, which omits `limit` from the request and lets the server's own default apply. |
| `config.attachmentAttempts` | `Int?` | No | Transfer attempts one attachment gets before the queue marks it permanently failed. See [Retry an attachment](./attachment-retry.md). Default: `null`, which is the engine's own budget of five. |

## Returns

`Unit`. The function suspends on `Dispatchers.IO` and returns once the engine, its Tokio runtime, and the local database are open. `create` on a handle that already holds an engine replaces that engine.

## Errors

| Code | Condition |
|---|---|
| `ATTACHMENT_PORTS_MISSING` | A table declares `attachments` and `attachmentRoot` is `null`. The client raises this before the configuration reaches the engine. |
| `CONFIG_INVALID` | `clientId` is not a uuid. The client raises this before the configuration reaches the engine. |
| `CONFIG_INVALID` | The engine refused the configuration. The message names the field: an attachment spec without `storageBucket` or `ownerColumn`, a `databasePath` that cannot be opened, a `remote` that is `null` in a packaged build, that is not an object, or that is missing `url` or `publishableKey`, a `remote.url` that is not `https` and not on a loopback or local-network host, a `localOnlyColumns` that is not an array of strings, an `attachmentRoot` the process cannot create, a `conflict_mode` outside `"arrival"` or `"hlc"`, a `ByOwner` bucket whose column is empty (`tables.<name>.bucket_owner needs a non-empty bucket_column`) or is a key column (`tables.<name>.bucket_owner cannot fill the key column "id"` for the default key), a `key` that is empty, holds something other than a column name, or repeats a column, or a `key` other than `["id"]` on a table with `attachments`. |

Errors arrive as `KizunaSyncError.Engine`; `message` reads `"CODE: message"`, but a caller switches on `code` directly.

## Notes

Provision the project with [`kizunasync init`](../../cli/cli.md#kizunasync-init) before you call `create`.

The client talks to functions the [SQL pack](../sql-pack.md) installs.

The owner behind a `ByOwner` bucket is the user named by the `sub` claim of the first token a new database, or a database after [Reset](./reset.md), receives, whether `remote.accessToken` passes it here or [Set access token](./set-access-token.md) hands it over later. A token of another user later soft-blocks sync with the reason `identity_changed` until a reset runs, so one user's queued writes are never pushed under another user's session.

## Next steps

1. Provide the client to the app: the app's root waits for the open before it shows the first screen, as [step 4 of Swift and Kotlin](../../getting-started/native-clients.md#4-provide-it-to-the-app) shows.
2. Start the [Host scheduler](./scheduler.md) right after this call. The client has no sync loop of its own: the scheduler hands it the session and calls [Sync](./sync.md) at start, after every local write, on a timer, when the network comes back, and when the app returns to the foreground.
3. Read: [Fetch data](./fetch-data.md) answers from the local database.
4. Write: [Insert data](./insert-data.md), [Update data](./update-data.md), and [Delete data](./delete-data.md) commit locally and queue the write in the outbox.
5. Show sync state: the scheduler's `health()`, [Subscribe to events](./on.md), [Outbox depth](./outbox-depth.md), and [List rejections](./rejections.md).

## Related reference

- [Installing](./installing.md)
- [Set bucket](./set-bucket.md)
- [Set access token](./set-access-token.md)
- [Attach a file](./from-file.md)
- [Types](./types.md)
- [Swift: Initializing](../swift/initializing.md)
- [JavaScript: Initializing](../javascript/initializing.md)
