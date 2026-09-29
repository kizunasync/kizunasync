---
title: Installing
description: Add the Maven artifact to an Android app.
status: alpha
docType: reference
library: kotlin
pageKind: installing
audience: app-developer
---

# Kotlin: Installing

The `com.kizunasync:kizunasync` artifact carries the client, the query helpers, and the host scheduler, and wraps the Rust engine through the UniFFI-generated `uniffi.kizunasync_ffi` bindings.

## Add the Maven dependency

In the module `build.gradle.kts`:

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("com.kizunasync:kizunasync:0.2.6-alpha.1")
}
```

The artifact is an Android AAR whose POM depends on `com.kizunasync:kizunasync-engine` at the same version. The engine AAR carries the native `kizunasync_ffi` library for three ABIs (`arm64-v8a`, `armeabi-v7a`, `x86_64`). Gradle resolves the engine AAR as a transitive dependency, so the app module declares only the client and needs no Rust toolchain. The client requires minSdk 26 and JDK 17. Its methods are suspending functions, so the module also needs `kotlinx-coroutines`.

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
