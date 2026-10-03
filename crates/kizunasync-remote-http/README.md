<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-remote-http</span>
</h1>

Live PostgREST remote and Storage/TUS transfer. `HttpProtocolRemote` posts `kizunasync.pull` and `kizunasync.push`. The TUS client creates a session, PATCHes chunks, and confirms through `kizunasync.attachment_confirm`. The publishable key travels as `apikey`. A user JWT, when set, is `Authorization: Bearer`.

`kizunasync-ffi` turns this crate on with `--features http`. JavaScript N-API keeps HTTP on the host so supabase-js can attach the session; this crate is the native path. Private workspace member (`publish = false`).

## Get started

```sh
cargo test -p kizunasync-remote-http --offline
```

Live tests in `tests/live_e2e.rs` need a reachable project and stay ignored without one.

## Related

- [kizunasync-transfer](../kizunasync-transfer/README.md)
- [kizunasync-ffi](../kizunasync-ffi/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
