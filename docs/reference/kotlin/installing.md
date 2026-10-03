---
title: Installing
description: Add the Maven artifacts to an Android app.
status: alpha
docType: reference
library: kotlin
pageKind: installing
audience: app-developer
---

# Kotlin: Installing

The `com.kizunasync:kizunasync` artifact carries the client, the query helpers, and the host scheduler, and wraps the Rust engine through the UniFFI-generated `uniffi.kizunasync_ffi` bindings. The app adds supabase-kt, Supabase's own Kotlin client, beside it.

## Add the Maven dependencies

In the module `build.gradle.kts`:

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("com.kizunasync:kizunasync:0.2.6-alpha.2")
    implementation(platform("io.github.jan-tennert.supabase:bom:3.8.0"))
    implementation("io.github.jan-tennert.supabase:auth-kt")
    implementation("io.github.jan-tennert.supabase:realtime-kt")
    implementation("io.ktor:ktor-client-okhttp:3.4.0")
}
```

The artifact is an Android AAR whose POM depends on `com.kizunasync:kizunasync-engine` at the same version. The engine AAR carries the native `kizunasync_ffi` library for three ABIs (`arm64-v8a`, `armeabi-v7a`, `x86_64`). Gradle resolves the engine AAR as a transitive dependency, so the app module declares no engine line and needs no Rust toolchain. The client requires minSdk 26 and JDK 17. Its methods are suspending functions. A Compose app already has `kotlinx-coroutines-android`, because `androidx.activity:activity-compose` exposes it through its Compose runtime and lifecycle dependencies, so the module needs no line for it.

The other lines add supabase-kt, which Supabase documents under [Kotlin: Installing](https://supabase.com/docs/reference/kotlin/installing), and the HTTP engine it runs on:

| Dependency | Why the app needs it |
|---|---|
| `io.github.jan-tennert.supabase:bom` | supabase-kt's bill of materials. It sets one version for every supabase-kt module, so the `auth-kt` and `realtime-kt` lines name none. |
| `io.github.jan-tennert.supabase:auth-kt` | The `Auth` plugin `Supabase.kt` installs. The app signs in with it, and the scheduler's `refreshSession` reads the access token from its session. |
| `io.github.jan-tennert.supabase:realtime-kt` | The `Realtime` plugin the [Realtime wake](./scheduler.md#realtime-wake) adapter subscribes through, installed in `Supabase.kt` beside `Auth`. An app without that doorbell leaves out both the line and the plugin. |
| `io.ktor:ktor-client-okhttp` | The HTTP engine supabase-kt runs on, one of the [Ktor client engines](https://ktor.io/docs/client-engines.html). OkHttp also opens the WebSocket that Realtime needs. |

## Import the client

```kotlin
// app/src/main/kotlin/com/example/todo/TodoSync.kt (excerpt)
import com.kizunasync.kizunasync.KizunaSyncClient
```

The module should now resolve the [types](./types.md) this reference documents, starting with `KizunaSyncClient`, `KizunaSyncClientConfig`, `KizunaSyncQuery`, and `KizunaSyncScheduler` from `com.kizunasync.kizunasync`. The next step is [Initializing](./initializing.md), which opens the local database and points the client at the [Supabase](https://supabase.com) project.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Swift: Installing](../swift/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
