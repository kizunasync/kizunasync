<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">Swift bindings</span>
</h1>

Source of the `KizunaSync` Swift package. `release-swift.yml` attaches `KizunaSyncFfi.xcframework.zip` to the GitHub Release and renders `https://github.com/kizunasync/kizunasync-swift` from this tree. App developers add that package URL, not this path.

## Products

| Product | Contents | Runtime |
| --- | --- | --- |
| `KizunaSync` | Typed app client (`KizunaSyncClient` and related types) | `KizunaSyncFfi` |
| `KizunaSyncFfi` | Tracked UniFFI-generated Swift plus the generated C module | `libkizunasync_ffi` |
| `KizunaSyncScenarioSupport` | Test-only shared scenario runner | In-process |

`Package.swift` always declares `KizunaSync`. It adds `KizunaSyncFfi` and its tests when `Generated/kizunasync_ffi.swift` exists. The package links a local `KizunaSyncFfi.xcframework` when present, otherwise the Cargo-built library under `target/debug`.

A present framework wins over the Cargo build for every lane, including host tests. `Package.swift` compares each slice's header against `Generated/kizunasync_ffiFFI.h` and stops with a message naming `bun run cargo:xcframework` when they differ. Rebuild the framework after every bindgen, or delete the directory to link the Cargo library instead.

Generation authority is the proc-macro surface in [`kizunasync-ffi/src/lib.rs`](../../src/lib.rs), not `kizunasync.udl`. Run `bun run cargo:bindgen` from the repository root after changing that surface.

## Public types

`KizunaSyncClient`, `KizunaSyncTable`, `KizunaSyncSelectBuilder`, `KizunaSyncWriteBuilder`, `KizunaSyncQuery`, `KizunaSyncOp`, `KizunaSyncTextSearchType`, `KizunaSyncConflictMode`, `KizunaSyncClientConfig`, `KizunaSyncTableConfig`, `KizunaSyncRemoteConfig`, `KizunaSyncAttachmentSpec`, `KizunaSyncOverwrite`, `KizunaSyncError`, `KizunaSyncInspector` and snapshot/verdict types, `KizunaSyncScheduler`, sync-health types, `KizunaSyncPathMonitor`, `KizunaSyncNetworkPathMonitor`, `KizunaSyncForegroundSource`, `KizunaSyncNotificationForegroundSource`, `KizunaSyncRealtimeWakeup`, and `KizunaSyncRealtimeSubscription`. Generated engine types are re-exported as `KizunaSyncEngineEvent`, `KizunaSyncAttachmentStatus`, `KizunaSyncRejection`, `KizunaSyncCheckpoint`, and `KizunaSyncFromFileResult`.

## Configuration

`KizunaSyncClientConfig` carries `clientId`, `schemaVersion`, `tables`, `databasePath`, `remote`, `attachmentRoot`, `defaultLimit`, and `attachmentAttempts`. A key left at the engine default stays off the wire, so this client and a JavaScript one from the same declaration send the same bytes.

`clientId` is the device identity the server registers. `kizunasync._clients.client_id` is a uuid column, so `create` refuses anything else with `CONFIG_INVALID`. Passing none mints one.

`KizunaSyncTableConfig.conflictMode` is `.arrival` or `.hlc`. An `hlc` table stamps every queued mutation; an `arrival` table carries none. `select().includeDeleted()` brings back rows a table's `softDeleteColumn` marks.

## Wake sources

`KizunaSyncScheduler` polls on its own timer and gates on `KizunaSyncPathMonitor`.

`observeForeground` defaults to true, so the scheduler registers for did-become-active through `KizunaSyncNotificationForegroundSource`. Pass `observeForeground: false` or your own `foregroundSource` to change that.

`realtime` is the doorbell the app's own Supabase channel rings. Supabase Realtime is a WebSocket outside the Rust engine, so the bindings take a port rather than a dependency. Copy an adapter over `supabase-swift` in the app; `KizunaSync` declares no Supabase dependency. A message is only a hint.

Pass `needsReset` reading `client.checkpoint().softBlocked` so the scheduler publishes it on every health snapshot.

## Kernel methods beyond the typed surface

`KizunaSyncClient` reaches five kernel methods through JSON-RPC `call`: `attachmentRetry`, `attachmentCancel`, `attachmentRemove`, `overwrites`, and `dismissOverwrite`. Refusals map to `KizunaSyncError.engine` with the kernel's own code.

## Tests

```bash
bun run test:swift
# or:
cargo build -p kizunasync-ffi --features http
swift test --package-path crates/kizunasync-ffi/bindings/swift
```

`bun run test:swift` runs `scripts/check-xcframework-fresh.sh` first so a stale framework never passes a green suite.

| Target | Backend | Coverage |
| --- | --- | --- |
| `KizunaSyncFfiTests` | Generated `KizunaSyncFfi` linked to `libkizunasync_ffi` | Shared scenarios, builders, inspector, scheduler, typed error mapping |
| `KizunaSyncTests` | None | Structural validation of the shared scenario oracle |

Both consume `crates/kizunasync-scenarios/scenarios.json`. A UniFFI checksum failure means generated sources and the loaded library disagree.

## Native artifact

`KizunaSyncClient` is the typed async wrapper over the generated engine. Every blocking FFI call runs on a dedicated concurrent `DispatchQueue`, bridged to `async` through checked continuations, so `sync()` does not run on the caller's actor and never waits behind the cooperative thread pool. A remote requires `kizunasync-ffi` built with the Rust `http` feature, which the host-test build above enables.

On macOS, `bun run cargo:xcframework` builds three slices with `http` and writes `KizunaSyncFfi.xcframework` beside `Package.swift`. That directory is gitignored. CI defines framework and iOS simulator-example jobs; no current gate proves execution on a physical device.

## Related

- [Multiplatform bindings](../README.md)
- [Native clients guide](../../../../docs/getting-started/native-clients.md)
- [`examples/todo-ios`](../../../../examples/todo-ios)
