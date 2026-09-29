<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">example: todo-android</span>
</h1>

Source-only Gradle project for the direct Kizuna Kotlin app client. Not a Bun/Turbo workspace. Uses the in-repository Kotlin binding rather than the Maven artifact.

[settings.gradle.kts](./settings.gradle.kts) includes binding projects by local path:

- `:kizunasync` → `../../crates/kizunasync-ffi/bindings/kotlin` (always present for JVM host tests)
- `:engine`, `:kizunasync-android`, and `:app`: included only when `ANDROID_HOME` or `ANDROID_SDK_ROOT` is available

The root `cargo:aar` task writes the native libraries into the binding's `engine` module, so run it before the first Android build. `:app` receives them through `:kizunasync-android`, which declares `api(project(":engine"))`.

## What it demonstrates

`com.kizunasync.kizunasync.KizunaSyncClient` (coroutine app client over the generated UniFFI engine), plus `KizunaSyncScheduler`, `KizunaSyncConnectivityPathMonitor`, and `KizunaSyncProcessForegroundSource`. Current operations: client creation, local apply/query, sync, outbox depth, access-token replacement, and the scheduler's poll/backoff/connectivity policy with `onError` reporting.

The Cache screen reads `needsReset` from `checkpoint().softBlocked`, plus the rejection and overwrite journals.

Foreground wake is the scheduler's own via `KizunaSyncProcessForegroundSource` (`ProcessLifecycleOwner`). The shell wires no `LifecycleEventObserver` of its own.

Opt-in attachments exist on the Kotlin app client. This example declares no attachment column and demonstrates none of that path.

## Toolchain and layout

Committed wrapper: Gradle 8.7 with AGP 8.6.1. Kotlin 1.9.24, Java 17. Android module: compile/target SDK 35, min SDK 26. Those declarations are not evidence of a successful current APK build.

| Path | Role |
|---|---|
| [app-core/.../TodoBoard.kt](./app-core/src/main/kotlin/com/kizunasync/todo/TodoBoard.kt) | `todos` config and optional HTTP remote |
| [app-core/.../test](./app-core/src/test/kotlin/com/kizunasync/todo) | JVM/JNA host tests for board and scheduler |
| [app/.../MainActivity.kt](./app/src/main/kotlin/com/kizunasync/todo/MainActivity.kt) | Compose Board, Cache, and Settings shell |
| [settings.gradle.kts](./settings.gradle.kts) | Conditional module inclusion |
| [gradle/wrapper/gradle-wrapper.properties](./gradle/wrapper/gradle-wrapper.properties) | Gradle 8.7 pin |

## Get started

### JVM host tests

From the repository root:

```bash
cargo build -p kizunasync-ffi --features http
cd examples/todo-android
env -u ANDROID_HOME -u ANDROID_SDK_ROOT ./gradlew :app-core:test
```

Unsetting the Android SDK variables is intentional: settings then omit `:app` and `:kizunasync-android`. File-backed create/apply/reopen plus scheduler tests against a fake path monitor. Does not launch Android, contact Supabase, or exercise attachments.

### Android artifact lane

Requires Android SDK 35, NDK, `ANDROID_HOME` or `ANDROID_SDK_ROOT`, `ANDROID_NDK_HOME` (or discoverable NDK), `cargo-ndk`, and the repository Rust toolchain:

```bash
bun run cargo:aar
cd examples/todo-android
./gradlew :app:assembleDebug
```

Packaging evidence, not a published artifact. Neither command installs an APK, starts an emulator, or launches the app.

## Remote configuration

Settings accepts Supabase URL, publishable key, and session JWT from the process environment (or editable fields). No Supabase authentication flow is implemented.

Adapt the inserted `user_id` to the session subject before expecting live writes to pass the demo [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) policies.

`clientId` must be a uuid. The shell mints one into shared preferences under `kizunasync` / `clientId`. Inserted `user_id` is still `local-dev`.

Never embed a service-role key or commit credentials.

## Evidence boundary

- `:app-core:test`: JVM host evidence
- `:app:assembleDebug`: Android compile/package evidence when the SDK is present
- Emulator / physical device / live Supabase / forced termination: separate lanes

Report only the lane and scenario executed.

## Related

- [Swift and Kotlin](../../docs/getting-started/native-clients.md)
- [Playground](../../docs/getting-started/playground.md)
- [Project status](../../docs/getting-started/status.md)
- [Kotlin bindings](../../crates/kizunasync-ffi/bindings/kotlin/README.md)
