# Turso browser clock patch

`turso-core/` is the published `turso_core` **0.8.3** crate, from upstream tag
[`v0.8.3`](https://github.com/tursodatabase/turso/tree/v0.8.3), commit
`607bff9fd0e547a25a97b3bf06e83bcc5d99d53c`. Its MIT license is included.

The only code change is in `io/clock.rs`: on `wasm32-unknown-unknown`, use
`web_time::{Instant, SystemTime, UNIX_EPOCH}`. `Cargo.toml` adds the corresponding
target dependency. Other targets continue using `std::time`.

Turso creates an internal `MemoryIO` temporary database when starting explicit
transactions. It uses `DefaultClock` even when the main database has a custom
`IO` implementation. Upstream's `std::time::Instant::now()` panics on browser
WASM. Supplying a custom main-database clock therefore does not fix that path.
Browser conformance, explicit transactions, and migration tests exercise it.

Keep the full upstream crate so Cargo builds remain reproducible and offline.
Remove this override when a released Turso version supports browser clocks for
internal temporary databases and passes the same conformance suite. Do not edit
the local Cargo registry or introduce a build-time download to apply the fix.

Kizuna uses the public `turso` Rust API and a worker-local OPFS/IndexedDB `IO`
adapter. It does not use Turso Cloud sync or the browser SDK's shared-memory
worker, and does not require COOP/COEP headers.
