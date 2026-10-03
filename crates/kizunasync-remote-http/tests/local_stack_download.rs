//! Sign and fetch against a local Supabase stack: an object uploaded through
//! the live transfer comes back through `download`, which signs it, joins the
//! signed path under `/storage/v1`, fetches it, and verifies its hash.
//!
//! The keys come from `supabase status`, never from this file:
//! `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) signs every request.
//! `SUPABASE_API_URL` defaults to the pack's local stack,
//! `http://127.0.0.1:55321`, and `KSYNC_TUS_E2E_BUCKET` to `todos`. The test
//! skips with a named reason when the key is absent or the stack does not
//! answer.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use async_trait::async_trait;
use kizunasync_remote_http::{
    HttpError, HttpMethod, HttpRequest, HttpResponse, HttpTransport, ReqwestTransport, TusConfig,
    TusTransfer,
};
use kizunasync_transfer::{ObjectTarget, Transfer, UploadTarget, sha256_hex};
use std::sync::{Arc, Mutex};

const DEFAULT_API_URL: &str = "http://127.0.0.1:55321";

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

/// The live transport, recording every request URL so the test can tell the
/// signed fetch from the authenticated fallback.
struct Recording {
    inner: ReqwestTransport,
    requests: Mutex<Vec<(HttpMethod, String)>>,
}

#[async_trait]
impl HttpTransport for Recording {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        self.requests
            .lock()
            .unwrap()
            .push((request.method, request.url.clone()));
        self.inner.execute(request).await
    }
}

struct LocalStack {
    api_url: String,
    key: String,
    bucket: String,
    transport: Arc<Recording>,
}

impl LocalStack {
    /// The stack, or `None` with the reason printed when the test cannot run.
    async fn reachable() -> Option<Self> {
        let Some(key) = env_nonempty("SUPABASE_SERVICE_ROLE_KEY")
            .or_else(|| env_nonempty("SUPABASE_SECRET_KEY"))
        else {
            eprintln!(
                "[local_stack_download] SKIPPED: set SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) from `supabase status`."
            );
            return None;
        };
        let api_url = env_nonempty("SUPABASE_API_URL").unwrap_or_else(|| DEFAULT_API_URL.into());
        let transport = Arc::new(Recording {
            inner: ReqwestTransport::new().expect("transport"),
            requests: Mutex::new(Vec::new()),
        });
        let probe = transport
            .inner
            .execute(HttpRequest {
                method: HttpMethod::Get,
                url: format!("{api_url}/rest/v1/"),
                headers: vec![("apikey".into(), key.clone())],
                body: Vec::new(),
                timeout: None,
            })
            .await;
        if probe.is_err() {
            eprintln!(
                "[local_stack_download] SKIPPED: no Supabase API at {api_url}. Run `bun run db:start`."
            );
            return None;
        }

        Some(Self {
            api_url,
            key,
            bucket: env_nonempty("KSYNC_TUS_E2E_BUCKET").unwrap_or_else(|| "todos".into()),
            transport,
        })
    }

    fn transfer(&self) -> TusTransfer {
        let config = TusConfig::new(self.api_url.clone(), self.key.clone())
            .with_publishable_key(self.key.clone());
        TusTransfer::with_transport(config, self.transport.clone())
    }

    /// Best-effort cleanup: the object goes whether or not the test passed.
    async fn delete(&self, path: &str) {
        let encoded: Vec<String> = path.split('/').map(percent_encode).collect();
        let _ = self
            .transport
            .inner
            .execute(HttpRequest {
                method: HttpMethod::Delete,
                url: format!(
                    "{}/storage/v1/object/{}/{}",
                    self.api_url,
                    self.bucket,
                    encoded.join("/")
                ),
                headers: vec![
                    ("apikey".into(), self.key.clone()),
                    ("Authorization".into(), format!("Bearer {}", self.key)),
                ],
                body: Vec::new(),
                timeout: None,
            })
            .await;
    }
}

fn percent_encode(segment: &str) -> String {
    use std::fmt::Write as _;
    segment.bytes().fold(String::new(), |mut out, byte| {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
        out
    })
}

fn unique_prefix() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("kizunasync-remote-http-e2e/{millis}")
}

/// Uploads `bytes` at `path`, downloads them back, deletes the object, and
/// answers the downloaded file's bytes.
async fn round_trip(stack: &LocalStack, path: &str, bytes: &[u8]) -> Vec<u8> {
    let transfer = stack.transfer();
    let upload = transfer
        .upload_single_shot(
            &UploadTarget {
                bucket: stack.bucket.clone(),
                path: path.into(),
                content_type: "application/octet-stream".into(),
            },
            bytes,
        )
        .await;
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("object.bin");
    let download = transfer
        .download(
            &ObjectTarget {
                bucket: stack.bucket.clone(),
                path: path.into(),
            },
            &dest.to_string_lossy(),
            Some(&sha256_hex(bytes)),
        )
        .await;
    stack.delete(path).await;

    upload.expect("upload");
    download.expect("download");
    std::fs::read(&dest).expect("downloaded file")
}

#[tokio::test]
async fn a_download_signs_the_object_and_fetches_the_signed_url() {
    let Some(stack) = LocalStack::reachable().await else {
        return;
    };
    let prefix = unique_prefix();
    let plain = format!("{prefix}/object.bin");
    let spaced = format!("{prefix}/with space (1)/object.bin");

    for path in [&plain, &spaced] {
        let bytes = format!("bytes of {path}").into_bytes();

        assert_eq!(round_trip(&stack, path, &bytes).await, bytes, "{path}");
    }

    let requests = stack.transport.requests.lock().unwrap().clone();
    let fetches: Vec<&String> = requests
        .iter()
        .filter(|(method, _)| *method == HttpMethod::Get)
        .map(|(_, url)| url)
        .collect();
    assert_eq!(fetches.len(), 2, "{fetches:?}");
    for url in fetches {
        assert!(
            url.starts_with(&format!("{}/storage/v1/object/sign/", stack.api_url))
                && url.contains("?token="),
            "every fetch goes through a signed URL: {url}"
        );
    }
}
