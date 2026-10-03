# Protocol decisions

This directory is the live wire-contract register. Each file is one choice: what the bytes are, and which alternatives it rejects. `index.json` is generated from the files; do not edit it by hand.

Statuses are `decided`, `open`, and `superseded`. `open` means no conformant bytes may be inferred for the missing choice. A record that is `open` must say what is already safe to rely on. A case that cannot run without the missing bytes carries `blocked_on` on a `file: null` manifest entry. Executable cases do not carry `open_decisions`.

Substantive changes go through an RFC-labeled PR that touches `packages/protocol/` and updates the corpus in the same PR. See GOVERNANCE.md section 5.

| Id | Status | Title |
|---|---|---|
| `D-page-cap-and-checkpoint-boundary` | decided | Pull page cap, limit accounting, and the checkpoint boundary |
| `D-signal-excludes-page-data` | decided | A signal response carries no page data |
| `D-cursor-opaque-token` | decided | The cursor is an opaque text token |
| `D-visibility-horizon` | decided | Fencing is the Postgres visibility horizon |
| `D-verdict-correlation` | decided | Verdicts correlate by request order and by `mutation_id` |
| `D-rejection-reasons` | decided | Rejection reasons are a closed six-literal union |
| `D-atomic-batch-abort` | decided | An atomic batch aborts with one outcome |
| `D-schema-version-handshake` | decided | Push carries `schema_version` and gates before any mutation |
| `D-client-identity` | decided | Client identity is an optional `client_id` with a JWT fallback |
| `D-field-transforms` | decided | Field transforms are an optional `transforms` slot on `update` |
| `D-conflict-journal-visibility` | decided | Conflict-journal visibility is an optional `conflicts` array |
| `D-outbox-rebase` | decided | The client rebases its outbox instead of holding back the checkpoint |
| `D-attachments-outside-row-sync` | decided | Attachment bytes stay outside row-sync |
| `D-engine-event-vocabulary` | decided | The engine event vocabulary lists only events an engine raises |
| `D-corpus-soft-delete-and-refusal` | decided | Corpus grammar: soft-delete column and expected local refusal |
| `D-pull-bucket-required` | decided | A bucketed table refuses an unscoped pull with `KZL01` |
| `D-bucket-move-out` | decided | A row that leaves a bucket leaves that bucket a tombstone |
| `D-tombstone-delivery` | decided | A tombstone reaches only a caller who received a live row of its bucket |
| `D-verdict-ownership` | decided | A replayed mutation id answers only the user who pushed it |
| `D-row-key` | decided | A row is keyed by its table's primary key, sent as canonical text |
| `D-dedup-storage-model` | open | Dedup watermark versus per-mutation verdict storage |
| `D-base-hint` | open | `base_hint` shape and semantics |
| `D-wakeup-channel` | open | Wake-up channel and payload |
| `D-transport-error-codes` | open | Portable transient and permanent transport error codes |

To add a record, copy any file above, use a new `D-<kebab-slug>` that matches the filename, and regenerate `index.json` with `bun tools/build-decisions-index.ts`.
