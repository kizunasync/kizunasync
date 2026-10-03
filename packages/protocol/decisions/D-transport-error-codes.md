# D-transport-error-codes: Portable transient and permanent transport error codes

<!-- kizunasync:decision
id: D-transport-error-codes
status: open
-->

**Cites:** P:verdict-completeness-transforms-and-conflict-rejection, P:outbox-and-serial-in-flight

## Question

Push and pull require retryable-versus-permanent behavior. What transport-independent error-code vocabulary does a conformant remote use?

## What is not settled

The portable code list. Transcript `transport-error` and `drop-ack` steps remain harness controls, not protocol bytes.

## What is already safe to rely on

Only an explicit `retryable: false` consumes the engine's dead-letter budget, and only `sync()` keeps it: a single `pushOnce` call re-raises every failure and always sends the whole slice. The budget charges a permanent failure to the slice that was sent, never to the queued entries behind it. A lone unbatched write or an atomic batch owns its failure, and five consecutive permanent failures against it dead-letter it with the reason `PERMANENT_TRANSPORT`. Retryable network, timeout, authentication, 5xx, and unclassified failures do not consume the budget.

An unbatched slice of several writes does not say which of them the server refused, so it is never charged. `sync()` sends it again at once: halved when the remote code is `KZP02` (the batch is over `max_batch_size`), with the halved size kept until the outbox drains, and as the head alone for any other code. Each retry is shorter, so the retries end with one write that owns its failure. `KZP02` on an atomic batch dead-letters the whole batch at once, with the server's message as the reason, because a batch that cannot be split never fits.

`sync()` still pulls after a failed push, so a refused write never holds remote rows back, unless the failure is retryable: the network or the session would fail the pull the same way. The call then reports the push failure.

The two Supabase adapters, `createRpcRemote` in JavaScript and `HttpProtocolRemote` in the native `kizunasync-remote-http` crate, classify the same way. SQLSTATE classes 22, 23, and 42 are permanent, except `42501` (`insufficient_privilege`), which stays retryable: the pack answers a row that RLS refuses with an `RLS_DENIED` verdict, so an HTTP `42501` means a missing `GRANT EXECUTE`, the `anon` role, or a missing JWT, never a refused row. Exact `P0001` and `0A000` are permanent, and so are the pack's policy codes `KZP01` (a write to a pull-only table), `KZP02` (a batch over `max_batch_size`), and `KZL01` (a pull of a bucketed table without its bucket column), because a replay of the same request fails the same way. `KZP03` (`require_atomic`) stays retryable: the client sends ordinary writes as non-atomic, so a permanent `KZP03` would empty the outbox. Other, missing, and PostgREST or auth codes remain retryable. That adapter policy is tested. It is not a portable contract for other transports.
