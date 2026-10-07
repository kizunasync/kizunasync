---
title: Roadmap
description: Implemented Alpha surfaces, the release gaps that remain, and later Kizuna work without presenting plans as shipped features.
status: alpha
docType: concept
audience: app-developer
---

# Roadmap

This page separates implementation, verification, and public distribution. Dates are absent on purpose: a milestone advances when its evidence and release criteria are met. [Project status](../getting-started/status.md#surface-matrix) records implementation and verification for each surface that exists.

## Implemented in the current Alpha

### Synchronization and local APIs

- Reads and optimistic writes run against local [SQLite](https://grokipedia.com/page/SQLite) through a Supabase-shaped query subset.
- Outbox processing is transactional and SQLite-backed, with stable mutation IDs, applied and rejected [verdicts](./glossary.md#verdict), rejection records, atomic batches, and reset.
- Pulls are incremental, and [fencing](./glossary.md#fencing) stops a cursor from advancing past a change that has not committed. They carry [checkpoints](./glossary.md#checkpoint), outbox rebase, [tombstones](./glossary.md#tombstone), [idempotent](https://grokipedia.com/page/Idempotence) overlap, and a polling fallback.
- The server resolves conflicts column by column, by server-arrival order, unless a table opts into [Hybrid Logical Clock](./glossary.md#hybrid-logical-clock-hlc) ordering with clock clamping.
- Kizuna ships [React](https://react.dev) hooks, [Vue](https://vuejs.org) composables, browser and [Expo](https://expo.dev) drivers, connectivity adapters, and Realtime [wake-ups](./glossary.md#wake-up).

### Attachments

- The attachment queue persists next to platform file stores, and its updates are transactional.
- A file at or below 6 MiB takes the Supabase [standard upload](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading).
- A file above 6 MiB takes a [resumable TUS upload](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) in fixed 6 MiB chunks, with a persisted session URL, offset recovery, and progress callbacks.
- The Rust attachment queue carries its own interruption and resume coverage.
- Each attachment carries an attempt budget, `attachmentAttempts` in `defineConfig`, default 5. The budget's sixth failure moves the entry to a permanent terminal state instead of retrying it forever, and a Storage 404 on download does the same. `retry`, `cancel`, and `remove` are the app-facing controls over that lifecycle.
- A peer verifies an attachment it did not upload through the `attachment_metadata` RPC, which checks the caller can see the owning row under its own RLS before returning integrity metadata.

Direct Swift and Kotlin hosts opt in to attachment bytes with `attachmentRoot` on `KizunaSyncClient.create`, and [Media attachments](../attachments/media-and-attachments.md) covers the application side.

### Rust and native clients

- Rust crates cover protocol, store, query, engine, transfer, HTTP remote, [N-API](https://nodejs.org/api/n-api.html), [UniFFI](https://mozilla.github.io/uniffi-rs/), [wasm](https://grokipedia.com/page/WebAssembly), CLI, bindgen, and conformance, and [Repository layout](./repository-layout.md#crates) names each one.
- `createKizunaSync` runs the Rust core on every runtime. It uses a driver-provided transport when the driver carries the engine, which is the browser worker driver. It uses UniFFI on [React Native](https://reactnative.dev) when the React Native [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) is linked, and N-API on Node and [Bun](https://bun.sh) when the addon loads. The app client makes that choice on its first engine call, and when nothing resolves, that call fails with `ENGINE_UNAVAILABLE` naming the artifact to install, and the client keeps that failure. The driver names the store as `databasePath`, or `null` for a private in-memory database.
- `kizunasync/web` runs `kizunasync-wasm` in a dedicated worker over the [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) sahpool VFS, one pool per database. It falls back to [IndexedDB](https://en.wikipedia.org/wiki/Indexed_Database_API) only where OPFS is unsupported. It elects one leader tab per database, and the other tabs relay calls to it over a [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).
- Generated Swift and Kotlin bindings expose typed `KizunaSyncClient` app clients, with fluent select and write builders, `inspect()`/`dispose()`, and a host `KizunaSyncScheduler` that publishes `health()`/`onHealth`.
- Native iOS and Android example projects build against those bindings.
- CI defines jobs for the Rust workspace, the wasm build with a 1.5 MiB [Brotli](https://grokipedia.com/page/Brotli) budget, the browser conformance lane, the generated Swift and Kotlin binding tests, the core-on-rust lane, and N-API prebuilds. It also builds the XCFramework and the Android AAR artifacts, and it runs simulator smoke, an iOS simulator launch, the Android host tests, and Android APK assembly. The Android wrapper is at [Gradle](https://gradle.org) 8.7 and AGP 8.6.1.

Physical-device release evidence remains future work.

### Provisioning and server pack

- The native Rust [CLI](../cli/cli.md#commands) covers initialization, table synchronization, status, diagnostics, migration linting, additive upgrades, deprovisioning (behind `--purge`, the schema itself), background job control (`kizunasync jobs`), deterministic seed data, and scoped churn; `init` and `sync` share a Recommended/Customize wizard, and both reach a hosted project over the Management API.
- A project receives one installable SQL pack migration plus generated project configuration.
- The pull and push RPCs leave Row Level Security in charge of every application row, and push returns an explicit verdict per mutation. The pack also carries push policies, an opt-in server-side [conflict journal](./glossary.md#conflict-journal) on the pull wire, and the `increment`, `arrayUnion`, and `arrayRemove` field transforms. It carries Realtime support, retention, and the `_provisions` ledger that records what `kizunasync deprovision` may remove.
- The tombstone reaper, changelog compactor, and client pruner run on schedules `kizunasync._settings` declares, and `kizunasync._schedule_jobs()` applies those schedules to `pg_cron`. The pack tries to enable `pg_cron` itself, and it installs cleanly either way. The three functions stay callable by hand through `kizunasync jobs run`.
- A client's identity travels on the wire as an optional `client_id`, registered in `kizunasync._clients` for a table that opts in, which gives retention a live-client floor and staleness a place to read from.
- The engine filters soft-deleted rows from local queries by default, and a local `delete()` on a soft-delete table performs the stamping update instead of a hard delete. A `pull-only` table refuses a local write before it reaches the server. A `set_bucket` key outside the table's declared [bucket](./glossary.md#bucket) column is refused the same way.
- `overwrites()` and `dismissOverwrite(id)` read the client-local `_kizunasync_overwrites` journal, filled from optional pull `conflicts` when the server-side conflict journal is on. React and Vue expose that journal through `useOverwrites`. The inspector ring surfaces an overwrite alongside a rejection.
- `RESET_REQUIRED` and `CHECKPOINT_EXPIRED` sit in the status catalog at level `error`. Each one is a soft block: sync stops making progress until the app clears the cause. `RESET_REQUIRED` carries an optional reason, `reset_required` or `identity_changed`, alongside the checkpoint's own `softBlockReason`. `needsReset` exposes the blocked state directly, on the sync-status hooks and on the native scheduler.
- Swift and Kotlin configs carry `defaultLimit` and HLC `conflictMode`. Swift installs a default foreground observer through the `UIApplication` and `NSApplication` notifications, and Android injects `KizunaSyncProcessForegroundSource` from the app. A `KizunaSyncRealtimeWakeup` port lets the app supply its own Realtime hint. The foreground signal and the Realtime hint both feed the poll loop, and that loop keeps running either way.
- Live SQL database tests run against the [local Supabase stack](https://supabase.com/docs/guides/local-development#cli).

### Protocol evidence

- The corpus manifest holds 50 entries, of which 49 execute and 1 is skipped, blocked on an open [protocol decision](./protocol-decisions.md#blocked-decisions).
- Six [TLA+](https://grokipedia.com/page/TLA%2B) property models check the protocol itself. They cover cursor monotonicity, no lost committed change, exactly-once effect, session guarantees, atomic checkpoint, and no resurrection.
- The protocol oracle executor, the Rust conformance runner, the N-API transport lane, and the browser lane all replay the corpus. The browser lane also records the open-to-first-query time.
- The [live SQL conformance gate](../operations/ci-cd.md#live-sql-conformance-gate) is pinned at 46 replayable transcript families: 45 pass, 1 is unsupported by a single-connection replay, and none diverge or error.

### Examples and tooling

- Five example apps cover Expo, React, Vue, native iOS, and native Android, and [Playground](../getting-started/playground.md) runs each of them.
- A read-only sync inspector reads a local database, with panels for settings, retention, the conflict journal, background jobs, and attachments.
- A documentation website renders the registered Markdown sources.

### Distribution

A `v*` tag on `main` publishes every channel below, as [CI and CD](../operations/ci-cd.md#release-workflows) records.

- npm publishes `kizunasync` and the five per-platform `@kizunasync/<platform>` packages through the lane described in [npm release](./native-packaging.md#npm-release).
- The Swift package `kizunasync/kizunasync-swift` ships with the `KizunaSyncFfi` [XCFramework](./native-packaging.md#xcframework) attached to a GitHub Release and pinned by checksum, and exports the `KizunaSync` and `KizunaSyncEngine` products.
- Kotlin `com.kizunasync:kizunasync` goes to Maven Central as an [AAR](./native-packaging.md#android-aar) that depends on `com.kizunasync:kizunasync-engine`, the AAR bundling the native library for each ABI.
- The React Native module inside `kizunasync` links the engine from the `KizunaSyncEngine` product of that Swift package and from Maven Central `com.kizunasync:kizunasync-engine`, so npm publishes after both, at the same version.

## Remaining Alpha release work

### Release contract

- Decide whether the Rust crates go to crates.io as part of the release contract.
- Define upgrade notes and rollback behavior for each channel.

A CI artifact is build evidence rather than a supported distribution channel.

### Complete environment evidence

- Record physical-device runs for the op-sqlite driver instead of relying only on its verification helper.
- Record native iOS and Android device behavior for persistence, auth token refresh, reconnect, process restart, and large datasets.
- Add a hosted Supabase [TUS](https://supabase.com/docs/guides/storage/uploads/resumable-uploads#upload-url) matrix for interruption, expired sessions, and resume on the supported client platforms.
- Keep browser worker/OPFS deployment checks aligned with each supported bundler.

### Freeze the remaining public contracts

- Resolve or explicitly defer the wakeup channel/payload decision without making correctness depend on it.
- Turn the current Alpha query subset and error codes into a versioned compatibility contract.
- Define supported runtime, database, Expo/React Native, Swift, Kotlin, and Android Gradle ranges for the first stable release.
- Document migration compatibility and public upgrade support once installations must be preserved across upgrades instead of discarded.
- Expose which bridge `createKizunaSync` selected: `kizunasync.engine` reports `'rust'`, and the bridge shows only in diagnostics, and only for the transport and UniFFI paths.

### Prove installation outside the monorepo

A release candidate must be tested in clean consumer projects that install exactly the coordinates the docs show (npm `kizunasync`, the Swift package `kizunasync/kizunasync-swift`, and Maven `com.kizunasync:kizunasync`) with no `workspace:*` or local path dependencies.

## Beta milestone

Beta should mean that an external developer can install supported artifacts, provision a new or existing Supabase project, run a documented example, upgrade the pack, and recover from common failures without reading repository internals.

The Beta gate includes:

- Published, versioned artifacts ship with release notes.
- Clean-room install tests pass on every supported platform.
- The protocol and live SQL conformance gates stay in CI.
- Physical-device evidence is recorded for the supported mobile paths.
- A compatibility matrix and a deprecation policy are published.
- A security review covers SQL grants, [RLS](https://grokipedia.com/page/Row-level_security) interaction, auth token handling, and the artifact supply chain.
- The documentation deployment is active, with link and registry completeness checks.

[Status taxonomy](../reference/status-taxonomy.md) defines the exact vocabulary behind Alpha, Beta, and Production.

## Later work

### Multi-column bucket parameters

Status: planned.

The wire `Bucket.params` field is already a map, the SQL pack matches every parameter key it receives, and the engine carries the full parameter map through `setBucket`. The server and the protocol therefore accept a selection like "the rows of user X in workspace Y". Three pieces are missing: a `byParams({ user_id: owner(), workspace_id: column() })` authoring helper in `defineConfig`, guide coverage, and conformance transcripts.

The project defers the authoring helper on purpose. The bucket-exit case is decided for the one column a table already names as its bucket: a write that moves a row out of a bucket value leaves that value a tombstone, delivered only to a caller who already held the row from it (`D-bucket-move-out`, `D-tombstone-delivery`). The other params `byParams` would add stay filters on live rows only, the same way an ordinary query parameter behaves today: a row that stops matching one keeps no tombstone, and a device that held it keeps a stale copy until a later rehydration drops it. Single-column owner buckets almost never re-home a row, while workspace membership changes are everyday operations, so this residual matters more once `byParams` ships.

Partial-replication systems that shipped richer selection all had to design this move-out case explicitly. [ElectricSQL removes a row when it leaves a shape](https://electric.ax/docs/sync/guides/shapes). [Realm Flexible Sync reverts out-of-view writes as compensating writes](https://www.mongodb.com/docs/atlas/app-services/sync/error-handling/errors/). PowerSync constrains [parameter operators](https://docs.powersync.com/sync/rules/supported-sql) and [caps buckets per user](https://docs.powersync.com/sync/rules/parameter-queries) to keep membership computable. Kizuna's model avoids their per-combination bucket growth, because one table stays one bucket whatever the parameter count, and the residual above is documented rather than silent.

The plan when this work is picked up, in order:

1. The `byParams` helper with `owner()` and `column()` value sources; `byOwner` and `byColumn` remain as single-entry sugar over the same map.
2. Guide and reference updates that state the limits in place: equality-only matching combined with AND, no OR and no inequalities, an index on every parameter column, the bucket-exit residual above, and `setBucket` not purging rows hydrated under earlier parameter values.
3. No server or engine change is expected. A multi-parameter conformance transcript and a shared conflict vector turn that claim into a tested fact instead of an assumption.

### TanStack DB adapter

Status: planned.

A possible `@kizunasync/tanstack` adapter would expose synchronized tables as TanStack DB collections while routing mutations through the Kizuna outbox. It is not present in the repository.

### Packaged driver TCK

Status: planned.

The corpus, the JavaScript headless harness, the Rust conformance runner, and the structural checks all exist, and [Drivers and the TCK](../reference/drivers-and-tck.md#current-maturity-boundary) states what they cover. A third-party driver author lacks one published package and command that installs on its own and runs the relevant matrix end to end.

### Standalone testing package

Status: planned.

`kizunasync/testing` already ships `createTempDatabase`. The in-memory reference server and deterministic corpus utilities stay checkout-only under the `conformance` subpath of the `core` workspace and `packages/protocol`. A published entry point that installs those without a monorepo checkout remains planned.

### Management and tooling surfaces

Status: planned.

The existing inspector is read-only. Hosted configuration, fleet visibility, richer sync statistics, and MCP/tooling integration remain planned and require an explicit security and hosting model.

### CLI adoption ping

Status: planned.

The `kizunasync init` wizard will ask one consent question in the spirit of "help Kizuna grow": whether to send a single anonymous registration event when a project is provisioned. [Governance](../../GOVERNANCE.md#3-the-local-database-is-the-users) binds its constraints ahead of any implementation. Those constraints are an explicit prompt with a visible default, and a closed, published field list. That list holds the tool and pack versions, the operating system and architecture, and a random locally minted identifier. The receiving side retains no request address, and a non-interactive session sends nothing. A `kizunasync telemetry status|enable|disable` command and `KSYNC_TELEMETRY_DISABLED=1` give explicit control. The synced clients send no telemetry at all, and that guarantee stays unconditional. Download counts for published packages remain the only other adoption signal.

### Expo Module over the UniFFI bindings

Status: planned.

When Expo SDK 58 ships Expo Modules 2.0 in beta, the React Native bridge becomes an Expo Module written as an annotated Swift and Kotlin class over the UniFFI bindings the native iOS and Android examples already use, replacing the generated Turbo Module and its C++ adapter in the `rn-uniffi` workspace. The JavaScript API of `kizunasync/expo` does not change. The module links the same `KizunaSyncEngine` product and `com.kizunasync:kizunasync-engine` artifact as the Turbo Module, built from the [XCFramework](./native-packaging.md#xcframework) and [AAR](./native-packaging.md#android-aar) lanes, so `npx expo run:ios` and `npx expo run:android` build it without a Rust toolchain in the application project. Expo Go stays unsupported, because it cannot load custom native code in any version, and a development build remains the supported path.

### Local projects started with `supabase stack`

Status: planned.

The CLI's [connection picker](../cli/cli.md#interactive-mode) probes the local stack on the `[db] port` that `supabase/config.toml` gives Postgres, or on Supabase's default `54322` when the key is absent, and the [local fallback](../cli/cli.md#database-connection) at the end of the connection ladder builds its URL from the same port. When a local project's `config.toml` leaves the ports out, Supabase's experimental [`supabase stack`](https://supabase.com/docs/guides/local-development/running-multiple-local-projects) commands assign it ports between 20000 and 32767, so the probe misses the running project and the fallback URL names the wrong port. When no fixed database port is configured, discovery and the local fallback will ask the Supabase CLI for the running local project's database endpoint, `endpoints.database.sql` in the output of `supabase status --output-format json`, and both will stay local and read-only.

### Declarative schema projects (pg-delta)

Status: planned.

Supabase's [declarative schemas](https://supabase.com/docs/guides/local-development/declarative-database-schemas) keep a project's schema as files under `supabase/schemas`, and `supabase db schema declarative sync` compares those files with the migration history and generates a migration through the [pg-delta diff engine](https://supabase.com/docs/guides/local-development/diff-engines), which `[experimental.pgdelta] enabled = true` turns on. With Supabase CLI 2.119.0 the pack and that workflow do not coexist. Once the migration `kizunasync init` writes is applied, `sync` refuses to plan: it reports the tree as a legacy export that lacks the `pg_cron` extension and the pack's three scheduled jobs (`kizunasync-compact-changelog`, `kizunasync-prune-clients`, and `kizunasync-reap-tombstones`), and warns that a sync generated from it could drop extensions or unschedule jobs. Regenerating the tree with `supabase db schema declarative generate` does not resolve it. The generator does not export the `kizunasync_rls` role, and its shadow database cannot replay the pack's `alter function … owner to kizunasync_rls` statements, which `0001_kizuna_init.sql` runs under a `create` grant on the `kizunasync` schema that it revokes afterwards. A project that carries the pack writes its application changes as versioned migrations instead, following the [migration guidance under `kizunasync lint`](../cli/cli.md#kizunasync-lint).

The plan is to make the pack coexist with a project's declarative tree, either by making the pack representable as declarative files that include its role and its ownership transfers, or by keeping the `kizunasync` schema out of the project's declarative sync. The proof is a `sync` that plans no changes after `kizunasync init` and after `kizunasync upgrade`.

### OrioleDB and Multigres

Status: planned.

[OrioleDB](https://supabase.com/blog/supabase-select-2026-recap#orioledb) is a Supabase storage engine in public beta, chosen when a project is created, that replaces the Postgres heap with an undo log and avoids table bloat and `VACUUM`. [Multigres](https://supabase.com/blog/supabase-select-2026-recap#multigres), in private alpha, gives Postgres multi-node high availability: it promotes a replica in seconds, and committed writes survive the failover.

The pack's cursor guarantee rests on how heap Postgres publishes a commit. A committing transaction becomes visible to new snapshots before it releases its locks. The pack numbers each transaction's changes at commit while it holds one advisory lock, so any snapshot sees the drawn numbers as a prefix, apart from numbers an aborted transaction consumed, and no later commit lands below a pull's cursor. [The live SQL horizon](../sync/fencing-and-horizons.md#the-live-sql-horizon) walks through that argument. OrioleDB replaces the heap that argument assumes, and a Multigres failover hands the primary role to a replica. Neither enters the supported database range that [Freeze the remaining public contracts](#freeze-the-remaining-public-contracts) calls for until the [live SQL conformance gate](../operations/ci-cd.md#live-sql-conformance-gate) and the pack's pull-fencing suites (`packages/supabase-pack/tests/pull-fencing-*.test.ts`) pass on an OrioleDB project and across a Multigres failover.

## Explicitly not promised

The roadmap does not promise a hosted Kizuna data plane, a non-Postgres backend, character-level [CRDT](https://grokipedia.com/page/Conflict-free_replicated_data_type) collaboration, or hard realtime delivery. Supabase [Postgres](https://grokipedia.com/page/PostgreSQL) remains the authority, and missed wakeups must remain recoverable through pull.

## Related pages

- [Project status](../getting-started/status.md)
- [Swift and Kotlin](../getting-started/native-clients.md)
- [CI and CD](../operations/ci-cd.md)
- [Consistency model](../sync/consistency-model.md)
- [Protocol decisions](./protocol-decisions.md)
