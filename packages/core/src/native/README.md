<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">Native NAPI library staging</span>
</h1>

Optional packaged-layout search location for the `kizunasync-napi` library that `createKizunaSync` loads in Node and Bun. It mirrors the published platform package layout so a local build resolves the same way an installed one does.

Only this README and `.gitignore` are committed here. A copied library is local or CI build output and is gitignored.

## Recognized layout

```text
src/native/<platform>-<arch>/<library>
```

| Platform/architecture | Library |
| --- | --- |
| `darwin-arm64` | `libkizunasync_napi.dylib` |
| `darwin-x64` | `libkizunasync_napi.dylib` |
| `linux-x64` | `libkizunasync_napi.so` |
| `linux-arm64` | `libkizunasync_napi.so` |
| `win32-x64` | `kizunasync_napi.dll` |

The loader in [`napi-loader.ts`](../query/napi-loader.ts) uses `process.dlopen`. It tries an explicit path, `KSYNC_NAPI_PATH`, the installed `@kizunasync/<triple>` package, this directory, then Cargo `target/debug` and `target/release`. An installed package wins over a stale local build; a staged copy here wins over `target/`.

## Get started

From the repository root:

```bash
bun run cargo:napi
bun run cargo:napi:prebuild
```

The copy script prefers the release library and falls back to debug. CI produces linux-x64, linux-arm64, darwin-arm64, and win32-x64 in this layout. `darwin-x64` is understood by the loader but sits outside that matrix.

## Published platform packages

On a `v*` tag, `release-npm.yml` builds `kizunasync-napi` for each triple in `scripts/prepare-npm-release.ts` and stages `@kizunasync/darwin-arm64`, `@kizunasync/darwin-x64`, `@kizunasync/linux-x64-gnu`, `@kizunasync/linux-arm64-gnu`, and `@kizunasync/win32-x64-msvc`. The published `kizunasync` package lists the five platform packages as optional dependencies. The registry has no version, so a local build staged here is what resolves.

## Engine selection

Selection lives in [`select-engine.ts`](../query/select-engine.ts), not in the presence of a file alone:

| Candidate | Behavior |
| --- | --- |
| Driver-carried engine transport | Rust over that transport (browser / `@kizunasync/web`) |
| Linked UniFFI handle | Rust through UniFFI (React Native) |
| N-API addon | Rust through N-API (Node / Bun) |
| None | Throw `ENGINE_UNAVAILABLE`, naming the package and why each path tried failed |

A `databasePath` of `null` asks the engine for a private in-memory store. The Rust core is the only engine; a missing artifact throws `ENGINE_UNAVAILABLE`.

For a file-backed driver, Rust opens the path the driver reports. A reported `:memory:` value passes the capability check, but the native engine opens its own private in-memory database, so reads through the caller's original driver do not see that store.

## Related

- [`@kizunasync/core`](../../README.md)
- [Architecture](../../../../docs/resources/architecture.md)
