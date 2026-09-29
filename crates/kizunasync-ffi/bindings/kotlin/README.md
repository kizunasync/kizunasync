<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">Kotlin bindings</span>
</h1>

Gradle project that is the source of two Maven artifacts and hosts the JVM tests. `com.kizunasync:kizunasync` (module `:android`) is the Kotlin app client. `com.kizunasync:kizunasync-engine` (module `:engine`) carries only the native library, and `@kizunasync/rn-uniffi` depends on it too when built outside the monorepo. `release-kotlin.yml` publishes both coordinates to Maven Central. App developers add `com.kizunasync:kizunasync`, not this path, and Gradle pulls in the engine through that artifact's POM.

## Surfaces

| Surface | Role |
| --- | --- |
| `uniffi.kizunasync_ffi.KizunaSyncEngine` | Tracked UniFFI-generated API loaded through JNA |
| `com.kizunasync.kizunasync.KizunaSyncClient` | Typed coroutine wrapper; native calls run on `Dispatchers.IO` |

Proc-macro exports in [`kizunasync-ffi/src/lib.rs`](../../src/lib.rs) are the generation authority. `kizunasync.udl` is descriptive only. `Generated/uniffi/kizunasync_ffi/kizunasync_ffi.kt` is tracked and must not be edited by hand.

## Public types

`KizunaSyncClient`, builders and query types, `KizunaSyncConflictMode`, config types, `KizunaSyncAttachmentSpec`, `KizunaSyncOverwrite`, `KizunaSyncError`, inspector types, `KizunaSyncScheduler` and sync-health types, `KizunaSyncPathMonitor`, `KizunaSyncForegroundSource`, `KizunaSyncRealtimeWakeup`, and `KizunaSyncRealtimeSubscription`. Generated engine types are aliased as `KizunaSyncEngineEvent`, `KizunaSyncAttachmentStatus`, `KizunaSyncRejection`, `KizunaSyncCheckpoint`, and `KizunaSyncFromFileResult`. The `:android` module adds `KizunaSyncConnectivityPathMonitor` and `KizunaSyncProcessForegroundSource`.

## Configuration

`KizunaSyncClientConfig` carries `clientId`, `schemaVersion`, `tables`, `databasePath`, `remote`, `attachmentRoot`, `defaultLimit`, and `attachmentAttempts`. Keys left at engine defaults stay off the wire.

`clientId` must be a uuid or `create` refuses with `CONFIG_INVALID`. Passing null mints one (`deviceId` reports it).

`KizunaSyncTableConfig.conflictMode` is `Arrival` or `Hlc`. `select().includeDeleted()` brings back soft-deleted rows.

## Wake sources

`KizunaSyncScheduler` polls on its own timer and gates on `KizunaSyncPathMonitor`.

On Android, pass `KizunaSyncProcessForegroundSource` from the `:android` module (observes `ProcessLifecycleOwner`). The shared scheduler compiles for the plain JVM, which has no process lifecycle; a JVM host passes none and calls `notifyForeground()` when it knows.

`realtime` is an app-owned Supabase doorbell port. Copy an adapter over `supabase-kt`; this project declares no Supabase dependency. A message is only a hint.

Pass `needsResetSource` reading `client.checkpoint().softBlocked` so the scheduler publishes it on every health snapshot.

## Kernel methods beyond the typed surface

`KizunaSyncClient` reaches `attachmentRetry`, `attachmentCancel`, `attachmentRemove`, `overwrites`, and `dismissOverwrite` through JSON-RPC `call`, mapping refusals to `KizunaSyncError.Engine`.

## Tests

Checked-in wrapper: Gradle 8.7. Kotlin 1.9.24, JVM 17, JNA 5.14.0 when generated bindings are present.

```bash
cargo build -p kizunasync-ffi --features http
cd crates/kizunasync-ffi/bindings/kotlin
env -u ANDROID_HOME -u ANDROID_SDK_ROOT ./gradlew test
```

Clearing the SDK variables keeps this command on the JVM-only modules.

| Source set | Backend | Coverage |
| --- | --- | --- |
| `src/testGenerated/kotlin` | Generated API through JNA | Shared scenarios, builders, inspector, typed error mapping |
| `src/test/kotlin` | None | Scheduler, query-plan helpers, scenario oracle structure |
| `src/testFixtures/kotlin` | None | Scenario runner helpers (test-only; AAR ships the app client alone) |

With the Android SDK present, `./gradlew :android:testDebugUnitTest` runs connectivity and foreground unit tests under Robolectric. The CI `ffi-aar` job runs it before assembling the AARs.

## Android artifacts

`bun run cargo:aar` requires the Android NDK and `cargo-ndk`. It builds `libkizunasync_ffi.so` for arm64-v8a, armeabi-v7a, and x86_64 with `http` into `engine/src/main/jniLibs`, then assembles two AARs with compileSdk 35. `engine/build/outputs/aar/engine-release.aar` holds the three libraries and no classes (minSdk 21, the API level `cargo-ndk` links against). `android/build/outputs/aar/android-release.aar` holds the app client and no native code (minSdk 26). JNI libraries and AAR outputs are gitignored.

A remote works only when the loaded library was built with `http`, as the test build above is. A library built without it refuses any remote and syncs only against the offline `ScriptedRemote`.

## Publishing

`release-kotlin.yml` publishes `:engine` as `com.kizunasync:kizunasync-engine` and `:android` as `com.kizunasync:kizunasync`. The `:android` POM declares the engine as a compile dependency at the same version, so the client AAR carries no native library of its own. For a local check, run `./gradlew publishToMavenLocal -PkizunasyncVersion=<X.Y.Z>` from this directory after `bun run cargo:aar`. The build signs only when the `signingInMemoryKey` Gradle property is set, as `release-kotlin.yml` sets it for Maven Central, so a local run publishes unsigned artifacts.

## Regenerate

```bash
bun run cargo:bindgen
bun run cargo:bindgen:check
```

## Related

- [Multiplatform bindings](../README.md)
- [Native clients guide](../../../../docs/getting-started/native-clients.md)
- [`examples/todo-android`](../../../../examples/todo-android)
