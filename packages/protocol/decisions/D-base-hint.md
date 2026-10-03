# D-base-hint: base_hint shape and semantics

<!-- kizunasync:decision
id: D-base-hint
status: open
-->

**Cites:** P:mutations-and-column-masked-conflict-resolution

## Question

`base_hint` is named in the mutation field set. What shape does it have, and what may a server or client do with the value?

## What is not settled

Shape, comparison rules, and whether a missing hint is different from a present empty one. No transcript, reference-server branch, SQL path, or client reconciliation rule uses the value.

## What is already safe to rely on

The mutation schema keeps an unconstrained optional slot. The local SQLite store has a `base_hint_json` column so a client can persist a value if one arrives. Neither the slot nor the column carries semantics. The `kizunaOpen` annotation on the schema property points here. Consumers must not infer meaning from the placeholder being permitted.
