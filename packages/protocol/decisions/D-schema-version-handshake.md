# D-schema-version-handshake: Push carries schema_version and gates before any mutation

<!-- kizunasync:decision
id: D-schema-version-handshake
status: decided
-->

**Cites:** P:schema-version-signalling

## Question

How do pull and push tell the client that its schema is too old, and when does that check run?

## Decision

Both row-sync requests carry `schema_version`. A value below the configured minimum is gated before normal data work.

The minimum is the highest `min_schema_version` among the tables the request names: the pull's bucket tables, or the push's mutation tables. A request that names no configured table is compared with the highest minimum across the whole configuration. One stale table therefore gates the whole page or batch. A null `schema_version` is gated like a stale one.

Pull returns an empty page with `RESET_REQUIRED`. Push returns `{ "signal": { "type": "RESET_REQUIRED" } }` before any mutation, leaving the outbox and watermark untouched.

`CHECKPOINT_EXPIRED` is pull-only and means the cursor predates retained tombstone history. The engine rehydrates rather than continuing from an incomplete history.

`lifecycle/003-push-stale-schema` pins the push signal.

## Rejected

- **Omitting `schema_version` on push.** A stale writer would apply mutations against a schema the project had already raised.
- **Returning fabricated verdicts for a stale push.** The outbox would drain against a lie.
