<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/rn-uniffi</span>
</h1>

A [UniFFI](https://mozilla.github.io/uniffi-rs/) Turbo Module for `crates/kizunasync-ffi`. `uniffi-bindgen-react-native` 0.31.0-6 generates it against UniFFI 0.31.2.

The package carries the npm name `@kizunasync/rn-uniffi` and version `0.2.6-alpha.1`. It reaches an application as a dependency of `@kizunasync/expo` from this repository. Its loader API and generated bridge are not a stable public application API.

This package stays separate from `@kizunasync/expo` because ubrn names the ObjC/Java module from the npm package suffix. Hosting it under `@kizunasync/expo` produced `Expo.mm` and collided with the Expo SDK.

## Status

The generated module is committed and exports `KizunaSyncEngine`. `isUniffiNativeAvailable`, `tryLoadUniffiNativeEngine`, `loadUniffiNativeEngine`, and `requireUniffiNativeEngine` probe or require that constructor at runtime. A Bun process has no React Native Turbo Module, so the loader answers `not_linked` there. Availability comes from an autolinked native build.

`createKizunaSync` uses this engine on React Native when the Turbo Module is registered in the binary. Otherwise it throws `ENGINE_UNAVAILABLE` naming this package and the native rebuild required. Installing the package is not enough: rebuild natively. That build links a prebuilt engine library from one of the sources under [Engine library](#engine-library), so the app needs no Rust toolchain.

The `simulator-smoke` job in `.github/workflows/rust-ci.yml` builds this module, prebuilds `examples/todo-expo`, launches it on an iOS simulator, and asserts that the running app wrote `rust` to `Documents/kizunasync-engine.txt`. That is the one lane where an installed application exercises the module. Unit tests here cover the loader and the probe. There is no React Native Android runtime lane.

## Engine library

`RnUniffi.podspec` links the engine on iOS from the first source that applies:

1. `build/KizunaSyncFfi.xcframework`, which `bun run ubrn:ios` writes in this repository, is vendored as is.
2. When `KIZUNASYNC_SWIFT_PACKAGE_PATH` holds an absolute path to a tree that `bun run cargo:swift-package <dir> --version <X.Y.Z> --local-xcframework <xcframework>` rendered, the podspec links the `KizunaSyncEngine` product of that tree. A maintainer sets it to check a release before it ships. The first source wins whenever its directory exists, so that check runs in a checkout without it.
3. Otherwise the podspec links the `KizunaSyncEngine` product of `https://github.com/kizunasync/kizunasync-swift` at exactly this package's version.

The second and third sources go through React Native's `spm_dependency`, so the podspec raises an error when `pod install` runs outside a React Native Podfile. The podspec declares iOS 16.0, the floor of the Swift package. `src/podspec.test.ts` evaluates the podspec for each source with Ruby and checks that floor against `scripts/swift-package/ios-floor.sh`.

On Android, `android/build.gradle` packages `android/src/main/jniLibs/<abi>/libkizunasync_ffi.so` when `bun run ubrn:android` has written it. Otherwise it depends on `com.kizunasync:kizunasync-engine` at this package's version, links against the library inside that AAR, and leaves packaging to the dependency, so each ABI carries the library once. Both paths cover `arm64-v8a`, `armeabi-v7a`, and `x86_64`, limited to the architectures the app builds.

`release.yml` publishes the Swift package and the Maven artifact before npm, so the engine version this package names exists on both registries by the time the package reaches npm.

## Exports

`src/index.ts` re-exports thirteen names from `src/spec.ts`. None is a stable public application API. Applications call `createKizunaSync`.

| Export | Kind | What it is |
| --- | --- | --- |
| `isUniffiNativeAvailable` | function | `true` when the generated module registers `KizunaSyncEngine` |
| `tryLoadUniffiNativeEngine` | function | Loads the engine, or `not_linked` / `invalid_module` |
| `loadUniffiNativeEngine` | function | Engine or `null` |
| `requireUniffiNativeEngine` | function | Engine or a thrown `Error` naming the rebuild |
| `describeUniffiLoadFailure` | function | The actionable message for a `not_linked` / `invalid_module` reason |
| `isUniffiHandle` | function | Type guard for the six-method handle shape |
| `TKizunaSyncNativeEngine` | type | `create`, `call`, `callAsync`, `subscribe`, `unsubscribe`, `shutdown` |
| `TKizunaSyncNativeEngineCtor` | type | `new () => TKizunaSyncNativeEngine` |
| `TKizunaSyncNativeEngineModule` | type | `{ KizunaSyncEngine: TKizunaSyncNativeEngineCtor }` |
| `TKizunaSyncEventObserver` | type | `onEvent(event)` handler for `subscribe` |
| `TKizunaSyncEngineEvent` | type | Engine event mirroring generated `FfiEngineEvent` |
| `TUniffiLoadFailureReason` | type | `'not_linked' \| 'invalid_module'` |
| `TUniffiLoadResult` | type | `{ ok: true; engine } \| { ok: false; reason }` |

## Get started

From this directory:

```bash
bun run ubrn:ios       # rust + xcframework + generate
bun run ubrn:android   # rust + jniLibs + generate
```

`ubrn:ios` exports `IPHONEOS_DEPLOYMENT_TARGET` from `scripts/swift-package/ios-floor.sh`, so the engine it builds targets the Swift package's iOS floor instead of the newest SDK.

Two ubrn 0.31.0-6 details shape this package:

`ubrn.config.yaml` points `turboModule.ts` at `src/generated`, and `package.json` sets `codegenConfig.jsSrcsDir` to match. The generator renders the installer import as `./NativeRnUniffi` beside the entrypoint while writing that file into `turboModule.ts`, so the directories must be the same. Point them apart and Metro fails on every platform.

The ubrn Android template writes a `package` attribute into `AndroidManifest.xml`, and Android Gradle Plugin 8 requires it absent. `ubrn.config.yaml` lists the manifest under `noOverwrite`, so an `--and-generate` run leaves the committed manifest alone. The build files ubrn would otherwise rewrite, `RnUniffi.podspec`, `android/build.gradle`, and `android/CMakeLists.txt`, sit under `noOverwrite` as well, because they choose where the engine library comes from.

The repository commits `src/generated/**`, `ios/`, and `android/` as generated output, apart from the four `noOverwrite` files, which are maintained by hand. The `simulator-smoke` job regenerates them and runs `git diff --exit-code` over `src/generated`. `build/KizunaSyncFfi.xcframework` and `android/src/main/jniLibs` are compiled libraries and do not belong in a commit. When the app builds, it runs React Native codegen for `NativeRnUniffi` from `codegenConfig` in `package.json`, so the package ships none of that codegen output.

## Pins

Do not bump UniFFI to 0.32. Ubrn 0.31.0-6 generates for 0.31.

## Related

- [`@kizunasync/expo`](../expo/README.md)
- [Expo guide](../../docs/getting-started/expo.md)
- [Native packaging](../../docs/resources/native-packaging.md)
