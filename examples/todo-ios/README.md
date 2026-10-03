<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">example: todo-ios</span>
</h1>

Swift package plus a SwiftUI application shell for the direct Kizuna Swift app client. No JavaScript runtime at application runtime. Not a Bun/Turbo workspace.

The dependency in [Package.swift](./Package.swift) is path-local:

```swift
.package(name: "KizunaSync", path: "../../crates/kizunasync-ffi/bindings/swift")
```

Apps outside this repository add `https://github.com/kizunasync/kizunasync-swift` instead. This example uses the path package so it tracks the checkout. The root `cargo:xcframework` task creates a local, gitignored artifact beside that binding package.

## What it demonstrates

Typed `KizunaSyncClient` backed by the generated UniFFI binding and Rust engine, plus `KizunaSyncScheduler` for the automatic background sync loop. Current operations: client creation, local apply/query, sync, outbox depth, access-token replacement, and the scheduler's poll/backoff/connectivity policy with `onError`/`onHealth` reporting.

The Cache screen reads `checkpoint().softBlocked` as `needsReset`, plus the rejection journal and the overwrite journal (`overwrites()` / `dismissOverwrite(id)`).

The scheduler observes the foreground itself (`observeForeground` defaults to true). The shell wires no `scenePhase` observer of its own.

The Swift app client exposes opt-in attachments (`attachmentRoot`, `fromFile` / `resolveDownload` / `vacuum`, retry/cancel/remove). This example declares no attachment column and shows none of that path.

## Layout

| Path | Role |
|---|---|
| [Sources/TodoIosCore/TodoBoard.swift](./Sources/TodoIosCore/TodoBoard.swift) | `todos` client configuration and optional HTTP remote |
| [Tests/TodoIosCoreTests/](./Tests/TodoIosCoreTests) | macOS host tests for config, file-backed create/apply/reopen, and scheduler |
| [App/TodoIosApp.swift](./App/TodoIosApp.swift) | SwiftUI Board, Cache, and Settings shell |
| [project.yml](./project.yml) | XcodeGen source of truth |
| [Package.swift](./Package.swift) | Local SwiftPM dependency graph |

Generated `TodoIos.xcodeproj` is gitignored; regenerate it from `project.yml`.

## Get started

### macOS host tests

From the repository root:

```bash
cargo build -p kizunasync-ffi --features http
swift test --package-path examples/todo-ios
```

Creates a temporary file-backed database, queues one local insert, reopens, and asserts the row is readable. Also covers optional remote serialization and scheduler timing against injected fakes. Does not contact Supabase, run a simulator, launch the SwiftUI app, or exercise attachments.

### Simulator application

Prerequisites: macOS, Xcode, XcodeGen, the repository Rust toolchain, and the Apple Rust targets the build script installs when missing.

```bash
bun run cargo:xcframework
cd examples/todo-ios
xcodegen generate
xcodebuild -project TodoIos.xcodeproj -scheme TodoIos -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Compiles for a generic simulator destination. It does not boot a simulator or launch the app. CI runs this lane as `todo-ios-sim` in [rust-ci.yml](../../.github/workflows/rust-ci.yml).

## Remote configuration

The Settings screen accepts a Supabase URL, publishable key, and session JWT from `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`), and `SUPABASE_ACCESS_TOKEN`. The app does not implement a Supabase sign-in flow.

`clientId` must be a uuid (`CONFIG_INVALID` otherwise). The shell mints one on first launch and keeps it in `UserDefaults` under `kizunasync.clientId`. Inserted `user_id` is still the literal `local-dev`; adapt that to the session subject before expecting live writes to pass the demo [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) policies.

Never commit credentials or place a service-role key in the application.

## Evidence boundary

- `swift test`: macOS host evidence for the local UniFFI/file-backed path
- Generic-simulator `xcodebuild`: compile evidence only
- Booting and interacting with a simulator: separate runtime evidence
- Physical device / live Supabase / forced termination: separate lanes; do not infer them from a passing host test

## Related

- [Swift and Kotlin](../../docs/getting-started/native-clients.md)
- [Playground](../../docs/getting-started/playground.md)
- [Project status](../../docs/getting-started/status.md)
- [Swift bindings](../../crates/kizunasync-ffi/bindings/swift/README.md)
