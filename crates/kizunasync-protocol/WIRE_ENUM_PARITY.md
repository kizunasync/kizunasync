# Rust wire parity

`kizunasync-protocol` combines generated wire metadata with hand-written Rust message types. The distinction is important: the generated module provides closed vocabularies, required-field manifests, corpus fixtures, and parity tests; it does not generate every Rust request and response struct.

## Generated inputs and output

| Input | Generated use |
|---|---|
| `packages/protocol/tools/wire-enums.json` | Closed vocabulary names, members, and schema pointers |
| `packages/protocol/schemas/*.schema.json` | Required-field and `oneOf` manifests |
| Selected golden transcripts | Corpus response fixtures and observed vocabulary literals |
| `packages/protocol/tools/generate-rust-types.ts` | Emits `crates/kizunasync-protocol/src/generated.rs` |

`src/generated.rs` is generated and must not be hand-edited.

## Closed vocabularies

| Wire vocabulary | Rust type | Members |
|---|---|---|
| `EOp` | `Op` | `delete`, `insert`, `update` |
| `ESignalType` | `SignalType` | `CHECKPOINT_EXPIRED`, `RESET_REQUIRED` |
| `ERejectReason` | `RejectReason` | `COLUMN_DENIED`, `CONSTRAINT`, `DELETE_WINS`, `PRECONDITION`, `RLS_DENIED`, `SUPERSEDED` |
| `EVerdictKind` | `WireVerdictKind` | `applied`, `rejected` |
| `EBatchOutcome` | `WireBatchOutcome` | `aborted` |

Every variant has an explicit `serde(rename = "…")`; no enum has a catch-all variant. The generated tests pin exact casing and require every literal observed at those corpus positions to parse into its closed Rust enum.

`WireVerdictKind` and `WireBatchOutcome` carry the prefix because hand-written protocol structs already use the unprefixed domain names. The prefix distinguishes the closed scalar vocabulary from the enclosing response object.

## Runtime validation boundary

Several hand-written fields deliberately remain `String` when deserializing a response:

- `Signal.signal_type`;
- `Verdict.verdict` and `Verdict.reason`; and
- `BatchOutcome.outcome`.

The Rust engine validates those strings during reconciliation and reports `UNKNOWN_SIGNAL`, `UNKNOWN_VERDICT_REASON`, or `MALFORMED_PUSH_RESPONSE` as appropriate. It fails loud on an unrecognized member while keeping deserialization errors separate from protocol reconciliation errors.

`Mutation.op` uses the generated `Op` enum directly because the engine produces that request vocabulary from its own closed local operation set.

## Structural checks

The generated `REQ_*` constants describe required keys for the wire schemas and each `oneOf` arm. `CORPUS_NODES` maps transcript RPC paths to those manifests. The generated tests verify that every selected corpus RPC node contains a matching required-field set.

The response test then deserializes corpus responses into the hand-written `PushResponse` and `PullResponse`, serializes the typed value, deserializes it again, and compares the two typed values. That proves serde stability of the Rust representation. It does **not** prove that the re-emitted JSON is byte-identical to, or complete against, the original schema.

## Known hand-written shape gaps

The current `src/lib.rs` types are not a complete generated mirror:

- `Mutation` does not expose the schema's optional `base_hint` slot.
- `RowChange` accepts wire key `row` through an alias but stores and re-emits the field as `columns`; it also has a non-wire `deleted` field.
- `Tombstone` does not retain `deleted_at`.

`PullRequest::client_id` and `PushRequest::client_id` match their schemas: they serialize when `Some` (`skip_serializing_if = "Option::is_none"`). D-client-identity places that optional uuid on both request bodies; the JWT `session_id` claim is the D-client-identity fallback when the key is absent. Both request schemas declare the key and keep `additionalProperties: false`.

These gaps mean the crate should not be described as a fully schema-generated wire client. The generated required-field checks and response serde tests guard narrower properties until the hand-written structs are replaced or aligned.

## Freshness gates

- `bun run check:gen-rust` in `packages/protocol` regenerates `src/generated.rs` and fails on a diff.
- `cargo test -p kizunasync-protocol` runs cursor-codec, structural, vocabulary, and serde-stability tests.

The Rust conformance runner is a separate layer. It resolves the 44 executable cases of the 45 in the manifest and excludes the D-wakeup-channel wake-up payload entry because that case has no bytes.
