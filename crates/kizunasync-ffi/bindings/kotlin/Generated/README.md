# Generated Kotlin UniFFI source

`uniffi/kizunasync_ffi/kizunasync_ffi.kt` is tracked output from the compiled `kizunasync-ffi` proc-macro metadata. [`kizunasync-ffi/src/lib.rs`](../../../src/lib.rs) is the exported surface; `kizunasync.udl` is not.

## What this is

Do not edit the generated Kotlin file by hand.

## Get started

From the repository root:

```bash
bun run cargo:bindgen
```

`bun run cargo:bindgen:check` verifies presence and shape only. CI regenerates and diffs the binding tree to catch stale generated code.

This source is the Kotlin half of `com.kizunasync:kizunasync` that `release-kotlin.yml` publishes, beside the Swift package from `release-swift.yml`.

## Related

- [Kotlin bindings](../README.md)
- [Multiplatform bindings](../../README.md)
