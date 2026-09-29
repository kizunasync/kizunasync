<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-store</span>
</h1>

SQLite store the kernel opens through `rusqlite`. Rows, outbox, tombstones, attachments, rejections, dead letters, the overwrite journal, and the ids of the last 1000 pushed writes the server applied live in `_kizunasync_*` tables on the same connection. Optimistic `apply` writes the local row and enqueues the mutation, and refuses a mutation id that is already queued. `overlay_pending` replays the queued outbox, oldest first, onto the rows a pull, a push reconcile, or a dead letter replaced, without enqueueing a second time. `reset` wipes those tables, including `_kizunasync_overwrites` and `_kizunasync_pushed`, reseeds bootstrap meta, keeps the origin HLC, and stores the client identity its caller minted.

Native builds bundle SQLite. The wasm32 target takes its C library from `sqlite-wasm-rs`. Private workspace member (`publish = false`).

## Get started

```sh
cargo test -p kizunasync-store
```

## Related

- [kizunasync-engine](../kizunasync-engine/README.md)
- [kizunasync-protocol](../kizunasync-protocol/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
