// GENERATED: do not edit; regenerate with bun packages/protocol/tools/generate-rust-types.ts

//! Closed wire vocabularies and schema structure mirrored from `packages/protocol`.
//!
//! Sources of truth: `tools/wire-enums.json` (the vocabularies), `schemas/*.schema.json`
//! (the required-field manifests) and `transcripts/**` (the golden corpus the tests below
//! replay). Drift is caught by `check:gen-rust` in `@kizunasync/protocol`, which regenerates
//! this file and fails on a diff.

use serde::{Deserialize, Serialize};

// MARK: - Wire scalars

/// Wire scalar `rowKey`, carried as a JSON string.
///
/// Provenance: `common.schema.json#/$defs/rowKey`.
pub type RowKey = String;

// MARK: - Wire vocabularies

/// Closed wire vocabulary `EOp`.
///
/// Provenance: `common.schema.json#/$defs/mutation/properties/op/enum`.
// wire-enum: EOp
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Op {
    /// Wire member `delete` of `EOp`.
    #[serde(rename = "delete")]
    Delete,
    /// Wire member `insert` of `EOp`.
    #[serde(rename = "insert")]
    Insert,
    /// Wire member `update` of `EOp`.
    #[serde(rename = "update")]
    Update,
}

/// Closed wire vocabulary `ESignalType`.
///
/// Provenance: `common.schema.json#/$defs/signal/oneOf/1/properties/type/enum`.
// wire-enum: ESignalType
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignalType {
    /// Wire member `CHECKPOINT_EXPIRED` of `ESignalType`.
    #[serde(rename = "CHECKPOINT_EXPIRED")]
    CheckpointExpired,
    /// Wire member `RESET_REQUIRED` of `ESignalType`.
    #[serde(rename = "RESET_REQUIRED")]
    ResetRequired,
}

/// Closed wire vocabulary `ERejectReason`.
///
/// Provenance: `common.schema.json#/$defs/verdict/oneOf/1/properties/reason/enum`.
/// Provenance: `push-response.schema.json#/oneOf/1/properties/batch/properties/reason/enum`.
// wire-enum: ERejectReason
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RejectReason {
    /// Wire member `COLUMN_DENIED` of `ERejectReason`.
    #[serde(rename = "COLUMN_DENIED")]
    ColumnDenied,
    /// Wire member `CONSTRAINT` of `ERejectReason`.
    #[serde(rename = "CONSTRAINT")]
    Constraint,
    /// Wire member `DELETE_WINS` of `ERejectReason`.
    #[serde(rename = "DELETE_WINS")]
    DeleteWins,
    /// Wire member `PRECONDITION` of `ERejectReason`.
    #[serde(rename = "PRECONDITION")]
    Precondition,
    /// Wire member `RLS_DENIED` of `ERejectReason`.
    #[serde(rename = "RLS_DENIED")]
    RlsDenied,
    /// Wire member `SUPERSEDED` of `ERejectReason`.
    #[serde(rename = "SUPERSEDED")]
    Superseded,
}

/// Closed wire vocabulary `EVerdictKind`.
///
/// Provenance: `common.schema.json#/$defs/verdict/oneOf/0/properties/verdict/const`.
/// Provenance: `common.schema.json#/$defs/verdict/oneOf/1/properties/verdict/const`.
// wire-enum: EVerdictKind
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireVerdictKind {
    /// Wire member `applied` of `EVerdictKind`.
    #[serde(rename = "applied")]
    Applied,
    /// Wire member `rejected` of `EVerdictKind`.
    #[serde(rename = "rejected")]
    Rejected,
}

/// Closed wire vocabulary `EBatchOutcome`.
///
/// Provenance: `push-response.schema.json#/oneOf/1/properties/batch/properties/outcome/const`.
// wire-enum: EBatchOutcome
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WireBatchOutcome {
    /// Wire member `aborted` of `EBatchOutcome`.
    #[serde(rename = "aborted")]
    Aborted,
}

/// Closed wire vocabulary `EConflictMode`.
///
/// Provenance: `pull-response.schema.json#/properties/conflicts/items/properties/conflict_mode/enum`.
/// Provenance: `transcript.schema.json#/$defs/context/properties/server/properties/tables/additionalProperties/properties/conflict_mode/enum`.
// wire-enum: EConflictMode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConflictMode {
    /// Wire member `arrival` of `EConflictMode`.
    #[serde(rename = "arrival")]
    Arrival,
    /// Wire member `hlc` of `EConflictMode`.
    #[serde(rename = "hlc")]
    Hlc,
}

