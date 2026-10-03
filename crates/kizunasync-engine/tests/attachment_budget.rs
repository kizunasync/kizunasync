//! One attachment gets a budget of transfer attempts, and the app owns what
//! happens after it.
//!
//! The embedder's queue counts its own attempts, so the kernel charges the
//! budget at the one moment a transfer is about to start: the claim. A row that
//! has already spent its attempts is stopped there instead of driven, landing in
//! `failed` with `permanent` set, and no candidate query returns it again. Retry
//! forgives the budget, cancel stops a transfer and keeps the row retryable, and
//! remove forgets it and hands the sandbox path back.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_engine::{
    DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, EngineDeps, ScriptedRemote, SyncEngine,
};
use kizunasync_store::{AttachmentEntry, AttachmentState, LocalStore};
use serde_json::{Map, json};
use std::collections::BTreeMap;
use std::sync::Arc;

const REFERENCE: &str = "u1/p1/photo.png";
const LOCAL_PATH: &str = "/sandbox/photo.png";
const NOW: &str = "2024-01-01T00:00:00.000Z";

fn engine(attachment_attempts: i64) -> SyncEngine {
    SyncEngine::new(
        LocalStore::open_in_memory().expect("store"),
        EngineConfig {
            tables: BTreeMap::new(),
            schema_version: 1,
            default_limit: None,
            attachment_attempts,
            client_id: "c1".into(),
        },
        Arc::new(ScriptedRemote::new()),
        EngineDeps {
            now: Box::new(|| NOW.into()),
            ..EngineDeps::default()
        },
    )
}

fn queued_upload(engine: &SyncEngine) {
    engine
        .put_attachment(&AttachmentEntry {
            reference: REFERENCE.into(),
            upload_id: "photo".into(),
            table: "todos".into(),
            pk: "p1".into(),
            column: "photo".into(),
            bucket: "media".into(),
            owner: "u1".into(),
            sha256: None,
            content_type: Some("image/png".into()),
            size: Some(9),
            local_path: Some(LOCAL_PATH.into()),
            direction: "upload".into(),
            state: AttachmentState::Queued,
            in_flight: false,
            fingerprint: None,
            progress: 0,
            attempts: 0,
            permanent: false,
            chunk_offset: 0,
            tus_url: None,
            error: None,
            created_at: NOW.into(),
            updated_at: NOW.into(),
            error_code: None,
        })
        .expect("enqueue");
}

/// What the embedder's queue writes when a transfer throws: the attempt it just
/// spent, the failed state, and the released claim.
fn record_failure(engine: &SyncEngine, attempts: i64) {
    let mut patch = Map::new();
    patch.insert("state".into(), json!("failed"));
    patch.insert("in_flight".into(), json!(false));
    patch.insert("attempts".into(), json!(attempts));
    patch.insert("error".into(), json!("network is down"));
    engine
        .patch_attachment(REFERENCE, &patch)
        .expect("record the failure");
}

fn is_pending(engine: &SyncEngine) -> bool {
    engine
        .pending_attachments("upload")
        .expect("pending")
        .iter()
        .any(|entry| entry.reference == REFERENCE)
}

fn drive_until_stopped(engine: &SyncEngine, budget: i64) {
    for attempt in 1..=budget {
        assert!(
            is_pending(engine),
            "attempt {attempt} of {budget} must still be a candidate"
        );
        assert!(
            engine
                .claim_attachment(REFERENCE, AttachmentState::Uploading)
                .expect("claim"),
            "attempt {attempt} of {budget} must be claimable"
        );
        record_failure(engine, attempt);
    }
}

#[test]
fn the_attempt_past_the_budget_stops_the_row_for_good() {
    let engine = engine(DEFAULT_ATTACHMENT_ATTEMPTS);
    queued_upload(&engine);

    drive_until_stopped(&engine, DEFAULT_ATTACHMENT_ATTEMPTS);

    assert!(
        is_pending(&engine),
        "a row that spent its budget is still a candidate until the claim charges it"
    );
    assert!(
        !engine
            .claim_attachment(REFERENCE, AttachmentState::Uploading)
            .expect("claim past the budget"),
        "the claim past the budget must be refused"
    );

    let status = engine
        .attachment_status(REFERENCE)
        .expect("status")
        .expect("the row is still there");
    assert_eq!(status.state, AttachmentState::Failed);
    assert!(status.permanent, "the budget stopped it for good");
    assert!(
        !is_pending(&engine),
        "a permanent row is no candidate for any later drive"
    );
    assert_eq!(
        engine
            .get_attachment(REFERENCE)
            .expect("entry")
            .expect("present")
            .attempts,
        DEFAULT_ATTACHMENT_ATTEMPTS,
        "the row records the attempts it consumed, not the claim that stopped it"
    );
}

/// The budget is the config's, so a client that asks for fewer attempts gets
/// fewer.
#[test]
fn the_configured_budget_is_the_one_charged() {
    let engine = engine(2);
    queued_upload(&engine);

    drive_until_stopped(&engine, 2);

    assert!(
        !engine
            .claim_attachment(REFERENCE, AttachmentState::Uploading)
            .expect("claim past the budget")
    );
    assert!(
        engine
            .attachment_status(REFERENCE)
            .expect("status")
            .expect("present")
            .permanent
    );
}

#[test]
fn retry_forgives_the_budget_and_makes_the_row_a_candidate_again() {
    let engine = engine(2);
    queued_upload(&engine);
    drive_until_stopped(&engine, 2);
    assert!(
        !engine
            .claim_attachment(REFERENCE, AttachmentState::Uploading)
            .expect("claim past the budget")
    );

    assert!(engine.retry_attachment(REFERENCE).expect("retry"));

    let entry = engine
        .get_attachment(REFERENCE)
        .expect("entry")
        .expect("present");
    assert_eq!(entry.state, AttachmentState::Queued);
    assert_eq!(entry.attempts, 0);
    assert!(!entry.permanent);
    assert!(entry.error.is_none());
    assert!(is_pending(&engine), "the forgiven row drives again");
    assert!(
        !engine.retry_attachment("u1/p1/absent.png").expect("retry"),
        "a reference no row carries retries nothing"
    );
}

#[test]
fn cancel_stops_the_transfer_and_leaves_the_row_retryable() {
    let engine = engine(DEFAULT_ATTACHMENT_ATTEMPTS);
    queued_upload(&engine);
    assert!(
        engine
            .claim_attachment(REFERENCE, AttachmentState::Uploading)
            .expect("claim")
    );

    assert!(engine.cancel_attachment(REFERENCE).expect("cancel"));

    let entry = engine
        .get_attachment(REFERENCE)
        .expect("entry")
        .expect("present");
    assert_eq!(entry.state, AttachmentState::Failed);
    assert!(!entry.in_flight, "the claim is released");
    assert!(!entry.permanent, "cancelling is not the budget's refusal");
    assert!(is_pending(&engine));
}

#[test]
fn remove_forgets_the_row_and_hands_back_the_sandbox_path() {
    let engine = engine(DEFAULT_ATTACHMENT_ATTEMPTS);
    queued_upload(&engine);

    assert_eq!(
        engine.remove_attachment(REFERENCE).expect("remove"),
        Some(LOCAL_PATH.to_string()),
        "the host deletes the bytes this engine cannot"
    );

    assert!(
        engine
            .attachment_status(REFERENCE)
            .expect("status")
            .is_none()
    );
    assert_eq!(
        engine.remove_attachment(REFERENCE).expect("remove again"),
        None
    );
}
