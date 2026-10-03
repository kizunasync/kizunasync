<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-scenarios</span>
</h1>

Shared binding-scenario fixtures live here next to the crates that consume them. This directory has no `Cargo.toml`. `crates/kizunasync-ffi/tests/scenarios.rs`, the Swift `ScenarioRunner`, and the Kotlin scenario runner all load `scenarios.json` as data.

The protocol corpus under `packages/protocol/` remains the oracle for wire behaviour.

## Step operations

Each step names an `op` and carries the fields that operation reads. A step may also declare `expect_error: true` with an `expect_code`; the runner then asserts that the engine refused the call with that catalog code.

| `op` | Reads | Asserts |
| --- | --- | --- |
| `create` | `tables` | the engine takes the config |
| `apply` | `table`, `pk`, `mutation_op`, `mutation_id`, `columns`, `transforms`, `precondition` | the write lands, or the refusal |
| `apply_where` | `table`, `mutation_op`, `filters`, `columns`, `transforms` | the write lands, or the refusal |
| `query` | `table`, `plan` | `expect_count`, `expect_null`, `expect_single_title`, `expect_column_values` |
| `outbox_depth` | | `expect_depth` |
| `rejections` | `include_dismissed` | `expect_count` |
| `checkpoint` | | `expect_cursor` |
| `seed_checkpoint` | `cursor` | the cursor is adopted |
| `set_bucket` | `params` | the parameters are filled, or the refusal |
| `sync` | | the round trip completes |
| `attachment_put` | `attachment` (request verbatim) | the queue row exists |
| `attachment_patch` | `reference`, `patch` | the columns are written |
| `attachment_pending` | `direction` | `expect_count` |
| `attachment_fail_next` | `reference` | `expect_value`: the claim's own answer |
| `attachment_status` | `reference` | `expect_status` (subset of status keys), `expect_null` |
| `attachment_retry` | `reference` | `expect_value` |
| `attachment_cancel` | `reference` | `expect_value` |
| `attachment_remove` | `reference` | `expect_value`, `expect_null` |

`attachment_fail_next` has no method behind it. Runners attach no transfer port, so a scenario cannot make real bytes fail. The operation records one failed attempt the way a host queue would: claim the row, then write the attempt and failure through `attachment_claim` and `attachment_patch`. Its answer is the claim's, which lets a scenario pin the attempt where the transfer budget stops claiming.

## Related

- [Multiplatform bindings](../kizunasync-ffi/bindings/README.md)
- [`@kizunasync/protocol`](../../packages/protocol/README.md)