// MARK: - Schema required-field manifests

/// Required properties of `common.schema.json#/$defs/mutation`.
pub const REQ_COMMON_MUTATION: &[&str] = &["columns", "mutation_id", "op", "pk", "table"];

/// Required properties of `common.schema.json#/$defs/row_change`.
pub const REQ_COMMON_ROW_CHANGE: &[&str] = &["pk", "row", "seq", "table"];

/// Required properties of `common.schema.json#/$defs/signal/oneOf/1`.
pub const REQ_COMMON_SIGNAL_ONEOF_1: &[&str] = &["type"];

/// Required properties of `common.schema.json#/$defs/tombstone`.
pub const REQ_COMMON_TOMBSTONE: &[&str] = &["deleted_at", "pk", "seq", "table"];

/// Required properties of `common.schema.json#/$defs/transform/oneOf/0`.
pub const REQ_COMMON_TRANSFORM_ONEOF_0: &[&str] = &["by", "op"];

/// Required properties of `common.schema.json#/$defs/transform/oneOf/1`.
pub const REQ_COMMON_TRANSFORM_ONEOF_1: &[&str] = &["op", "values"];

/// Required properties of `common.schema.json#/$defs/verdict/oneOf/0`.
pub const REQ_COMMON_VERDICT_ONEOF_0: &[&str] = &["mutation_id", "verdict"];

/// Required properties of `common.schema.json#/$defs/verdict/oneOf/1`.
pub const REQ_COMMON_VERDICT_ONEOF_1: &[&str] = &["mutation_id", "reason", "server_row", "verdict"];

/// Required properties of `pull-request.schema.json#`.
pub const REQ_PULL_REQUEST: &[&str] = &["buckets", "cursor", "schema_version"];

/// Required properties of `pull-request.schema.json#/properties/buckets/items`.
pub const REQ_PULL_REQUEST_BUCKETS_ITEMS: &[&str] = &["params", "table"];

/// Required properties of `pull-response.schema.json#`.
pub const REQ_PULL_RESPONSE: &[&str] = &["cursor", "has_more", "rows", "signal", "tombstones"];

/// Required properties of `pull-response.schema.json#/properties/conflicts/items`.
pub const REQ_PULL_RESPONSE_CONFLICTS_ITEMS: &[&str] = &[
    "column_name",
    "conflict_mode",
    "loser_value",
    "pk",
    "table",
    "winner_mutation_id",
    "winner_seq",
];

/// Required properties of `push-request.schema.json#`.
pub const REQ_PUSH_REQUEST: &[&str] = &["batch", "last_mutation_id", "schema_version"];

/// Required properties of `push-request.schema.json#/properties/batch`.
pub const REQ_PUSH_REQUEST_BATCH: &[&str] = &["atomic", "mutations"];

/// Required properties of `push-response.schema.json#/oneOf/0`.
pub const REQ_PUSH_RESPONSE_ONEOF_0: &[&str] = &["verdicts"];

/// Required properties of `push-response.schema.json#/oneOf/1`.
pub const REQ_PUSH_RESPONSE_ONEOF_1: &[&str] = &["batch"];

/// Required properties of `push-response.schema.json#/oneOf/1/properties/batch`.
pub const REQ_PUSH_RESPONSE_ONEOF_1_BATCH: &[&str] =
    &["offender_mutation_id", "outcome", "reason", "server_row"];

/// Required properties of `push-response.schema.json#/oneOf/2`.
pub const REQ_PUSH_RESPONSE_ONEOF_2: &[&str] = &["signal"];

/// Required properties of `push-response.schema.json#/oneOf/2/properties/signal`.
pub const REQ_PUSH_RESPONSE_ONEOF_2_SIGNAL: &[&str] = &["type"];

/// Required properties per `oneOf` arm of `common.schema.json#/$defs/signal`.
pub const ARMS_COMMON_SIGNAL: &[&[&str]] = &[REQ_COMMON_SIGNAL_ONEOF_1];

