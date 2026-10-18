---
title: Turso migration and recovery
description: Upgrade existing local stores to Turso, preserve offline data, and verify native artifacts before release.
status: alpha
docType: reference
audience: contributor
---

# Turso migration and recovery

The shared store now uses Turso 0.8.3 through `kizunasync-db`. Desktop N-API,
Swift, Kotlin, React Native, Expo, and browser WASM all compile the same store
and engine. Supabase remains the remote; this change does not enable Turso Cloud
sync or require a Turso account.

This is an **unreleased source migration**. Native artifacts must be rebuilt and
tested before publishing it. The existing Swift release URL and checksum still
identify the previously published binary; they must not be relabeled as Turso.

## Existing native databases

Keep the database path and application identity unchanged. Expo resolves the
same `Documents/SQLite/<name>` on iOS and `files/SQLite/<name>` on Android through
its native module, without opening expo-sqlite.

On first open, the engine:

1. Takes an exclusive migration lock at `<database>.kizunasync-turso.lock`.
2. Copies the original database and any WAL, SHM, and rollback journal into
   `<database>.kizunasync-pre-turso/`. A SHA-256 manifest verifies every file;
   the source is checked again before the snapshot is committed. Snapshot
   files and directories are flushed before the directory is renamed.
3. Refuses an unfinished SQLite rollback journal. Recover that database with
   the previous application's SQLite engine first; Turso must not ignore it.
4. Opens the existing SQLite-format data with Turso, applies the existing
   schema upgrades, and runs `PRAGMA integrity_check`.
5. Atomically records `<database>.kizunasync-turso-v1` only after success.

A failed copy, busy migration lock, invalid marker, corrupt backup, or failed
integrity check refuses the open. It does not replace the database with an empty
one. A completed snapshot is never overwritten on retry. Incomplete temporary
snapshots are not treated as completed backups. Close every previous app version
and any external SQLite writer before upgrading; the migration lock coordinates
new Kizuna instances, not arbitrary legacy SQLite processes.

Rows, outbox order and in-flight flags, atomic batch membership, cursor strings,
client identity, HLC, rejection/dead-letter/overwrite journals, pushed IDs,
persisted pull pages, attachment paths, and TUS offsets remain in their existing
tables. Attachment bytes are not moved or deleted.

## Existing browser databases

The worker imports the previous `sqlite-wasm-vfs` OPFS pool or relaxed IndexedDB
blocks, preserving the legacy namespace. It copies the OPFS data and committed
WAL into `turso-v1/`, leaving the original pool intact. IndexedDB imports are
committed atomically to a separate Turso database. A readiness marker follows
schema and integrity checks. All initialization and acknowledged RPC writes
await persistence; an IndexedDB failure is returned as `STORE_UNAVAILABLE`.

Web Locks prevent concurrent writers. Contention is retried and then reported
as `STORE_BUSY`. An existing IndexedDB fallback remains authoritative when a
browser later gains OPFS. A placement record prevents an existing OPFS database
from silently becoming an empty fallback after permissions change. Divergent
populated backends and unfinished rollback journals fail with recovery guidance.

The browser uses a custom worker-local Turso I/O adapter with synchronous OPFS
handles or an IndexedDB persistence boundary. It does not use the Turso JavaScript
SDK's shared-memory worker. No COOP/COEP headers are required. Turso's internal
temporary-database clock requires the narrowly documented
[vendored WASM clock patch](../../vendor/README.md).

The optimized browser binary in this change is 11,083,718 bytes (4,013,466 bytes
with gzip). The IndexedDB fallback retains database images in worker memory and
persists full-file snapshots at write boundaries. Measure download, startup,
memory, and write latency with the application's expected database size before
rollout; small conformance fixtures do not establish large-database performance.

## Expo SDK 58 and Modules API 2.0

The native host is `KizunaSyncExpo`, implemented with Swift `@ExpoModule`, `@JS`,
and `@Event`, and Android's Modules API 2.0 annotations/compiler plugin. It owns
engine initialization, asynchronous calls, ordered native event forwarding, and
teardown. Observer identifiers stay 64-bit in native code; JavaScript identifiers
use strings/bigints. Browser and SSR imports do not initialize JSI.

The example follows Expo 58's published bundled-module versions: Expo 58.0.13,
React Native 0.88.0, and React 19.3.0. Rebuild a development client; Expo Go and an
OTA JavaScript update cannot install the host or replace the engine binary.
The host checks `store_kind.engine == "turso"` and rejects an old binary.

For development before the matching artifacts are published:

- Build the XCFramework and render a local Swift package with
  `scripts/sync-swift-package.sh --local-xcframework`. Set
  `KIZUNASYNC_SWIFT_PACKAGE_PATH` to that package. The new `KizunaSyncFfi` product
  exposes the typed bindings; the bare React Native binary product remains.
