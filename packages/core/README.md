<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/core</span>
</h1>

Kizuna sync client for SQLite-backed local-first apps. `createKizunaSync` runs the Rust engine through a driver-carried transport, a linked UniFFI handle, or the N-API addon. The driver names the database it opens. A `databasePath` of `null` gives the engine a private in-memory database. Building the client only checks the config, so it can live at module scope: the engine opens on the first call that needs it, and the sync loop starts there with an immediate first sync. A session token handed before that is kept and reaches the engine ahead of every other call. When none of the three resolves, every engine call fails with `ENGINE_UNAVAILABLE`, which names the artifact to install, and `getSyncHealth()` reports the same error. The Rust engine is the only implementation.

## Install

```bash
npm install @kizunasync/core @kizunasync/supabase @kizunasync/web
```

Use `@kizunasync/expo` instead of `@kizunasync/web` on Expo and React Native.

Those are the names `release-npm.yml` publishes. The registry has no version, so a checkout of this repository is how you run the packages.

## Entry points

| Entry point | Contents |
|---|---|
| `@kizunasync/core` | Engine and port APIs, `createKizunaSync`, query builders, config helpers, inspector, logging, attachment types, constants, shared protocol types |
| `@kizunasync/core/config` | `defineConfig`, `byOwner` / `byColumn` / `attachment` helpers, config types |
| `@kizunasync/core/constants` | `INTERNAL_TABLES`, `SCHEMA`, `SIGNED_URL_TTL_SECONDS`, `TRACKERS` |
| `@kizunasync/core/testing` | `createTempDatabase` (locator over a fresh temp database file) |
| `@kizunasync/core/conformance` | Client conformance harness (`makeTransportClient`, `runCorpusClient`, `TranscriptRemote`). Repository checkout only; reads `packages/protocol` |

## Get started

```ts
// @kizunasync/core
createKizunaSync(
  db: IStoreLocator,
  remote: IProtocolRemote,
  config: TKizunaSyncConfig,
  options?: IKizunaSyncOptions,
): IKizunaSync
```

| Argument | Where it comes from |
|---|---|
| `db` | `createWebWorkerDriver(file)` from `@kizunasync/web`, or `openExpoDriver(...)` from `@kizunasync/expo`. A driver can also report its platform's connectivity and foreground ports in `platformPorts` |
| `remote` | `createRpcRemote(supabase)` from `@kizunasync/supabase` |
| `config` | `defineConfig<Database>({...})` from `@kizunasync/core/config` |
| `options` | Optional engine dependencies plus `schemaVersion`, `inspector`, `logging`, `clientId`, and the 15-second default `pollIntervalMs`. `clientId` must be a uuid; absent, a uuid v4 is minted. `schemaVersion` and `pollIntervalMs` in `defineConfig` win over the option of the same name. `connectivity` and `foreground` win over the driver's `platformPorts`; with neither, the loop treats the network as always up and listens for no foreground signal. `fileStore` and `transfer` become required together when attachments are configured |

`fileStore` and `transfer` are required when any table declares an `attachment()` column; otherwise the factory throws `ATTACHMENT_PORTS_MISSING`.

### Minimal wiring (web)

```ts
// src/kizunasync.ts
import { defineConfig } from '@kizunasync/core'
import { createSupabaseKizunaSync } from '@kizunasync/supabase'
import { createWebWorkerDriver } from '@kizunasync/web'
import { supabase } from './supabase-client'

type Database = { public: { Tables: { todos: { Row: { id: string; title: string; done: boolean } } } } }

const config = defineConfig<Database>({
  tables: { todos: { sync: 'read-write' } },
})

const driver = createWebWorkerDriver('kizunasync.db')
const kizunasync = createSupabaseKizunaSync({ supabase, driver, config })
```

`createSupabaseKizunaSync` is the one-call Supabase composition. Manual `createKizunaSync(db, remote, config, options?)` remains available for a non-Supabase remote.

See [`examples/todo-react/src/kizunasync.ts`](../../examples/todo-react/src/kizunasync.ts) for full wiring including attachments, connectivity, and realtime wakeup.

## `IKizunaSync` surface

```ts
// @kizunasync/core
kizunasync.from(table)          // supabase-js-shaped local query builder
kizunasync.sync()               // push, upload after drain, then pull
kizunasync.pullOnce()
kizunasync.pushOnce()
kizunasync.setBucket(params)    // byColumn bucket values; the engine fills byOwner ones
kizunasync.on(handler)          // engine events (returns unsubscribe)
kizunasync.getCheckpoint()
kizunasync.seedCheckpoint(cursor)
kizunasync.getOutboxDepth()
kizunasync.rejections({ includeDismissed: false })
kizunasync.dismissRejection(mutationId)
kizunasync.overwrites({ includeDismissed: false })
kizunasync.dismissOverwrite(id)
kizunasync.reset()              // wipe local sync state and attachment bytes
kizunasync.dispose()
kizunasync.attachments          // IAttachmentClient, always present
kizunasync.inspector            // IInspector | null (on for NODE_ENV 'development' or 'test', off otherwise, unset included)
kizunasync.engine               // 'rust' (diagnostic, not a switch)
kizunasync.connectivity         // IConnectivity the sync loop follows
kizunasync.setRemoteAccessToken(token) // kept until the engine opens, then sent first
```