/// Required properties per `oneOf` arm of `common.schema.json#/$defs/transform`.
pub const ARMS_COMMON_TRANSFORM: &[&[&str]] =
    &[REQ_COMMON_TRANSFORM_ONEOF_0, REQ_COMMON_TRANSFORM_ONEOF_1];

/// Required properties per `oneOf` arm of `common.schema.json#/$defs/verdict`.
pub const ARMS_COMMON_VERDICT: &[&[&str]] =
    &[REQ_COMMON_VERDICT_ONEOF_0, REQ_COMMON_VERDICT_ONEOF_1];

/// Required properties per `oneOf` arm of `push-response.schema.json#`.
pub const ARMS_PUSH_RESPONSE: &[&[&str]] = &[
    REQ_PUSH_RESPONSE_ONEOF_0,
    REQ_PUSH_RESPONSE_ONEOF_1,
    REQ_PUSH_RESPONSE_ONEOF_2,
];

// MARK: - Corpus structure

/// One structural checkpoint inside an rpc step of the golden transcript corpus.
pub struct CorpusNode {
    /// The rpc the step invokes: `pull` or `push`.
    pub rpc: &'static str,
    /// Slash path inside the step object; `*` walks an array.
    pub path: &'static str,
    /// The schema file that owns the node.
    pub schema: &'static str,
    /// JSON pointer of the node inside that schema.
    pub pointer: &'static str,
    /// Required keys, empty when the node is a `oneOf`.
    pub required: &'static [&'static str],
    /// Required keys per `oneOf` arm, empty when the node is a plain object.
    pub arms: &'static [&'static [&'static str]],
}

/// Where each wire schema node appears inside an rpc step.
pub const CORPUS_NODES: &[CorpusNode] = &[
    CorpusNode {
        rpc: "pull",
        path: "request",
        schema: "pull-request.schema.json",
        pointer: "",
        required: REQ_PULL_REQUEST,
        arms: &[],
    },
    CorpusNode {
        rpc: "pull",
        path: "request/buckets/*",
        schema: "pull-request.schema.json",
        pointer: "/properties/buckets/items",
        required: REQ_PULL_REQUEST_BUCKETS_ITEMS,
        arms: &[],
    },
    CorpusNode {
        rpc: "pull",
        path: "response",
        schema: "pull-response.schema.json",
        pointer: "",
        required: REQ_PULL_RESPONSE,
        arms: &[],
    },
    CorpusNode {
        rpc: "pull",
        path: "response/conflicts/*",
        schema: "pull-response.schema.json",
        pointer: "/properties/conflicts/items",
        required: REQ_PULL_RESPONSE_CONFLICTS_ITEMS,
        arms: &[],
    },
    CorpusNode {
        rpc: "pull",
        path: "response/rows/*",
        schema: "common.schema.json",
        pointer: "/$defs/row_change",
        required: REQ_COMMON_ROW_CHANGE,
        arms: &[],
    },
    CorpusNode {
        rpc: "pull",
        path: "response/signal",
        schema: "common.schema.json",
        pointer: "/$defs/signal",
        required: &[],
        arms: ARMS_COMMON_SIGNAL,
    },
    CorpusNode {
        rpc: "pull",
        path: "response/tombstones/*",
        schema: "common.schema.json",
        pointer: "/$defs/tombstone",
        required: REQ_COMMON_TOMBSTONE,
        arms: &[],
    },
    CorpusNode {
        rpc: "push",
        path: "request",
        schema: "push-request.schema.json",
        pointer: "",
        required: REQ_PUSH_REQUEST,
        arms: &[],
    },
    CorpusNode {
        rpc: "push",
        path: "request/batch",
        schema: "push-request.schema.json",
        pointer: "/properties/batch",
        required: REQ_PUSH_REQUEST_BATCH,
        arms: &[],
    },
    CorpusNode {
        rpc: "push",
        path: "request/batch/mutations/*",
        schema: "common.schema.json",
        pointer: "/$defs/mutation",
        required: REQ_COMMON_MUTATION,
        arms: &[],
    },
    CorpusNode {
        rpc: "push",
        path: "response",
        schema: "push-response.schema.json",
        pointer: "",
        required: &[],
        arms: ARMS_PUSH_RESPONSE,
    },
    CorpusNode {
        rpc: "push",
        path: "response/batch",
        schema: "push-response.schema.json",
        pointer: "/oneOf/1/properties/batch",
        required: REQ_PUSH_RESPONSE_ONEOF_1_BATCH,
        arms: &[],
    },
    CorpusNode {
        rpc: "push",
        path: "response/signal",
        schema: "push-response.schema.json",
        pointer: "/oneOf/2/properties/signal",
        required: REQ_PUSH_RESPONSE_ONEOF_2_SIGNAL,
        arms: &[],
    },
    CorpusNode {
        rpc: "push",
        path: "response/verdicts/*",
        schema: "common.schema.json",
        pointer: "/$defs/verdict",
        required: &[],
        arms: ARMS_COMMON_VERDICT,
    },
];

