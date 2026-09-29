# D-engine-event-vocabulary: The engine event vocabulary lists only events an engine raises

<!-- kizunasync:decision
id: D-engine-event-vocabulary
status: decided
-->

**Cites:** P:protocol-is-the-product-the-corpus-is-the-arbiter

## Question

Which events may `TEngineEvent` name?

## Decision

The closed union lists only events an engine raises. Unknown members fail loudly. A future event is added when an engine raises it, in the same change as the producer, the schema, and the generated mirrors.

`RESET_REQUIRED` carries an optional `reason` from a closed set: `reset_required` when a pull or a push answered with the schema gate's `RESET_REQUIRED` signal, and `identity_changed` when the access token names a user other than the one the local store belongs to. Either reason soft-blocks sync until `reset()`. The field is omitted when the engine knows no reason, never sent as `null`, so a reader that does not know the field reads the event unchanged. The engine's checkpoint carries `soft_blocked` and `soft_block_reason` on every read: `soft_block_reason` holds the same value while the store is soft-blocked, and it is `null` while the store is not soft-blocked or when its block records no reason.

## Rejected

- **Aspirational members with no producer.** A client switching on a name that never fires is a lie in the type.
