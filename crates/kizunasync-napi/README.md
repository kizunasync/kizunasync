<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-napi</span>
</h1>

N-API addon `@kizunasync/core` loads on Node and Bun. The engine is `Send` and not `Sync` (its store owns a `rusqlite::Connection`), so it lives on one dedicated thread and every call is a message that thread runs as its own task. A query or a write answers while a pull or push awaits the promise the JS remote returns. JavaScript never blocks on SQLite.

HTTP stays on the host. The addon calls back into the TypeScript `IProtocolRemote` so supabase-js can attach the session. Each call pins the embedder clock it carries while that call runs, so calls that interleave stamp their own time. Private workspace member (`publish = false`).

## Get started

```sh
cargo test -p kizunasync-napi
```

`bun run cargo:napi` builds the cdylib the loader expects. Platform triples and the optional-dependency table live in `scripts/prepare-npm-release.ts`.

## Related

- [kizunasync-engine](../kizunasync-engine/README.md)
- [@kizunasync/core native notes](../../packages/core/src/native/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