`kizunasync.attachments` carries the byte queue: `fromFile`, `resolveDownload`, `getStatus`, `watch`, `vacuum`, plus `retry`, `cancel`, and `remove`. `fromFile` imports the picked file, queues its upload, and writes the ref into the row's column as one local update, so the row has to exist first (`ATTACHMENT_ROW_GONE` otherwise). A status reports `permanent` beside `state`: `failed` with `permanent` false is retried by the next sync; with it true, the row has spent its `attachmentAttempts` budget and waits for `retry`, which wakes the sync loop the way a local write does. A client built without both the `fileStore` and the `transfer` ports still has `kizunasync.attachments`, but every method fails with `ATTACHMENT_PORTS_MISSING` and `watch` hears nothing.

`kizunasync.from(table)` supports local `select`, `insert`, `update`, and `delete`. Filters include `eq`, comparisons, `like`/`ilike`, `is`, `in`, boolean clauses, containment, and local search, followed by `order`, `limit`, `single`, or `maybeSingle`. All reads are local: a `select` becomes a query plan the engine evaluates. The one piece of query logic in this package is the PostgREST clause parser behind `.or()` and `.and()`. supabase-js forwards those strings to PostgREST without parsing them; local reads never reach PostgREST, so this parser decodes them instead. Unsupported constructs such as `rpc`, `upsert`, relational selects, `range`, `overlaps`, `match`, `filter`, and `csv` throw `LOCAL_UNSUPPORTED`; there is no network fallback.

## Exports

| Family | Exported from `@kizunasync/core` |
|---|---|
| Client | `createKizunaSync`, `IKizunaSync`, `IKizunaSyncOptions`, `parseFailureEnvelope` |
| Query builders | `ILocalFromBuilder`, `ILocalSelectBuilder`, `ILocalWriteBuilder`, result types, `IWriteOptions`, `IWriteResult`, `TContainsValue` |
| Query plan | `TQueryPlan`, `TQueryFilter`, `TQueryOrder`, `TQueryResult`, `TQueryCompareOp`, `TApplyWhereRequest` |
| Field transforms | `increment`, `arrayUnion`, `arrayRemove`, and matching type guards / sentinel types |
| Inspector | `createInspector`, `IInspector`, `IInspectorSnapshot`, `IInspectorVerdict`, `TOutboxEntry` |
| Ports | `IStoreLocator`, `TStoreDurability`, `IEngineTransport`, `IProtocolRemote`, `IFileStore`, `ITransfer`, `IWakeup`, `IForeground`, `IConnectivity`, `alwaysOnline` |
| Wire contracts | `TEngineError`, `EEngineErrorCode`, mutation/row/event/checkpoint types, rejection and overwrite records, generated pull/push message types |
| Attachments | `IAttachmentClient`, `TAttachmentStatus`, `TAttachmentState`, `TFromFileArgs`, `TFromFileResult`, `contentKey`, `mimeForExt` |
| Diagnostics | `createLogger`, `createConsoleLogger`, `noopLogger`, `ISyncHealth`, `verdictToMessage`, `subscribeVerdictToasts` |

`@kizunasync/core/config` also takes `schemaVersion` (default 1) and `attachmentAttempts`. `@kizunasync/core/conformance` exports `makeTransportClient`, `runCorpusClient`, `runTranscriptClient`, `TranscriptRemote`, `resolveCorpusRoot`, `parseCallEnvelope`, and `FIXED_NOW`.

## `defineConfig`

```ts
// src/kizunasync.ts (excerpt)
import { attachment, byOwner, defineConfig } from '@kizunasync/core/config'

const config = defineConfig<Database>({
  tables: {
    todos: {
      sync: 'read-write',
      bucket: byOwner('user_id'),
      attachments: { image_path: attachment('todos', { ownerColumn: 'user_id' }) },
    },
  },
  pullLimit: 500,
  realtimeWakeups: true,
})
```

Typed against your generated `Database` type, so a typo'd table or column name is a compile error. Defaults: `conflict: 'arrival'`, `pullLimit: 500`, `realtimeWakeups: true`. It leaves `pollIntervalMs` absent; `createKizunaSync` supplies the 15-second runtime default. Tombstone retention, push policy, and the per-table conflict journal are server settings in `kizunasync._config` and `kizunasync._settings`, written by `kizunasync init` and `kizunasync sync`.

## Tests

```sh
bun test   # from packages/core/
```

Build the addon first with `bun run cargo:napi`. Then pass `createTempDatabase().driver` to `createKizunaSync` with your own `IProtocolRemote` fake, and call `remove()` when done.

`createTempDatabase()` names a database file nothing else holds. Without the Rust core the suite is skipped or refused, never quietly answered by something else.

See [Test offline behavior](../../docs/operations/test-offline-behavior.md) for a complete example.

## Related

- [Architecture](../../docs/resources/architecture.md)
- [Define config](../../docs/reference/javascript/define-config.md)
- [CLI configuration](../../docs/cli/configuration.md)
- [JavaScript reference](../../docs/reference/javascript/introduction.md)
- [Quick start](../../docs/getting-started/quickstart.md)
- [`@kizunasync/protocol`](../protocol/README.md)
