# @kizunasync/protocol

Private machine specification and test oracle for the Kizuna row-sync contract. Not a runtime dependency of app clients.

| Path | Role |
|---|---|
| `schemas/` | JSON Schema 2020-12 for wire messages and the corpus |
| `transcripts/` | Golden fixtures |
| `cases/manifest.json` | Case registry |
| `decisions/` | Live wire-contract register |
| `harness/` | Structural invariants |
| `executor/` | TypeScript reference server and runner |
| `properties/` | TLA+ registry and models |
| `spec/` | Generated TypeScript wire types and the cursor codec |
| `tools/` | Code generation, decision-index, and citation checks |

Four sources are authoritative, each inside its own scope. The JSON Schemas and the selected transcripts fix corpus bytes. `decisions/index.json` fixes decision disposition. The SQL pack migration fixes deployed database behavior. The Rust engine fixes client reconciliation. Where two of them differ, this document names the difference at the point it appears.

## Decision state

| Status | Meaning |
|---|---|
| `decided` | Nineteen records. Spelling is fixed |
| `open` | `D-dedup-storage-model`, `D-base-hint`, `D-wakeup-channel`, `D-transport-error-codes` |
| `superseded` | None. Reserved so an id still resolves after a later record replaces it |

See [Protocol decisions](../../docs/resources/protocol-decisions.md) and `decisions/README.md`.

## Checks

```sh
bun test
bun run check:cites
bun run check:decisions
bun run check:gen
bun run check:gen-rust
```
