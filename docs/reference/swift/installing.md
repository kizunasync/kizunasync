---
title: Installing
description: Add the Swift package to an iOS or macOS app.
status: alpha
docType: reference
library: swift
pageKind: installing
audience: app-developer
---

# Swift: Installing

The `KizunaSync` package carries the client, the query helpers, and the host scheduler, and wraps the Rust engine through the UniFFI-generated `KizunaSyncFfi` module.

## Add the Swift package

In Xcode choose File → Add Package Dependencies and enter `https://github.com/kizunasync/kizunasync-swift`, or declare the dependency in `Package.swift`:

```swift
// Package.swift
dependencies: [
  .package(url: "https://github.com/kizunasync/kizunasync-swift", exact: "0.2.6-alpha.1"),
],
targets: [
  .target(
    name: "App",
    dependencies: [.product(name: "KizunaSync", package: "kizunasync-swift")]
  ),
]
```

The package requires iOS 16 or macOS 13 and links the prebuilt `KizunaSyncFfi` [XCFramework](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle), which carries three slices (iOS device, iOS Simulator, and macOS), so the app target needs no Rust toolchain.

Apps depend on the `KizunaSync` product. The package also exports `KizunaSyncEngine`, which holds that XCFramework and nothing else, for the React Native module `@kizunasync/rn-uniffi`. `KizunaSync` links the engine itself, so an app that uses it does not add `KizunaSyncEngine`.

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
