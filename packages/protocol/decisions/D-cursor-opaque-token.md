# D-cursor-opaque-token: The cursor is an opaque text token

<!-- kizunasync:decision
id: D-cursor-opaque-token
status: decided
-->

**Cites:** P:cursor-monotonicity-rebase-and-atomic-checkpoints, SQL:pull-request-shape, DR:cursor-and-sequence-decimal-string-grammar

## Question

How does the pull cursor cross the wire, and what may a client do with it?

## Decision

The cursor is opaque text. `"0"` bootstraps. The client persists the server token and sends it back without parsing it. Sequences are decimal strings. Drivers must not coerce either value through a JSON number.

The canonical grammar the corpus, the Rust codec, and the SQL encoder share is:

```text
bootstrap checkpoint:     0
checkpoint:               <high-water>
checkpoint with holes:    <high-water>~<h1>.<h2>...
continuation:             <start>:<high-water>
continuation with holes:  <start>:<high-water>~<h1>.<h2>...
```

`<start>` is a decimal: the high-water of the checkpoint the transfer started from, `0` when it started from the bootstrap. The high-water and the holes mean the same thing in every form: the holes are positive, strictly ascending, and strictly below the high-water. The start and the high-water have no ordering constraint, because a page that delivered only holes leaves the position below the start. Every codec accepts every form and rejects anything else, including an empty start, a signed start, or a second colon.

A continuation page, the page cut by the limit with `has_more: true` (`D-page-cap-and-checkpoint-boundary`), returns `<S>:<seq of its last entry>`. S is the incoming token's start when it has one, otherwise the incoming token's high-water, and the reference oracle adds the holes below that seq. The page that holds every remaining entry returns a checkpoint token, the horizon's high-water with the oracle's holes when it has them, and a checkpoint token never carries a start. A signal response echoes the incoming cursor.

`CHECKPOINT_EXPIRED` checks the checkpoint a transfer started from, never the page position. Let E be the token's start when it carries one, otherwise its high-water: the server answers `CHECKPOINT_EXPIRED` exactly when E is above 0 and below the reap horizon. A transfer that started from `"0"`, a bootstrap or a rehydration, therefore always runs to completion. A transfer that started from a checkpoint expires as soon as the reap horizon passes that checkpoint, even in the middle of the transfer, because reaped tombstones above its position could be missing. Delivery reads only the high-water and the holes.

The SQL pack emits no holes, because it numbers changes at commit (`D-visibility-horizon`). The reference oracle emits holes when a visibility gap is still open. Every form is a valid token. A client that inspects the interior of the string is outside the contract.

## Rejected

- **A bigint cursor.** PostgREST coerces bigint to a JSON number, which cannot represent the full int64 range and is not a round-trippable token.
- **Per-bucket sub-cursors.** One global sequence already orders the page. A second cursor per bucket would split the checkpoint.
- **A request field that carries the durable checkpoint.** It splits the resume point in two: the cursor would carry the position, and a second field the checkpoint that position belongs to.
- **Expiry checked on the page position.** A bootstrap whose first page ends below the reap horizon can never finish: its second request expires, the client restarts from `"0"`, and the same first page comes back.
