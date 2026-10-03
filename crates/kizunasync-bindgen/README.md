<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-bindgen</span>
</h1>

Workspace wrapper around `uniffi::uniffi_bindgen_main`, plus the `engine-errors` generator that writes `packages/protocol/spec/engine-errors.json` from the kernel catalog. CI calls this binary so bindgen version stays pinned to UniFFI 0.31.x. Generated Swift and Kotlin under `crates/kizunasync-ffi/bindings/**/Generated/` are output. Do not edit them.

Private workspace member (`publish = false`). Nothing from this crate reaches any channel.

## Get started

From the repository root, after `cargo build -p kizunasync-ffi`:

```sh
cargo run -p kizunasync-bindgen -- generate \
  --library target/debug/libkizunasync_ffi.dylib \
  --language swift --out-dir crates/kizunasync-ffi/bindings/swift/Generated

cargo run -p kizunasync-bindgen -- engine-errors
```

`bun run cargo:bindgen:check` is the CI check that the generated tree matches.

## Related

- [kizunasync-ffi](../kizunasync-ffi/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