// MARK: - Vocabulary observed in the corpus

/// `EOp` literals the golden corpus carries; every one must parse into `Op`.
pub const CORPUS_OP: &[&str] = &["delete", "insert", "update"];

/// `ESignalType` literals the golden corpus carries; every one must parse into `SignalType`.
pub const CORPUS_SIGNAL_TYPE: &[&str] = &["CHECKPOINT_EXPIRED", "RESET_REQUIRED"];

/// `ERejectReason` literals the golden corpus carries; every one must parse into `RejectReason`.
pub const CORPUS_REJECT_REASON: &[&str] = &[
    "CONSTRAINT",
    "DELETE_WINS",
    "PRECONDITION",
    "RLS_DENIED",
    "SUPERSEDED",
];

/// `EVerdictKind` literals the golden corpus carries; every one must parse into `WireVerdictKind`.
pub const CORPUS_VERDICT_KIND: &[&str] = &["applied", "rejected"];

/// `EBatchOutcome` literals the golden corpus carries; every one must parse into `WireBatchOutcome`.
pub const CORPUS_BATCH_OUTCOME: &[&str] = &["aborted"];

/// `EConflictMode` literals the golden corpus carries; every one must parse into `ConflictMode`.
pub const CORPUS_CONFLICT_MODE: &[&str] = &["arrival"];

