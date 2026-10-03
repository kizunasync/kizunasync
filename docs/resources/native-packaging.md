---
title: Native packaging
description: Regenerate UniFFI bindings and build the XCFramework, AAR, and React Native module from a checkout.
status: alpha
docType: how-to
audience: contributor
---

# Native packaging

Regenerate the [UniFFI](https://mozilla.github.io/uniffi-rs/) bindings and build the Swift, Kotlin, and [React Native](https://reactnative.dev) artifacts from a Kizuna Sync checkout, in the order a maintainer performs them: regenerate, test the host bindings, build the artifacts, then publish a tagged release. Every command runs against the workspace itself. If you are adding Kizuna to an application instead, follow the [Swift](../reference/swift/introduction.md) and [Kotlin](../reference/kotlin/introduction.md) references. Those pages name the public coordinates a tagged release will install. No SPM or Maven package exists, as [Project status](../getting-started/status.md#current-limitations) records.

## Before you begin

- Clone [kizunasync/kizunasync](https://github.com/kizunasync/kizunasync) and set it up as [Contribute](./contribute.md#1-build-and-test) describes.
- Install [Bun](https://bun.sh/docs/installation) `1.4.2`, the version the root `packageManager` field pins.
- Install a [Rust](https://www.rust-lang.org/tools/install) toolchain matching the workspace `rust-version`.
- Install Xcode for the Swift and iOS lanes, or the Android SDK and NDK for the Kotlin and AAR lanes. A lane you skip needs neither.
- Install the [wasm](https://grokipedia.com/page/WebAssembly) toolchain for the npm lane only: a clang with a WebAssembly target exported as `CC_wasm32_unknown_unknown`, binaryen, and the pinned `wasm-bindgen` CLI, all recorded in [CI and CD](../operations/ci-cd.md#toolchain-recorded-by-the-repository). The npm rehearsal builds the browser glue, and its staging step stops without it.

## Repository surfaces

Each artifact has one source directory and one script. [Repository layout](./repository-layout.md#crates) places these paths in the wider tree.

| Surface | Path | In this repository |
|---|---|---|
| UniFFI crate and C ABI | `crates/kizunasync-ffi` | Built as a workspace crate |
| Swift generated module and app client | `crates/kizunasync-ffi/bindings/swift` | Host tests, and the source of the `kizunasync/kizunasync-swift` package through `scripts/sync-swift-package.sh` |
| Kotlin generated module and app client | `crates/kizunasync-ffi/bindings/kotlin` | JVM and [JNA](https://grokipedia.com/page/Java_Native_Access) host tests when the Android SDK variables are unset, and the source of the `com.kizunasync:kizunasync` artifact |
| iOS packaging | `scripts/build-xcframework.sh` | Script and workflow lane; no published XCFramework |
| Android packaging | `scripts/build-android-aar.sh` | Script and workflow lane; wrapper 8.7 satisfies AGP 8.6.1 |
| React Native loader | `packages/rn-uniffi` | UniFFI 0.31 with the ubrn code generator |

## 1. Regenerate the bindings

Run both commands after any change to an [FFI](https://grokipedia.com/page/Foreign_function_interface) definition:

```bash
bun run cargo:bindgen
bun run cargo:bindgen:check
```

Generated files are committed, and hand-editing one is never the fix: change the definition and regenerate.

You should now see `cargo:bindgen:check` finish without reporting drift. That is the same gate `rust-ci.yml` runs as its `bindings shape check` step, so a changed FFI surface cannot land without its Swift and Kotlin mirror.

## 2. Run the host tests

Both suites build the local dynamic library first and then exercise the generated module and the typed app client against it.

### Swift host tests

```bash
cargo build -p kizunasync-ffi --features http
swift test --package-path crates/kizunasync-ffi/bindings/swift
```

### Kotlin host tests

```bash
cargo build -p kizunasync-ffi --features http
env -u ANDROID_HOME -u ANDROID_SDK_ROOT ./crates/kizunasync-ffi/bindings/kotlin/gradlew -p crates/kizunasync-ffi/bindings/kotlin test
```

Unsetting the two SDK variables keeps [Gradle](https://gradle.org) on the JVM-only modules, which is the lane that runs without an Android installation. With the SDK present, wrapper 8.7 satisfies AGP 8.6.1 and the Android modules configure as well.

You should now see both suites pass against the freshly built library, which is the evidence that the generated bindings match the current FFI definitions on both languages.

## 3. Build the native artifacts

Each artifact builds from the same crate. The [XCFramework](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle) and the AAR land in gitignored output directories; the React Native generated TypeScript and C++ are committed after the first generate, so review them in the diff.

### XCFramework

```bash
bun run cargo:xcframework
```

The script builds the HTTP-enabled native library for three slices (iOS device, iOS Simulator arm64 and x86_64 joined with `lipo`, and macOS arm64 and x86_64 joined with `lipo`), then places the XCFramework in the local Swift package.

`Package.swift` compares each linked slice's header against the freshly generated one, and it stops with a message naming this command when they differ. The check catches only a header change. A signature-only edit that adds or removes no exported symbol leaves the header equal. It moves only the checksum the generated Swift asserts at run time, so nothing catches it until the mismatched checksum fails a call. Swift Package Manager also caches manifest evaluation on the manifest's own contents, so the check runs only on a cold cache. A clean checkout, a wiped `.build`, or `swift build --manifest-cache none` gives you one.

Rebuild the XCFramework with this command after every `cargo:bindgen`, not only after a change the header would show.

### Android AAR

```bash
bun run cargo:aar
```

The script cross-compiles `kizunasync-ffi` for arm64-v8a, armeabi-v7a, and x86_64, then assembles two AARs: the engine AAR carries those libraries and nothing else, and the client AAR carries the Kotlin client and depends on the engine AAR. It needs the Android SDK, and it fails rather than producing a partial archive when an ABI is missing.

### React Native Turbo Module

From `packages/rn-uniffi`:

```bash
bun run ubrn:ios
bun run ubrn:android
```

Rebuild the consumer app after generation so that the [Turbo Module](https://reactnative.dev/docs/turbo-native-modules-introduction) links.

Until that rebuild happens, the app client that [`createKizunaSync`](../reference/javascript/initializing.md) returns finds no native module on its first engine call, and that call fails with `ENGINE_UNAVAILABLE`, naming the artifact to install. There is no fallback engine, so no engine call succeeds until the module links. [Engine selection](../getting-started/status.md#engine-selection) carries the rule.

You should now see three outputs: `KizunaSyncFfi.xcframework` inside the local Swift package, an engine AAR carrying `libkizunasync_ffi.so` for all three ABIs beside the client AAR, and a consumer app that loads the Turbo Module after its native rebuild.

## 4. Publish a tagged release

Pushing a `v<X.Y.Z>` tag drives all three release lanes. Rehearse each one locally first, because none of the rehearsals touches a registry.

### Swift package release

`release-swift.yml` builds the XCFramework, attaches `KizunaSyncFfi.xcframework.zip` and its checksum to the GitHub Release, renders `kizunasync/kizunasync-swift` with `scripts/sync-swift-package.sh`, and tags that repository `<X.Y.Z>`. The renderer fills `scripts/swift-package/Package.swift.tmpl` and `scripts/swift-package/README.md.tmpl` with the version and checksum, and it copies the repository's `LICENSE` alongside them. The two template files in this checkout are therefore never the ones an app installs. The rendered package exports two products: `KizunaSync`, the app client, and `KizunaSyncEngine`, the XCFramework's binary target alone, which the React Native module inside `kizunasync` links.

Render the tree locally with `bun run cargo:swift-package <dir> --version <X.Y.Z> --checksum <sha256>`, or pass `--local-xcframework crates/kizunasync-ffi/bindings/swift/KizunaSyncFfi.xcframework` to check a local build instead of a release artifact.

### Kotlin release

`release-kotlin.yml` builds two AARs. `com.kizunasync:kizunasync-engine:<X.Y.Z>` carries only the native library for the same three ABIs, and `com.kizunasync:kizunasync:<X.Y.Z>` carries the Kotlin client and depends on it. The workflow publishes both to Maven Central and attaches `kizunasync-engine-<X.Y.Z>.aar` and `kizunasync-<X.Y.Z>.aar` to the GitHub Release. Check them locally with `crates/kizunasync-ffi/bindings/kotlin/gradlew -p crates/kizunasync-ffi/bindings/kotlin :engine:publishToMavenLocal :android:publishToMavenLocal -PkizunasyncVersion=<X.Y.Z>`.

### npm release

`release.yml` starts `release-npm.yml` after the Swift and Kotlin releases, because the React Native module inside `kizunasync` resolves its engine from `KizunaSyncEngine` and `com.kizunasync:kizunasync-engine` at the version it publishes. `release-npm.yml` builds the [N-API](https://nodejs.org/api/n-api.html) library and the `kizunasync` binary for five platform triples, then builds the browser glue with `bun run cargo:wasm`. It stages the six packages with `bun scripts/prepare-npm-release.ts <X.Y.Z> --binaries dist/binaries`, publishes the five platform packages and then `kizunasync`, in the order given by `dist/npm/publish-order.txt`, and attaches the `kizunasync-<X.Y.Z>-<triple>` binaries to the GitHub Release. The publish step installs npm 11.20.0 and authenticates with GitHub OIDC.

Staging turns each triple into one `@kizunasync/<triple>` package that carries the `kizunasync` binary under `bin/` and the N-API library at the package root, with `os` and `cpu` set. It assembles `kizunasync` from `packages/kizunasync` and the private workspaces `core`, `supabase`, `web`, `react`, `vue`, `expo`, and `rn-uniffi`, so the package holds the CLI shim, the SQL pack, one entry point per subpath, the React Native module, and the browser engine under `dist/web/wasm/`. Two of the four wasm files are generated rather than tracked, so the staging script refuses to continue when they are absent instead of producing a package whose worker cannot instantiate the engine.

Run `bun run cargo:wasm` first, then stage it locally with `bun run release:npm:prepare <X.Y.Z> --smoke` to inspect the published shape without building the platform binaries.

You should now be able to complete all three rehearsals without publishing anything: a rendered Swift package tree, a `publishToMavenLocal` artifact in your local Maven repository, and a staged npm tree with its `publish-order.txt`.

## What CI proves

A CI artifact proves that a build completed on that runner. It is not a supported consumer download, a physical-device result, or a package release, and [CI and CD](../operations/ci-cd.md#release-workflows) says the same about each release lane. [Project status](../getting-started/status.md#surface-matrix) records the distribution and evidence for each native surface, and [Release contract](./roadmap.md#release-contract) tracks the work that would change that.

## Next steps

- [Contribute](./contribute.md)
- [Repository layout](./repository-layout.md)
- [CI and CD](../operations/ci-cd.md)
- [Swift: Introduction](../reference/swift/introduction.md)
- [Kotlin: Introduction](../reference/kotlin/introduction.md)
