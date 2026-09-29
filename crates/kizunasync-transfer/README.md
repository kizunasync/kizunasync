<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-transfer</span>
</h1>

The upload and download port the attachment queue drives. A small object goes in one shot. A larger one uses a [TUS](https://tus.io/protocols/resumable-upload) session in 6 MiB chunks, which is the Supabase Storage default. The trait does not speak HTTP. `kizunasync-remote-http` implements it against Storage. Tests inject `FakeTransfer`.

SHA-256 of the bytes is part of confirm. A download that cannot verify that digest fails. Private workspace member (`publish = false`).

## Get started

```sh
cargo test -p kizunasync-transfer
```

## Related

- [kizunasync-remote-http](../kizunasync-remote-http/README.md)
- [kizunasync-engine](../kizunasync-engine/README.md)
- [Repository layout](../../docs/resources/repository-layout.md)