#[cfg(test)]
// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::{PullResponse, PushResponse};
    use serde_json::Value;

    /// The golden corpus, embedded so a moved or renamed transcript breaks the build.
    const TRANSCRIPTS: &[(&str, &str)] = &[
        (
            "array/001-concurrent-union.json",
            include_str!("../../../packages/protocol/transcripts/array/001-concurrent-union.json"),
        ),
        (
            "array/002-union-then-remove.json",
            include_str!("../../../packages/protocol/transcripts/array/002-union-then-remove.json"),
        ),
        (
            "array/003-union-then-assign-lww.json",
            include_str!(
                "../../../packages/protocol/transcripts/array/003-union-then-assign-lww.json"
            ),
        ),
        (
            "conflict/001-different-columns-merge.json",
            include_str!(
                "../../../packages/protocol/transcripts/conflict/001-different-columns-merge.json"
            ),
        ),
        (
            "conflict/002-same-column-arrival-wins.json",
            include_str!(
                "../../../packages/protocol/transcripts/conflict/002-same-column-arrival-wins.json"
            ),
        ),
        (
            "conflict/003-hlc-origin-order.json",
            include_str!(
                "../../../packages/protocol/transcripts/conflict/003-hlc-origin-order.json"
            ),
        ),
        (
            "conflict/004-journal-on-winning-pull.json",
            include_str!(
                "../../../packages/protocol/transcripts/conflict/004-journal-on-winning-pull.json"
            ),
        ),
        (
            "fencing/001-late-commit-delivered.json",
            include_str!(
                "../../../packages/protocol/transcripts/fencing/001-late-commit-delivered.json"
            ),
        ),
        (
            "fencing/002-overlap-redelivery-idempotent.json",
            include_str!(
                "../../../packages/protocol/transcripts/fencing/002-overlap-redelivery-idempotent.json"
            ),
        ),
        (
            "fencing/003-two-holes-both-delivered.json",
            include_str!(
                "../../../packages/protocol/transcripts/fencing/003-two-holes-both-delivered.json"
            ),
        ),
        (
            "increment/001-concurrent-increments.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/001-concurrent-increments.json"
            ),
        ),
        (
            "increment/002-increment-then-assign.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/002-increment-then-assign.json"
            ),
        ),
        (
            "increment/003-assign-then-increment.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/003-assign-then-increment.json"
            ),
        ),
        (
            "increment/004-server-row.json",
            include_str!("../../../packages/protocol/transcripts/increment/004-server-row.json"),
        ),
        (
            "increment/005-delete-wins.json",
            include_str!("../../../packages/protocol/transcripts/increment/005-delete-wins.json"),
        ),
        (
            "increment/006-non-numeric-constraint.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/006-non-numeric-constraint.json"
            ),
        ),
        (
            "increment/007-atomic-batch.json",
            include_str!("../../../packages/protocol/transcripts/increment/007-atomic-batch.json"),
        ),
        (
            "increment/008-precondition-mix.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/008-precondition-mix.json"
            ),
        ),
        (
            "increment/009-rejected-transform-applies-no-column.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/009-rejected-transform-applies-no-column.json"
            ),
        ),
        (
            "increment/010-hlc-rejected-transform-applies-no-column.json",
            include_str!(
                "../../../packages/protocol/transcripts/increment/010-hlc-rejected-transform-applies-no-column.json"
            ),
        ),
        (
            "lifecycle/001-checkpoint-expired-rehydrate.json",
            include_str!(
                "../../../packages/protocol/transcripts/lifecycle/001-checkpoint-expired-rehydrate.json"
            ),
        ),
        (
            "lifecycle/002-reset-required.json",
            include_str!(
                "../../../packages/protocol/transcripts/lifecycle/002-reset-required.json"
            ),
        ),
        (
            "lifecycle/003-push-stale-schema.json",
            include_str!(
                "../../../packages/protocol/transcripts/lifecycle/003-push-stale-schema.json"
            ),
        ),
        (
            "lifecycle/004-soft-delete-violation.json",
            include_str!(
                "../../../packages/protocol/transcripts/lifecycle/004-soft-delete-violation.json"
            ),
        ),
        (
            "lifecycle/005-bootstrap-after-reap-pages-to-completion.json",
            include_str!(
                "../../../packages/protocol/transcripts/lifecycle/005-bootstrap-after-reap-pages-to-completion.json"
            ),
        ),
        (
            "lifecycle/006-continuation-expires-when-its-start-is-reaped.json",
            include_str!(
                "../../../packages/protocol/transcripts/lifecycle/006-continuation-expires-when-its-start-is-reaped.json"
            ),
        ),
        (
            "pull/001-bootstrap-empty.json",
            include_str!("../../../packages/protocol/transcripts/pull/001-bootstrap-empty.json"),
        ),
        (
            "pull/002-keyset-pagination.json",
            include_str!("../../../packages/protocol/transcripts/pull/002-keyset-pagination.json"),
        ),
        (
            "pull/003-tombstone-leads-continuation-page.json",
            include_str!(
                "../../../packages/protocol/transcripts/pull/003-tombstone-leads-continuation-page.json"
            ),
        ),
        (
            "pull/004-exact-fit-closes-checkpoint.json",
            include_str!(
                "../../../packages/protocol/transcripts/pull/004-exact-fit-closes-checkpoint.json"
            ),
        ),
        (
            "pull/005-scan-cap-continues-below-the-limit.json",
            include_str!(
                "../../../packages/protocol/transcripts/pull/005-scan-cap-continues-below-the-limit.json"
            ),
        ),
        (
            "pull/006-integer-key-pull-only.json",
            include_str!(
                "../../../packages/protocol/transcripts/pull/006-integer-key-pull-only.json"
            ),
        ),
        (
            "push/001-insert-applied.json",
            include_str!("../../../packages/protocol/transcripts/push/001-insert-applied.json"),
        ),
        (
            "push/002-rls-denied-not-a-wedge.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/002-rls-denied-not-a-wedge.json"
            ),
        ),
        (
            "push/003-replay-returns-recorded-verdicts.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/003-replay-returns-recorded-verdicts.json"
            ),
        ),
        (
            "push/004-precondition-rejected.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/004-precondition-rejected.json"
            ),
        ),
        (
            "push/005-atomic-batch-revert.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/005-atomic-batch-revert.json"
            ),
        ),
        (
            "push/006-constraint-not-a-wedge.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/006-constraint-not-a-wedge.json"
            ),
        ),
        (
            "push/007-replay-renders-current-row.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/007-replay-renders-current-row.json"
            ),
        ),
        (
            "push/008-composite-key-writes.json",
            include_str!(
                "../../../packages/protocol/transcripts/push/008-composite-key-writes.json"
            ),
        ),
        (
            "rebase/001-cursor-advances-with-outbox.json",
            include_str!(
                "../../../packages/protocol/transcripts/rebase/001-cursor-advances-with-outbox.json"
            ),
        ),
        (
            "rebase/002-different-column-visible.json",
            include_str!(
                "../../../packages/protocol/transcripts/rebase/002-different-column-visible.json"
            ),
        ),
        (
            "rebase/003-tombstone-does-not-resurrect.json",
            include_str!(
                "../../../packages/protocol/transcripts/rebase/003-tombstone-does-not-resurrect.json"
            ),
        ),
        (
            "rebase/004-rehydration-replays.json",
            include_str!(
                "../../../packages/protocol/transcripts/rebase/004-rehydration-replays.json"
            ),
        ),
        (
            "tombstones/001-delete-propagates.json",
            include_str!(
                "../../../packages/protocol/transcripts/tombstones/001-delete-propagates.json"
            ),
        ),
        (
            "tombstones/002-offline-edit-no-resurrection.json",
            include_str!(
                "../../../packages/protocol/transcripts/tombstones/002-offline-edit-no-resurrection.json"
            ),
        ),
        (
            "tombstones/003-bucket-scoped-delete.json",
            include_str!(
                "../../../packages/protocol/transcripts/tombstones/003-bucket-scoped-delete.json"
            ),
        ),
        (
            "tombstones/004-bucket-move-out.json",
            include_str!(
                "../../../packages/protocol/transcripts/tombstones/004-bucket-move-out.json"
            ),
        ),
        (
            "wakeup/001-missed-wakeup-poll-converges.json",
            include_str!(
                "../../../packages/protocol/transcripts/wakeup/001-missed-wakeup-poll-converges.json"
            ),
        ),
    ];

    /// Collect every value a `CorpusNode.path` addresses inside one rpc step.
    fn select<'a>(value: &'a Value, path: &str, out: &mut Vec<&'a Value>) {
        if path.is_empty() {
            out.push(value);
            return;
        }
        let (head, rest) = path.split_once('/').unwrap_or((path, ""));
        if head == "*" {
            if let Some(items) = value.as_array() {
                for item in items {
                    select(item, rest, out);
                }
            }
            return;
        }
        if let Some(child) = value.get(head) {
            select(child, rest, out);
        }
    }

    fn assert_node(transcript: &str, node: &CorpusNode, value: &Value) {
        if node.arms.is_empty() {
            for key in node.required {
                assert!(
                    value.get(*key).is_some(),
                    "{transcript}: {}{} requires `{key}`, absent at step path `{}`",
                    node.schema,
                    node.pointer,
                    node.path
                );
            }
            return;
        }
        let matched = node
            .arms
            .iter()
            .any(|arm| arm.iter().all(|key| value.get(*key).is_some()));
        assert!(
            matched,
            "{transcript}: value at step path `{}` matches no oneOf arm of {}{}",
            node.path, node.schema, node.pointer
        );
    }

    fn transcript_steps(name: &str, raw: &str) -> Vec<Value> {
        let doc: Value =
            serde_json::from_str(raw).unwrap_or_else(|e| panic!("{name}: not valid JSON: {e}"));
        let steps = doc
            .get("steps")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{name}: no steps array"));
        steps
            .iter()
            .filter(|s| s.get("kind").and_then(Value::as_str) == Some("rpc"))
            .cloned()
            .collect()
    }

    fn rpc_of(name: &str, step: &Value) -> String {
        step.get("rpc")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{name}: rpc step without an `rpc` key"))
            .to_string()
    }

    #[test]
    fn corpus_rpc_steps_satisfy_the_schema_manifests() {
        let mut checked = 0usize;
        for (name, raw) in TRANSCRIPTS {
            for step in transcript_steps(name, raw) {
                let rpc = rpc_of(name, &step);
                for node in CORPUS_NODES.iter().filter(|n| n.rpc == rpc) {
                    let mut found = Vec::new();
                    select(&step, node.path, &mut found);
                    for value in found {
                        if value.is_null() {
                            continue;
                        }
                        assert_node(name, node, value);
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 0, "the corpus produced no structural assertion");
    }

    #[test]
    fn corpus_responses_round_trip_through_the_hand_written_types() {
        let mut checked = 0usize;
        for (name, raw) in TRANSCRIPTS {
            for step in transcript_steps(name, raw) {
                let rpc = rpc_of(name, &step);
                let Some(response) = step.get("response") else {
                    continue;
                };
                match rpc.as_str() {
                    "push" => assert_stable::<PushResponse>(name, response),
                    "pull" => assert_stable::<PullResponse>(name, response),
                    other => panic!("{name}: unsupported rpc {other}"),
                }
                checked += 1;
            }
        }
        assert!(checked > 0, "the corpus produced no response round-trip");
    }

    /// A corpus response must parse into the crate's type and survive a re-emit unchanged.
    fn assert_stable<T>(name: &str, response: &Value)
    where
        T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let typed: T = serde_json::from_value(response.clone())
            .unwrap_or_else(|e| panic!("{name}: response does not parse: {e}"));
        let reemitted =
            serde_json::to_value(&typed).unwrap_or_else(|e| panic!("{name}: re-emit failed: {e}"));
        let again: T = serde_json::from_value(reemitted)
            .unwrap_or_else(|e| panic!("{name}: re-emitted response does not parse: {e}"));
        assert_eq!(typed, again, "{name}: response is not serde-stable");
    }

    /// The JSON string a closed vocabulary serializes to.
    fn wire<T: Serialize>(value: T) -> String {
        match serde_json::to_value(value) {
            Ok(Value::String(s)) => s,
            other => panic!("a wire vocabulary must serialize to a string, got {other:?}"),
        }
    }

    /// Parse a wire literal; `None` when the closed vocabulary does not cover it.
    fn read<T: serde::de::DeserializeOwned>(literal: &str) -> Option<T> {
        serde_json::from_value(Value::String(literal.to_string())).ok()
    }

    /// A variant must serialize to exactly `literal` and parse back from it.
    fn pins<T>(value: T, literal: &str)
    where
        T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug + Copy,
    {
        assert_eq!(wire(value), literal);
        assert_eq!(read::<T>(literal), Some(value));
    }

    /// Every literal the corpus carries at this vocabulary's positions must parse.
    fn covers<T: serde::de::DeserializeOwned>(name: &str, corpus: &[&str]) {
        for literal in corpus {
            assert!(
                read::<T>(literal).is_some(),
                "{name} cannot spell {literal}"
            );
        }
    }

    #[test]
    fn closed_vocabularies_use_the_exact_wire_casing() {
        pins(Op::Delete, "delete");
        pins(Op::Insert, "insert");
        pins(Op::Update, "update");
        pins(SignalType::CheckpointExpired, "CHECKPOINT_EXPIRED");
        pins(SignalType::ResetRequired, "RESET_REQUIRED");
        pins(RejectReason::ColumnDenied, "COLUMN_DENIED");
        pins(RejectReason::Constraint, "CONSTRAINT");
        pins(RejectReason::DeleteWins, "DELETE_WINS");
        pins(RejectReason::Precondition, "PRECONDITION");
        pins(RejectReason::RlsDenied, "RLS_DENIED");
        pins(RejectReason::Superseded, "SUPERSEDED");
        pins(WireVerdictKind::Applied, "applied");
        pins(WireVerdictKind::Rejected, "rejected");
        pins(WireBatchOutcome::Aborted, "aborted");
        pins(ConflictMode::Arrival, "arrival");
        pins(ConflictMode::Hlc, "hlc");
    }

    #[test]
    fn closed_vocabularies_cover_the_corpus() {
        covers::<Op>("Op", CORPUS_OP);
        covers::<SignalType>("SignalType", CORPUS_SIGNAL_TYPE);
        covers::<RejectReason>("RejectReason", CORPUS_REJECT_REASON);
        covers::<WireVerdictKind>("WireVerdictKind", CORPUS_VERDICT_KIND);
        covers::<WireBatchOutcome>("WireBatchOutcome", CORPUS_BATCH_OUTCOME);
        covers::<ConflictMode>("ConflictMode", CORPUS_CONFLICT_MODE);
    }
}
