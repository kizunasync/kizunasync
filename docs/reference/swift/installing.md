---
title: Installing
description: Add the Swift packages to an iOS or macOS app.
status: alpha
docType: reference
library: swift
pageKind: installing
audience: app-developer
---

# Swift: Installing

The `KizunaSync` package carries the client, the query helpers, and the host scheduler, and wraps the Rust engine through the UniFFI-generated `KizunaSyncFfi` module. The app adds supabase-swift, Supabase's own Swift client, beside it.

## Add the Swift packages

In Xcode choose File → Add Package Dependencies and enter `https://github.com/kizunasync/kizunasync-swift`, then add `https://github.com/supabase/supabase-swift.git` the same way, or declare both dependencies in `Package.swift`:

```swift
// Package.swift
dependencies: [
  .package(url: "https://github.com/kizunasync/kizunasync-swift", exact: "0.2.6-alpha.2"),
  .package(url: "https://github.com/supabase/supabase-swift.git", from: "2.0.0"),
],
targets: [
  .target(
    name: "App",
    dependencies: [
      .product(name: "KizunaSync", package: "kizunasync-swift"),
      .product(name: "Supabase", package: "supabase-swift"),
    ]
  ),
]
```

The `KizunaSync` package requires iOS 16 or macOS 13 and links the prebuilt `KizunaSyncFfi` [XCFramework](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle), which carries three slices (iOS device, iOS Simulator, and macOS), so the app target needs no Rust toolchain.

Apps depend on the `KizunaSync` product. The package also exports `KizunaSyncEngine`, which holds that XCFramework and nothing else, for the React Native module `@kizunasync/rn-uniffi`. `KizunaSync` links the engine itself, so an app that uses it does not add `KizunaSyncEngine`.

The `Supabase` product of [supabase-swift](https://supabase.com/docs/reference/swift/installing) is the client `TodoApp/Supabase.swift` creates. The app signs in with it, and the scheduler's `refreshSession` reads the access token from its session.

## Import the module

```swift
// TodoApp/TodoSync.swift (excerpt)
import KizunaSync
```

The target should now resolve the [types](./types.md) this reference documents, starting with `KizunaSyncClient`, `KizunaSyncClientConfig`, `KizunaSyncQuery`, and `KizunaSyncScheduler`. The next step is [Initializing](./initializing.md), which opens the local database and points the client at the [Supabase](https://supabase.com) project.

## Related reference

- [Introduction](./introduction.md)
- [Initializing](./initializing.md)
- [Kotlin: Installing](../kotlin/installing.md)
- [JavaScript: Installing](../javascript/installing.md)
