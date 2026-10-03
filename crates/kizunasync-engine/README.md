<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-engine</span>
</h1>

`SyncEngine` is the kernel every client runs. Apply writes the local row and the outbox. Pull pages through a fenced checkpoint. Push sends a slice and reconciles verdicts. Query reads the store through `kizunasync-query`. The attachment queue claims, uploads, downloads, and vacuums when a `Transfer` is attached.

N-API, UniFFI, and wasm are thin bridges over this crate. They do not implement a second engine. `ScriptedRemote` is the offline remote the tests and the conformance harness use. A production UniFFI create without a `remote` object is `CONFIG_INVALID`; see [kizunasync-ffi](../kizunasync-ffi/README.md). Private workspace member (`publish = false`).

`sync()` is the only path that consumes the [dead-letter](../../docs/resources/glossary.md#dead-letter) budget. `push_once` and `pull_once` stay byte-identical for the [conformance corpus](../../docs/resources/glossary.md#conformance-corpus).

## Get started

```sh
cargo test -p kizunasync-engine
```

## Related

- [kizunasync-store](../kizunasync-store/README.md)
- [kizunasync-ffi](../kizunasync-ffi/README.md), [kizunasync-napi](../kizunasync-napi/README.md), [kizunasync-wasm](../kizunasync-wasm/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
