---
title: Project status
description: What is implemented in the repository, which checks exist, and which gaps remain in the Kizuna Alpha.
status: alpha
docType: reference
audience: app-developer
---

# Project status

Kizuna is Alpha: the repository contains a working client engine, drivers, a SQL pack, a native [CLI](../cli/cli.md), native bindings, tests, and the five examples in [Playground](./playground.md). Most npm workspaces are publishable (`publishConfig.access: public`), and the release workflows publish them on a `v*` tag matching the workspace version. `@kizunasync/utilities`, `@kizunasync/ui`, `@kizunasync/protocol`, and `@kizunasync/supabase-pack` stay private, and Rust crates carry `publish = false`.

The native CLI's user-facing `VERSION` constant and the SQL pack's `_provisions.pack_version` both read `0.2.6-alpha.2` from Cargo, matching every other workspace; [`kizunasync --version`](../cli/cli.md#global-options) prints that value.

This page separates two states: "Implemented in the repository" describes a source-backed surface, and "Verified" applies only when the named automated or manual evidence exists. Code that exists and a check that proves the code behaves are different things, and no line below lets one stand in for another.

## Surface matrix

| Surface | Repository state | Distribution and evidence |
|---|---|---|
| [Shared app client](../resources/repository-layout.md#three-layers) | Implemented: local query subset evaluated inside the Rust kernel on every runtime, optimistic writes, transactional SQLite-backed outbox, pull/push scheduler, rejection journal, reset, events, inspector snapshot, attachments | npm `@kizunasync/core`; abrupt-termination evidence remains driver/platform-specific |
| Rust engine | Implemented across the store, query, protocol, engine, transfer, remote HTTP, N-API, UniFFI, and wasm crates, and it is the only engine any client runs | Crates are workspace-internal; workflows build native artifacts for the bindings above |
| Browser driver | Implemented as the Rust engine compiled to WebAssembly in a dedicated worker, over the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) synchronous-access-handle pool or the relaxed [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) fallback, with one leading tab per database and the others proxied to it | npm `@kizunasync/web` |
| Expo driver | Implemented with `expo-sqlite` on device, the `@kizunasync/web` driver on Expo web, plus file storage and connectivity | npm `@kizunasync/expo`. The Expo web target is wired to the `@kizunasync/web` driver, and a Metro web export bundles the `@kizunasync/web` worker as its own bundle. |
| React Native op-sqlite driver | Implemented behind the common driver API with a verification helper | Opt-in; no documented physical-device release evidence |
| React and [Vue](https://vuejs.org) bindings | Implemented providers, hooks/composables, query invalidation, sync state, rejections, and attachments | npm `@kizunasync/react` and `@kizunasync/vue` |
| Supabase adapters | Implemented RPC remote, Realtime doorbell, standard Storage transfer, and resumable TUS transfer | npm `@kizunasync/supabase` |
| SQL pack | Implemented as one installable migration plus generated per-project table configuration, including the opt-in server-side conflict journal | Source-available under PolyForm Shield; installs through `kizunasync init` |
| CLI | Native Rust commands for `init`, `sync`, `status`, `doctor`, `lint`, `upgrade`, `deprovision`, `jobs`, `mock seed`, `mock churn`, and `version`, plus the global `-v` / `--version` flags; a guided wizard for `init` and `sync`, and Management API parity for both | Invoke as `npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, or `bunx kizunasync` |
| Direct Swift and Kotlin | Implemented: typed `KizunaSyncClient` over UniFFI matching `IKizunaSync`'s write builders, catalog error codes, and verdict-ring inspector (journal, events, transforms, opt-in `attachmentRoot` attachments, host `KizunaSyncScheduler` with `health()`/`onHealth`) plus iOS and Android example projects | Swift package `kizunasync/kizunasync-swift` and Maven `com.kizunasync:kizunasync`; Android AAR/APK uses [Gradle](https://gradle.org) wrapper 8.7 with AGP 8.6.1 |
| React Native Rust path | `@kizunasync/rn-uniffi` loader and generated ubrn Turbo Module | npm `@kizunasync/rn-uniffi` as a dependency of `@kizunasync/expo`; needs an autolinked native rebuild |
| Protocol and corpus | Schemas, decision registry, TypeScript oracle, golden transcripts, Rust runner, and six TLA+ property models | Public source; no standalone third-party TCK package |
| Examples | Expo, React, Vue, native iOS, and native Android | Source projects with individually documented runnable lanes; Android AAR/APK configure under wrapper 8.7 / AGP 8.6.1 when the SDK is present; JVM host tests unset the SDK variables |
| Sync inspector | Read-only [Next.js](https://nextjs.org) inspector exists in `apps/sync-inspector` | Local development tool bound to `127.0.0.1`; not deployed |
| Documentation website | Next.js renderer loads the public Markdown registry | Deploys to Vercel through `deploy-website.yml` when a `v*` tag on `main` runs the release pipeline |

## Engine selection

The app-facing JavaScript app client, [`createKizunaSync`](../reference/javascript/initializing.md), chooses its engine on its first use, and only an engine that can open the same [SQLite](https://grokipedia.com/page/SQLite) database as the driver, as [How Kizuna works](./how-kizuna-works.md#kernel-and-app-clients) explains:

- A browser app runs Rust through [WebAssembly](https://grokipedia.com/page/WebAssembly). The `@kizunasync/web` driver carries the engine itself: the worker owns the store, and the driver exposes no SQL methods of its own, so the transport is the only route to those rows.
- [Node](https://grokipedia.com/page/Node.js) and [Bun](https://bun.sh) run Rust through [N-API](https://nodejs.org/api/n-api.html) when the addon loads. The driver names the store as `databasePath`, or `null` for a private in-memory database.
- React Native runs Rust through [UniFFI](https://mozilla.github.io/uniffi-rs/) when the [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) is linked. The `@kizunasync/expo` drivers load it through their `loadNativeEngine`, so `@kizunasync/core` never imports `@kizunasync/rn-uniffi`. The same `databasePath` rule applies.
- Where none of the three resolves, the app client's first use fails with `ENGINE_UNAVAILABLE`, which names the artifact to install plus every path the addon loader tried, and every later engine call fails with the same error. Building the client never throws it. There is no engine to fall back to, and no environment variable that changes the outcome.

The JavaScript app client exposes the attachment queue, which [Media and attachments](../attachments/media-and-attachments.md) documents. Direct Swift/Kotlin hosts opt in with `attachmentRoot` on [`KizunaSyncClient.create`](../reference/swift/initializing.md) ([`fromFile`](../reference/swift/from-file.md), [`resolveDownload`](../reference/swift/resolve-download.md), [`vacuum`](../reference/swift/vacuum.md), [`watch`](../reference/swift/watch.md)). React Native UniFFI must omit `attachment_root` so the JavaScript host's attachment queue owns bytes.

## Attachment status

The JavaScript Supabase transfer chooses by byte size:

- A file of at most 6 MiB takes the [standard Storage upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading).
- A file above 6 MiB takes a [resumable TUS upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) in 6 MiB chunks.
- A new TUS session URL is persisted before the first chunk and reused to recover the server offset.

Each attachment carries an attempt budget, `attachmentAttempts` in [`defineConfig`](../reference/javascript/define-config.md), default `5`. The budget's sixth failure, and a Storage 404 on download, move the queued entry to a permanent terminal state rather than retrying it forever; `retry`, `cancel`, and `remove` are the app-facing controls over that lifecycle.

The repository includes TUS unit coverage and Rust interruption/resume coverage. A normal unit test is not evidence of a successful physical-device upload to a hosted Supabase project. [Match the test to the claim](../operations/test-offline-behavior.md#6-match-the-test-to-the-claim) states which suite backs which claim.

## Protocol evidence

The corpus manifest, which the [Protocol reference](../reference/protocol.md) describes, contains 50 cases:

- 49 cases execute. The JavaScript reference executor runs them against the oracle server, and three client lanes run them against the engine: the Rust conformance runner, the N-API transport lane in `@kizunasync/core`, and the browser lane in `@kizunasync/web`.
- 1 case is skipped; `wakeup/002-wakeup-payload` has no transcript bytes because the channel payload remains an open protocol decision.
- Six [TLA+](https://grokipedia.com/page/TLA%2B) models cover cursor monotonicity, no lost committed change, exactly-once effect, session guarantees, atomic checkpoint, and no resurrection.

The live SQL replay used by the database job pins 46 replayable transcript families:

- 45 families replay as `PASS-SEMANTIC`.
- 0 families replay as `DIVERGED`.
- 1 family is `UNSUPPORTED`, because a synchronous single-connection replay cannot deterministically reproduce the held-transaction fencing race.
- 0 families end in `ERROR`.

The live-SQL count and the 50-case corpus count measure different things and must not be combined. One counts recorded protocol cases and the other counts transcript families replayed against a live [Postgres](https://grokipedia.com/page/PostgreSQL), so a sum of the two would describe nothing.

## SQL pack status

`packages/supabase-pack/pack.manifest.json` separates:

- `0001_kizuna_init.sql` is the installable engine pack.
- `0002_example.sql` is the local demo fixture.

The pack creates Kizuna-owned schema objects, itemized in [What is installed](../cli/whats-installed.md). Registering an application table also installs Kizuna [triggers](https://supabase.com/docs/guides/database/postgres/triggers#creating-a-trigger) on that table; it does not add Kizuna columns or replace the table's [RLS policies](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies). [Buckets](../sync/sync-rules-and-buckets.md) select rows but do not authorize them.

Turning on a table's [`conflict_journal`](../cli/configuration.md#kizunasync_config) column enables server-side recording of overwritten column values in `kizunasync._conflict_journal`, which [Conflict history](../sync/conflict-resolution.md#conflict-history) explains. It defaults to false. Pull may attach matching rows as optional `conflicts`, omitted when empty. The engine persists `_kizunasync_overwrites` and emits `COLUMN_OVERWRITTEN`. Authenticated callers have no `SELECT`; `service_role` can read the audit rows.

[`kizunasync._settings`](../reference/sql-pack.md#kizunasync_settings) also carries retention knobs and job schedules. The three schedules are the tombstone reaper, the changelog compactor, and the client pruner, each a UTC crontab that [`kizunasync._schedule_jobs()`](../reference/sql-pack.md#kizunasync_schedule_jobs) writes into `pg_cron`. The knobs are client TTL, HLC skew, and project tombstone retention. The pack tries to enable `pg_cron` itself and installs cleanly either way. [`kizunasync jobs`](../cli/cli.md#kizunasync-jobs) runs the three functions by hand over a service connection, whether or not `pg_cron` is present.

## Current limitations

1. Distribution is source-only. npm, crates.io, Maven, Swift package URLs, GitHub Releases, and native prebuilt delivery all build and run from this checkout; [Publish supported artifacts](../resources/roadmap.md#publish-supported-artifacts) names what each pipeline still needs before it ships a package.
2. The local query API is a subset. Unsupported [PostgREST](https://postgrest.org/) operations throw `LOCAL_UNSUPPORTED`; there is no transparent network fallback. [Supported query operators](../reference/query-operators.md) lists what the subset answers.
3. Offline acceptance is optimistic. [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies), constraints, preconditions, and push policies can reject a queued mutation after reconnect, and [Offline writes](../sync/offline-writes.md) shows how to surface that verdict.
4. Native distribution is path-only. Swift/Kotlin [`KizunaSyncClient`](../reference/swift/introduction.md) matches `IKizunaSync` in-repo; the SPM and Maven/AAR release pipelines are defined but unexercised. Android configuration uses wrapper 8.7 with AGP 8.6.1. The file picker is the app's (`fromFile` takes a path). There are no native [React](https://react.dev)-style hooks; [Swift and Kotlin](./native-clients.md) shows the pattern that replaces them.
5. Physical-device release evidence is incomplete. CI defines host, iOS simulator, [Expo](https://expo.dev) simulator, and Android assembly lanes, and it records no physical-device matrix. AAR and APK jobs produce CI artifacts.
6. The wakeup byte format is not final, because the wakeup payload decision remains blocked. Polling and explicit pull preserve correctness meanwhile.
7. Kizuna does not package third-party driver tooling. The corpus and headless harness exist, and no standalone TCK command ships.
8. The Android connectivity path monitor and foreground source run under Robolectric on the `:android` lane, which exercises `KizunaSyncConnectivityPathMonitor` and `KizunaSyncProcessForegroundSource` against Android's real APIs on the JVM. Only device behavior, real radios and the real process lifecycle, is unverified.
9. The CLI refuses `--require-atomic`. Ordinary writes are non-atomic, so enabling the flag would dead-letter them. `kizunasync doctor` fails when `_settings.require_atomic` is already on. `kizunasync sync --no-require-atomic` turns it off.
10. `LocalStore` wraps one `rusqlite::Connection`, which is `Send` and not `Sync`: one store serves one thread at a time. Every binding gives it a dedicated thread of its own instead of sharing it: N-API runs each command as a task on a `LocalSet` over one thread, and UniFFI runs a per-handle actor thread that receives closures and returns their replies. [Engine selection](#engine-selection) names which client uses which lane.
11. The protocol corpus leaves five cases uncovered. They are pagination under concurrency, transforms on an absent or RLS-hidden row, and `transforms` on insert or delete. The other two are integers at or above 2^31 and the `KZP` push-policy error codes. The pack test `pull-fencing-continuation.test.ts` covers the continuation-page fencing case the corpus omits. Each gap is a hole in test coverage, not a second implementation of the engine.
12. A synced table needs a primary key whose columns are `uuid`, `text`, `character varying`, `smallint`, `integer`, or `bigint`, and a table with an attachment column needs a single `uuid` key named `id`. On a read-write table keyed by an identity or `serial` column, an insert made offline has to carry the key value, because the device cannot generate one. [Row keys](../sync/sync-rules-and-buckets.md#row-keys) recommends uuid keys for the tables devices create rows in.

Sequenced future work lives on the [Roadmap](../resources/roadmap.md), not on this page.

## Next steps

- [Roadmap](../resources/roadmap.md): sequenced future work, with each item's status.
- [Swift and Kotlin](./native-clients.md): the native client setup this page scopes.
- [CI and CD](../operations/ci-cd.md): the workflows behind the evidence claims above.
- [Status taxonomy](../reference/status-taxonomy.md): what implemented, verified, and published each mean.
