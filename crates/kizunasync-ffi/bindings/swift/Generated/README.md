# Generated Swift UniFFI sources

Tracked files generated from the compiled `kizunasync-ffi` proc-macro metadata. [`kizunasync-ffi/src/lib.rs`](../../../src/lib.rs) is the exported surface; `kizunasync.udl` is not.

## What this is

Do not edit `kizunasync_ffi.swift`, `kizunasync_ffiFFI.h`, or `kizunasync_ffiFFI.modulemap` by hand.

## Get started

From the repository root:

```bash
bun run cargo:bindgen
```

That command also copies the header into the Swift package's `Sources/kizunasync_ffiFFI/include/` directory.

`bun run cargo:bindgen:check` verifies expected file shape only. CI proves freshness by regenerating and checking the binding tree for a diff.

These files feed the `KizunaSync` Swift package that `release-swift.yml` renders as `kizunasync/kizunasync-swift`, beside the Kotlin artifact from `release-kotlin.yml`.

## Related

- [Swift bindings](../README.md)
- [Multiplatform bindings](../../README.md)
