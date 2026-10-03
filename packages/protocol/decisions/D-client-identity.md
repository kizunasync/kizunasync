# D-client-identity: Client identity is an optional client_id with a JWT fallback

<!-- kizunasync:decision
id: D-client-identity
status: decided
-->

**Cites:** P:session-guarantees-and-exactly-once-effect, SQL:clients-registry

## Question

How does the server know which device is pulling or pushing?

## Decision

Both `pull` and `push` may carry an optional `client_id`. When the key is absent and client registration is enabled, the SQL wrapper reads the JWT `session_id` claim. Identity never travels as a required JSON field.

A `client_id` already owned by another user is refused. Registration upserts `_clients` keyed by `coalesce(p_client_id, p_session)`.

The engine keeps the `client_id` it sends in its local store. The configured `client_id` seeds a store that keeps none, and from then on the kept one wins on every open, so a restart registers under the same identity whatever id the host passes.

A client that resets its local store mints a new `client_id` and keeps it with the wipe, so a restart after the reset keeps the new identity; the previous row stays with its user until `prune_clients` reaps it.

## Rejected

- **Requiring `client_id` on every call.** Apps that have only a user JWT would have to mint a device id they do not have.
- **Putting the user id on the wire as a substitute.** Row ownership is RLS. The device id is for the verdict watermark and fencing, not for authorization.
