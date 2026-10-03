<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">multiplatform bindings</span>
</h1>

Swift and Kotlin sources for the `kizunasync-ffi` crate. Source of the two release lanes: `release-swift.yml` attaches `KizunaSyncFfi.xcframework.zip` and renders `kizunasync/kizunasync-swift`; `release-kotlin.yml` publishes `com.kizunasync:kizunasync` to Maven Central.

## Source of truth

[`kizunasync-ffi/src/lib.rs`](../src/lib.rs) is the binding source of truth. Its UniFFI annotations expose `KizunaSyncEngine` and `KizunaSyncFfiError`. Bindgen reads the compiled library metadata in `--library` mode.

[`kizunasync-ffi/src/kizunasync.udl`](../src/kizunasync.udl) is a human-readable description, not a bindgen input. It enumerates the same 28 methods the proc-macro surface exports, `call_async` included. A kernel method outside those 28 is reached through `call` with the method name and JSON parameters; `KizunaSyncClient` on both platforms wraps the ones an app needs.

| Path | Role |
| --- | --- |
| [`swift/`](./swift) | In-repo Swift package with generated UniFFI bindings and in-process tests |
| [`swift/Generated/`](./swift/Generated) | Tracked Swift source and C ABI files |
| [`kotlin/`](./kotlin) | In-repo JVM/Android Gradle project with generated UniFFI bindings and tests |
| [`kotlin/Generated/`](./kotlin/Generated) | Tracked Kotlin source |

## Get started

From the repository root:

```bash
bun run cargo:bindgen
bun run cargo:bindgen:check
```

`cargo:bindgen` builds `kizunasync-ffi`, generates Swift and Kotlin, and copies the generated Swift header into the SPM C module. Do not edit generated files by hand.

`cargo:bindgen:check` verifies expected files exist, are non-empty, and contain `KizunaSyncEngine`. CI regenerates and diffs `crates/kizunasync-ffi/bindings`.

## Shared conformance scenarios

[`kizunasync-scenarios/scenarios.json`](../../kizunasync-scenarios/scenarios.json) is the common data and expectation oracle. Three runner lanes consume it:

| Runner lane | Backend |
| --- | --- |
| Rust integration test | In-process `KizunaSyncEngine` |
| Swift generated-binding tests | `KizunaSyncFfi` linked to `libkizunasync_ffi` |
| Kotlin generated-binding tests | `uniffi.kizunasync_ffi` through JNA |

Each language implements its own thin adapter; all three read the same steps and expected results. See the [scenarios README](../../kizunasync-scenarios/README.md).

## Native packaging

- `bun run cargo:xcframework` builds `swift/KizunaSyncFfi.xcframework` with the Rust `http` feature (iOS device, iOS Simulator, macOS). Output is gitignored; `release-swift.yml` builds it again for the GitHub Release
- `bun run cargo:aar` builds `libkizunasync_ffi.so` for arm64-v8a, armeabi-v7a, and x86_64 with `http`, then assembles two AARs: `kotlin/engine` (`com.kizunasync:kizunasync-engine`, the native library only) and `kotlin/android` (`com.kizunasync:kizunasync`, the Kotlin app client, which depends on the engine). JNI and AAR outputs are gitignored
- Plain `cargo build -p kizunasync-ffi` does not enable `http`. Omitting `remote` selects the offline `ScriptedRemote`; providing `remote` returns an error

The React Native bridge is the private in-repo [`@kizunasync/rn-uniffi`](../../../packages/rn-uniffi) workspace, published inside the `kizunasync` npm package.

## Related

- [Swift bindings](./swift/README.md)
- [Kotlin bindings](./kotlin/README.md)
- [Native clients guide](../../../docs/getting-started/native-clients.md)
- [Native packaging](../../../docs/resources/native-packaging.md)
