<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-protocol</span>
</h1>

Rust types for the Kizuna wire: mutations, pull and push envelopes, cursors, verdicts, and the closed unions the engine matches on. `packages/protocol` owns the JSON schemas and the TypeScript oracle. This crate is the same shape in Rust, so a value that crosses FFI deserializes into one type, not a second protocol. Private workspace member (`publish = false`).

## Get started

```sh
cargo test -p kizunasync-protocol
```

## Related

- [kizunasync-engine](../kizunasync-engine/README.md), which consumes these types
- [Protocol package](../../packages/protocol/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
