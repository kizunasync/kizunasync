//! The method table of [`crate::rpc::dispatch`], read by the three bridges
//! (`kizunasync-ffi`, `kizunasync-napi`, `kizunasync-wasm`) so they document and validate one
//! surface instead of three.
//!
//! `params` names the request shape the arm deserializes (`{}` when it reads
//! none) and `result` the JSON type of the envelope's `value`.
//! `tests/rpc_methods.rs` fails when the table and `src/rpc.rs` drift apart.

/// One dispatch method: its wire name and the shapes on either side of it.
#[non_exhaustive]
pub struct RpcMethod {
    /// The `method` string the bridge passes to [`crate::rpc::dispatch`].
    pub name: &'static str,
    /// The request shape parsed from `params`, or `{}` when the arm reads none.
    pub params: &'static str,
    /// The JSON type of the `value` a successful envelope carries.
    pub result: &'static str,
}

/// Every arm of [`crate::rpc::dispatch`], in the order `src/rpc.rs` matches them.
pub const METHODS: &[RpcMethod] = &[
    RpcMethod {
        name: "ping",
        params: "{}",
        result: "string",
    },
    RpcMethod {
        name: "apply",
        params: "ApplyRequest",
        result: "null",
    },
    RpcMethod {
        name: "apply_where",
        params: "ApplyWhereRequest",
        result: "array",
    },
    RpcMethod {
        name: "query",
        params: "QueryRequest",
        result: "QueryResult",
    },
    RpcMethod {
        name: "read",
        params: "RowRequest",
        result: "object | null",
    },
    RpcMethod {
        name: "has_tombstone",
        params: "RowRequest",
        result: "boolean",
    },
    RpcMethod {
        name: "outbox_depth",
        params: "{}",
        result: "number",
    },
    RpcMethod {
        name: "store_kind",
        params: "{}",
        result: "{ kind: string, durability: string }",
    },
    RpcMethod {
        name: "checkpoint",
        params: "{}",
        result: "object",
    },
    RpcMethod {
        name: "seed_checkpoint",
        params: "CursorRequest",
        result: "null",
    },
    RpcMethod {
        name: "inspect",
        params: "{}",
        result: "object",
    },
    RpcMethod {
        name: "rejections",
        params: "RejectionsRequest",
        result: "array",
    },
    RpcMethod {
        name: "dismiss_rejection",
        params: "MutationIdRequest",
        result: "boolean",
    },
    RpcMethod {
        name: "overwrites",
        params: "OverwritesRequest",
        result: "array",
    },
    RpcMethod {
        name: "dismiss_overwrite",
        params: "OverwriteIdRequest",
        result: "boolean",
    },
    RpcMethod {
        name: "reset",
        params: "{}",
        result: "array",
    },
    RpcMethod {
        name: "set_bucket",
        params: "BucketRequest",
        result: "null",
    },
    RpcMethod {
        name: "set_access_token",
        params: "AccessTokenRequest",
        result: "null",
    },
    RpcMethod {
        name: "attachment_status",
        params: "ReferenceRequest",
        result: "object | null",
    },
    RpcMethod {
        name: "attachment_put",
        params: "AttachmentPutRequest",
        result: "null",
    },
    RpcMethod {
        name: "attachment_get",
        params: "ReferenceRequest",
        result: "object | null",
    },
    RpcMethod {
        name: "attachment_pending",
        params: "AttachmentDirectionRequest",
        result: "array",
    },
    RpcMethod {
        name: "attachment_claim",
        params: "AttachmentClaimRequest",
        result: "boolean",
    },
    RpcMethod {
        name: "attachment_patch",
        params: "AttachmentPatchRequest",
        result: "null",
    },
    RpcMethod {
        name: "attachment_orphan",
        params: "ReferenceRequest",
        result: "null",
    },
    RpcMethod {
        name: "attachment_purge",
        params: "ReferenceRequest",
        result: "null",
    },
    RpcMethod {
        name: "attachment_retry",
        params: "ReferenceRequest",
        result: "boolean",
    },
    RpcMethod {
        name: "attachment_cancel",
        params: "ReferenceRequest",
        result: "boolean",
    },
    RpcMethod {
        name: "attachment_remove",
        params: "ReferenceRequest",
        result: "string | null",
    },
    RpcMethod {
        name: "attachment_orphaned",
        params: "{}",
        result: "array",
    },
    RpcMethod {
        name: "attachment_recover",
        params: "{}",
        result: "null",
    },
    RpcMethod {
        name: "attachment_count_at_path",
        params: "AttachmentCountRequest",
        result: "number",
    },
    RpcMethod {
        name: "sync",
        params: "{}",
        result: "null",
    },
    RpcMethod {
        name: "sync_push",
        params: "{}",
        result: "null",
    },
    RpcMethod {
        name: "sync_pull",
        params: "{}",
        result: "null",
    },
    RpcMethod {
        name: "pull_once",
        params: "{}",
        result: "null",
    },
    RpcMethod {
        name: "push_once",
        params: "{}",
        result: "null",
    },
];
