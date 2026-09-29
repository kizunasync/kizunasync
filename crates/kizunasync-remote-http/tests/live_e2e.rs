//! Optional live smoke against a real Supabase project. SKIPPED by default.
//!
//! Mirrors the gating of `packages/supabase/src/transfer-supabase.live.test.ts`
//! so CI never touches a live project:
//!
//!   `SUPABASE_URL`              : project URL (`https://….supabase.co` or local)
//!   `SUPABASE_PUBLISHABLE_KEY`  : publishable key (or an authenticated user JWT)
//!   `SUPABASE_ANON_KEY`         : accepted alias of the publishable key
//!   `KSYNC_HTTP_E2E=1`          : opt in to the RPC smoke
//!   `KSYNC_TUS_E2E=1`           : opt in to the Storage/TUS smoke
//!
//! Optional: `KSYNC_TUS_E2E_BUCKET` (default `todos`).
//!
//! Run:
//! ```text
//! KSYNC_HTTP_E2E=1 SUPABASE_URL=… SUPABASE_PUBLISHABLE_KEY=… \
//!   cargo test -p kizunasync-remote-http --test live_e2e
//! ```

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::ProtocolRemote;
use kizunasync_protocol::PullRequest;
use kizunasync_remote_http::{HttpProtocolRemote, RemoteConfig, TusConfig, TusTransfer};
use kizunasync_transfer::{Transfer, UploadTarget};

/// `(url, key)` when the opt-in flag and both credentials are set.
fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn publishable_key_from_env() -> Option<String> {
    env_nonempty("SUPABASE_PUBLISHABLE_KEY").or_else(|| env_nonempty("SUPABASE_ANON_KEY"))
}

fn credentials(flag: &str) -> Option<(String, String)> {
    if std::env::var(flag).ok().as_deref() != Some("1") {
        eprintln!(
            "[live_e2e] SKIPPED: set {flag}=1, SUPABASE_URL, and SUPABASE_PUBLISHABLE_KEY to run."
        );
        return None;
    }
    let url = env_nonempty("SUPABASE_URL");
    let key = publishable_key_from_env();
    if let (Some(url), Some(key)) = (url, key) {
        return Some((url, key));
    }
    eprintln!("[live_e2e] SKIPPED: {flag}=1 but SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY are unset.");
    None
}

fn unique_prefix() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("kizunasync-tus-e2e/{millis}")
}

#[tokio::test]
async fn pull_reaches_the_live_rpc() {
    let Some((url, key)) = credentials("KSYNC_HTTP_E2E") else {
        return;
    };
    let mut config = RemoteConfig::new(url.clone(), key.clone());
    config = config.with_access_token(
        std::env::var("SUPABASE_ACCESS_TOKEN")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or(key),
    );
    let remote = HttpProtocolRemote::new(config).expect("client");

    // Bucketless bootstrap pull: reachability + auth + schema exposure, no writes.
    let response = remote
        .pull(PullRequest {
            // A reachability probe registers nothing, and D-client-identity makes the key optional.
            client_id: None,
            schema_version: 1,
            cursor: "0".into(),
            limit: Some(1),
            buckets: vec![],
        })
        .await
        .expect("live pull");

    assert!(!response.cursor.is_empty(), "pull must answer a cursor");
}

#[tokio::test]
async fn storage_upload_takes_both_paths() {
    let Some((url, key)) = credentials("KSYNC_TUS_E2E") else {
        return;
    };
    let bucket = std::env::var("KSYNC_TUS_E2E_BUCKET").unwrap_or_else(|_| "todos".into());
    let prefix = unique_prefix();
    let transfer = TusTransfer::new(TusConfig::new(url, key)).expect("client");

    let small = UploadTarget {
        bucket: bucket.clone(),
        path: format!("{prefix}/small.bin"),
        content_type: "application/octet-stream".into(),
    };
    transfer
        .upload_single_shot(&small, &vec![1_u8; 1024])
        .await
        .expect("single-shot upload");

    // One byte over the 6 MiB policy forces the resumable path.
    let large = UploadTarget {
        bucket,
        path: format!("{prefix}/large.bin"),
        content_type: "application/octet-stream".into(),
    };
    let bytes = vec![2_u8; usize::try_from(kizunasync_transfer::TUS_CHUNK_SIZE).unwrap_or(0) + 1];
    let progress = transfer
        .upload_resumable(&large, &bytes, 0, None)
        .await
        .expect("tus upload");

    assert_eq!(progress.bytes_uploaded, bytes.len() as u64);
    assert!(
        progress.tus_url.is_some(),
        "tus upload must yield a session URL"
    );
}
