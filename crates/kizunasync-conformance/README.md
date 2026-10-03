<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-conformance</span>
</h1>

Rust runner for the protocol corpus in `packages/protocol`. It builds a `SyncEngine` over `TranscriptRemote`, replays each non-blocked transcript, and prints `corpus: passed=<n> failed=<n> skipped_steps=<n>`. The corpus is the oracle. This crate does not fork it.

A blocked case is skipped, not counted as a pass. `skipped_steps` counts the pull steps the harness passes over inside a replayed case, the ones whose recorded request is not this client's identity pull. The binary exits `1` when any case fails and `2` when the harness itself cannot run. Private workspace member (`publish = false`).

## Get started

From the repository root:

```sh
cargo run -p kizunasync-conformance
cargo test -p kizunasync-conformance
```

`bun scripts/cargo-gate.ts conformance` is the CI wrapper.

## Related

- [kizunasync-engine](../kizunasync-engine/README.md)
- [Protocol package](../../packages/protocol/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
