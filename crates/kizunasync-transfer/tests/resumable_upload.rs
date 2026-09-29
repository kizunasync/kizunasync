//! Integration cover for kill/resume of a TUS upload driven by `upload_with_policy`.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_transfer::{
    ConfirmMeta, FakeTransfer, ObjectTarget, Transfer, TransferError, UploadProgress, UploadTarget,
    upload_with_policy,
};
use std::collections::VecDeque;
use std::sync::Mutex;

const SESSION_URL: &str = "https://abc.storage.supabase.co/upload/resumable/session-1";

fn target() -> UploadTarget {
    UploadTarget {
        bucket: "media".into(),
        path: "u1/p1/photo.bin".into(),
        content_type: "application/octet-stream".into(),
    }
}

/// Reports one scripted interrupt offset per attempt, then completes: the only
/// way to drive `upload_with_policy` past a single interrupt.
struct ScriptedInterrupts {
    offsets: Mutex<VecDeque<u64>>,
    attempts: Mutex<u32>,
}

impl ScriptedInterrupts {
    fn new(offsets: impl IntoIterator<Item = u64>) -> Self {
        Self {
            offsets: Mutex::new(offsets.into_iter().collect()),
            attempts: Mutex::new(0),
        }
    }

    fn attempts(&self) -> u32 {
        *self.attempts.lock().unwrap()
    }
}

#[async_trait::async_trait]
impl Transfer for ScriptedInterrupts {
    fn supports_resumable(&self) -> bool {
        true
    }

    fn single_shot_max_bytes(&self) -> u64 {
        16
    }

    async fn upload_single_shot(
        &self,
        _target: &UploadTarget,
        _bytes: &[u8],
    ) -> Result<(), TransferError> {
        Err(TransferError::Failed("single shot is not scripted".into()))
    }

    async fn upload_resumable(
        &self,
        _target: &UploadTarget,
        bytes: &[u8],
        _start_offset: u64,
        _existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        *self.attempts.lock().unwrap() += 1;
        if let Some(offset) = self.offsets.lock().unwrap().pop_front() {
            return Err(TransferError::Interrupted {
                offset,
                tus_url: Some(SESSION_URL.into()),
            });
        }
        Ok(UploadProgress {
            bytes_uploaded: bytes.len() as u64,
            bytes_total: bytes.len() as u64,
            tus_url: Some(SESSION_URL.into()),
        })
    }

    async fn confirm(
        &self,
        _target: &ObjectTarget,
        _meta: &ConfirmMeta,
        _table: &str,
    ) -> Result<(), TransferError> {
        Err(TransferError::Failed("confirm is not scripted".into()))
    }

    async fn download(
        &self,
        _target: &ObjectTarget,
        _to_local_path: &str,
        _sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        Err(TransferError::Failed("download is not scripted".into()))
    }

    async fn remove(&self, _target: &ObjectTarget) -> Result<(), TransferError> {
        Err(TransferError::Failed("remove is not scripted".into()))
    }
}

#[tokio::test]
async fn policy_resumes_after_a_mid_flight_kill() {
    let mut fake = FakeTransfer::new();
    // Force the resumable path without allocating a 6 MiB payload.
    fake.max_single = 16;
    let bytes: Vec<u8> = (0..200u32)
        .map(|i| u8::try_from(i % 251).unwrap())
        .collect();
    fake.interrupt_once_at(64);

    let done = upload_with_policy(&fake, &target(), &bytes, 0, None)
        .await
        .expect("policy retries past the interrupt");

    assert_eq!(done.bytes_uploaded, 200);
    assert_eq!(done.bytes_total, 200);
    assert_eq!(done.tus_url.as_deref(), Some("tus://media/u1/p1/photo.bin"));
    assert_eq!(fake.uploaded.lock().unwrap().as_slice(), bytes.as_slice());
}

#[tokio::test]
async fn a_killed_upload_resumes_from_durable_offset_on_a_fresh_run() {
    let mut fake = FakeTransfer::new();
    fake.max_single = 16;
    let bytes = vec![9u8; 300];
    fake.interrupt_once_at(120);

    // First run dies; the durable offset a store would persist is the interrupt point.
    let err = fake
        .upload_resumable(&target(), &bytes, 0, None)
        .await
        .expect_err("interrupted");
    let resume_offset = match err {
        TransferError::Interrupted { offset, tus_url } => {
            assert_eq!(tus_url.as_deref(), Some("tus://media/u1/p1/photo.bin"));
            offset
        }
        other => panic!("expected Interrupted, got {other}"),
    };
    assert_eq!(resume_offset, 120);
    assert_eq!(fake.uploaded.lock().unwrap().len(), 120);

    // A later process resumes with the stored offset and TUS session URL.
    let done = upload_with_policy(
        &fake,
        &target(),
        &bytes,
        resume_offset,
        Some("tus://media/u1/p1/photo.bin".into()),
    )
    .await
    .expect("resume completes");

    assert_eq!(done.bytes_uploaded, 300);
    assert_eq!(fake.uploaded.lock().unwrap().len(), 300);
}

/// Two interrupts at the same offset mean nothing is moving: the policy must
/// hand the interrupt to the caller instead of looping on a dead session.
#[tokio::test]
async fn the_policy_returns_an_interrupt_that_made_no_progress() {
    let transfer = ScriptedInterrupts::new([40, 40]);
    let bytes = vec![1_u8; 200];

    let error = upload_with_policy(&transfer, &target(), &bytes, 0, None)
        .await
        .expect_err("an offset that never advances must reach the caller");

    assert_eq!(
        error,
        TransferError::Interrupted {
            offset: 40,
            tus_url: Some(SESSION_URL.into())
        }
    );
    assert_eq!(transfer.attempts(), 2);
}

#[tokio::test]
async fn the_policy_retries_while_the_offset_advances() {
    let transfer = ScriptedInterrupts::new([40, 80, 120]);
    let bytes = vec![1_u8; 200];

    let done = upload_with_policy(&transfer, &target(), &bytes, 0, None)
        .await
        .expect("an advancing offset earns another attempt");

    assert_eq!(done.bytes_uploaded, 200);
    assert_eq!(transfer.attempts(), 4);
}

#[tokio::test]
async fn payloads_under_the_threshold_never_open_a_tus_session() {
    let fake = FakeTransfer::new();
    let bytes = b"small";

    let done = upload_with_policy(&fake, &target(), bytes, 0, None)
        .await
        .expect("single shot");

    assert!(done.tus_url.is_none());
    assert!(fake.tus_sessions.lock().unwrap().is_empty());
    assert_eq!(fake.uploaded.lock().unwrap().as_slice(), bytes);
}