- Build the Android AARs, publish `:engine` and `:android` to a local Maven
  repository, and set `KIZUNASYNC_MAVEN_REPO` to that repository. This makes the
  repository exclusive for `com.kizunasync` throughout the app, so a runtime
  dependency cannot silently resolve an older engine from Maven Central.

Keep Supabase auth storage unchanged during an installed-app upgrade. If an app
uses expo-sqlite's localStorage adapter for authentication, transfer that session
separately before removing that dependency. The example already uses SecureStore
on native and AsyncStorage on web.

## Verification and release

The checked-in SQLite fixtures are generated by Python's original SQLite engine,
not by Turso. Tests compare every stored table, including large integer cursor
strings and upload state. Native tests cover closed files, an older attachment
schema, committed SQLite WAL, immutable backups, corrupt backups, initialization
locks, hot rollback journal refusal, and process termination before/after COMMIT.
Browser tests cover legacy OPFS/WAL and IndexedDB imports, reload persistence,
divergent backends, conformance, query parity, and tab handover.

Linux Rust/N-API, Chromium, Kotlin host tests, and Android native builds can run
in this cloud environment with the installed Android toolchain. Apple
compilation, Windows native tests, and native ARM runtime tests require their
platform runners. The CI workflow includes native migration
tests on the N-API host matrix, Swift binding tests, the SDK 58 iOS simulator
smoke, and Android Expo assembly against freshly built artifacts. The Android
job checks that every supported ABI in the APK contains the current engine's
loadable code/data and that its 64-bit engine libraries have 16 KB ELF and ZIP
alignment. Symbol stripping is allowed. Passing Linux
tests or cross-target `cargo check` does not establish those runtime results.
Browser runtime evidence here covers Chromium; Safari and Firefox still need
upgrade and persistence checks before claiming that browser matrix is verified.

The implementation was checked on Linux on 2026-10-16 and 2026-10-17:

| Check | Result |
| --- | --- |
| Shared Rust store, engine, and UniFFI contracts | Passed, including original SQLite migration fixtures and crash recovery tests |
| JavaScript core through the rebuilt N-API addon | 1,031 passed; one existing wakeup-specification skip |
| Chromium conformance, query parity, migration, and storage continuity | 17 passed |
| Expo host unit tests and npm packaging tests | 85 passed |
| Expo example tests | 27 passed |
| SDK 58 Metro production web export and Chromium smoke | Rendered UI, durable Turso initialization, no page errors, no cross-origin isolation |
| Android host source against published Modules API 2.0 runtime and generated UniFFI types | Kotlin type-check passed; native assembly and runtime still pending |
| Kotlin bindings against the native Turso library | 99 passed; 3 existing packaged-build scenario skips |
| Android connectivity and process lifecycle host tests | 7 passed under Robolectric |
| Android engine and client release AARs | Built and staged locally for arm64-v8a, armeabi-v7a, and x86_64; 64-bit engine ELF alignment checked |
| SDK 58 Android project | Gradle configuration passed; full APK build blocked by Google Maven HTTP 503 dependency responses |
| APK engine verification script | Passed with real LLVM-stripped engine libraries for all three ABIs; rejected altered engine data in a test archive |
| Expo Android prebuild, Apple/Android autolinking, and bundled-version check | Passed; version check used Expo's published offline bundle map |
| Workspace Clippy, Rust formatting, TypeScript, affected JavaScript lint, documentation, and npm import smoke | Passed |
| Cargo dependency advisories, licenses, and sources | Passed after updating rustls to 0.23.46 |

The cloud environment has no Xcode. GitHub repository API access is now
available for platform CI. Google Maven returned HTTP 503 during the local
SDK 58 app's AndroidX dependency resolution, so its full APK build is not
verified locally. Full Expo native compilation and device/runtime checks
remain release requirements until the relevant CI jobs pass.

Publish only after those jobs pass, with one new version across npm, Swift, and
Maven. Build and publish matching Turso native artifacts and regenerate the Swift
binary checksum. Validate an installed-app upgrade on device with pending writes
and a resumable upload before production rollout.

## Recovery

Stop the application before copying or restoring database files. Preserve the
current database, all sidecars, attachment files, and the migration snapshot.
Verify the snapshot manifest before using it. Recover a hot rollback journal
with the previous SQLite application against a copy first.

The pre-Turso snapshot contains data only up to the upgrade. Restoring it after
new offline writes would lose those later writes. Export and reconcile current
pending mutations and upload progress before any such rollback; do not delete
the live WAL or browser `turso-v1` files to make an older version start. Browser
legacy pools remain recovery sources, but they are not updated by subsequent
Turso writes. No automatic downgrade to stale storage is performed.

## Related pages

- [Test offline behavior](./test-offline-behavior.md)
- [CI and CD](./ci-cd.md)
- [Expo installation](../reference/expo/installing.md)
