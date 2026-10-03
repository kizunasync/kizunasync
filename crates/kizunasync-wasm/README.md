<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-wasm</span>
</h1>

The same kernel, compiled to WebAssembly and running in the `@kizunasync/web` worker. The crate body sits behind `#![cfg(target_arch = "wasm32")]`. A native `--workspace` build therefore compiles an empty lib and does not pull in the browser stack. `call` takes `(method, paramsJson)`. It resolves with the same `{ok, value}` / `{ok:false, error}` envelope the other bridges return. Calls run side by side: a local call answers while a network call awaits the remote, and the engine runs the calls that pull or push one at a time.

Each call pins the embedder clock it carries while that call runs, so calls that interleave stamp their own time. Private workspace member (`publish = false`).

## Get started

```sh
bun run cargo:wasm
cargo build -p kizunasync-wasm --target wasm32-unknown-unknown --profile release-size
```

`bun run cargo:wasm-check` is the CI form of that build.

## Related

- [kizunasync-engine](../kizunasync-engine/README.md)
- [@kizunasync/web](../../packages/web/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
