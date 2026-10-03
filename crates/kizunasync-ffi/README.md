<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-ffi</span>
</h1>

UniFFI bridge over `kizunasync-engine`. Swift and Kotlin `KizunaSyncClient` wrap the generated `KizunaSyncEngine`. They are hosts, not a second kernel. `create(config_json)` takes `EngineConfig` plus `database_path`, `remote` (`url` and `publishable_key`), and optional `attachment_root`. A library build that omits `remote` returns `CONFIG_INVALID`. Unit tests still default to `ScriptedRemote` so the harness stays offline.

`call(method, params_json)` is the same JSON envelope N-API and wasm answer; `call_async` answers the same envelope without blocking the caller, so a host that must keep its thread free awaits it instead. Typed `apply` requires `op` and honors `batch_id`. Each call pins the embedder clock it carries while that call runs, so calls that interleave stamp their own time. A created engine runs on its own actor thread, the same dedicated-thread design N-API uses: every call is a job that thread runs, and the reply travels back over a channel. Swift dispatches a blocking `call` on a dedicated concurrent `DispatchQueue` with checked continuations, so it never occupies the cooperative pool; Kotlin dispatches it on `Dispatchers.IO`. Private workspace member (`publish = false`).

Generated Swift and Kotlin under `bindings/**/Generated/` are bindgen output. Do not edit them.

## Get started

```sh
cargo test -p kizunasync-ffi
cargo build -p kizunasync-ffi --features http
```

`--features http` links [kizunasync-remote-http](../kizunasync-remote-http/README.md). Native packaging turns that feature on.

## Related

- [kizunasync-engine](../kizunasync-engine/README.md)
- [Multiplatform bindings](./bindings/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
