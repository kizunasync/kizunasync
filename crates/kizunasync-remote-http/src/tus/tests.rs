use super::*;
use crate::transport::{DEFAULT_BYTES_TIMEOUT, FakeTransport, HttpResponse, json_response};
use kizunasync_transfer::upload_with_policy;

const UPLOAD_URL: &str = "https://abc.storage.supabase.co/upload/resumable/upload-1";

fn target() -> UploadTarget {
    UploadTarget {
        bucket: "media".into(),
        path: "u1/p1.bin".into(),
        content_type: "application/octet-stream".into(),
    }
}

fn config() -> TusConfig {
    TusConfig::new("https://abc.supabase.co", "tok").with_single_shot_max_bytes(16)
}

fn empty(status: u16, headers: Vec<(String, String)>) -> HttpResponse {
    HttpResponse {
        status,
        headers,
        body: Vec::new(),
    }
}

/// A TUS server that accepts a session, tracks the offset, and optionally
/// dies once at a given offset (the mid-flight kill).
struct FakeTusServer {
    received: Mutex<Vec<u8>>,
    die_at: Mutex<Option<u64>>,
    /// The `Upload-Length` the session was created with, which every HEAD
    /// reports back.
    length: Mutex<Option<u64>>,
}

impl FakeTusServer {
    fn new(die_at: Option<u64>) -> Arc<Self> {
        Arc::new(Self {
            received: Mutex::new(Vec::new()),
            die_at: Mutex::new(die_at),
            length: Mutex::new(None),
        })
    }

    /// A server that already holds a session of `length` bytes, as one a
    /// previous run created.
    fn holding_a_session_of(length: u64) -> Arc<Self> {
        let server = Self::new(None);
        *server.length.lock().unwrap() = Some(length);
        server
    }

    fn offset(&self) -> u64 {
        self.received
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len() as u64
    }

    fn handle(&self, request: &HttpRequest) -> HttpResponse {
        match request.method {
            HttpMethod::Post => {
                *self.length.lock().unwrap() = request
                    .header("Upload-Length")
                    .and_then(|value| value.parse().ok());
                empty(201, vec![("Location".into(), UPLOAD_URL.into())])
            }
            HttpMethod::Head => {
                let mut headers = vec![("Upload-Offset".into(), self.offset().to_string())];
                if let Some(length) = *self.length.lock().unwrap() {
                    headers.push(("Upload-Length".into(), length.to_string()));
                }
                empty(200, headers)
            }
            HttpMethod::Patch => {
                let start = request
                    .header("Upload-Offset")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0);
                if start != self.offset() {
                    return empty(409, Vec::new());
                }
                let mut die_at = self
                    .die_at
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(at) = *die_at
                    && start + request.body.len() as u64 > at
                    && at >= start
                {
                    let accepted = usize::try_from(at - start).unwrap_or(0);
                    self.received
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .extend_from_slice(&request.body[..accepted]);
                    *die_at = None;
                    return empty(500, Vec::new());
                }
                drop(die_at);
                self.received
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .extend_from_slice(&request.body);
                empty(
                    204,
                    vec![("Upload-Offset".into(), self.offset().to_string())],
                )
            }
            HttpMethod::Get | HttpMethod::Delete => empty(405, Vec::new()),
        }
    }
}

/// The headers a HEAD on a live session answers with.
fn session_head(offset: u64, length: u64) -> Vec<(String, String)> {
    vec![
        ("Upload-Offset".into(), offset.to_string()),
        ("Upload-Length".into(), length.to_string()),
    ]
}

fn transfer_against(server: &Arc<FakeTusServer>) -> (TusTransfer, Arc<FakeTransport>) {
    let handler_server = Arc::clone(server);
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(handler_server.handle(request))
    }));
    (
        TusTransfer::with_transport(config(), transport.clone()),
        transport,
    )
}

#[test]
fn endpoint_derivation_matches_the_typescript_client() {
    assert_eq!(
        tus_endpoint_from_supabase_url("https://abc.supabase.co"),
        "https://abc.storage.supabase.co/storage/v1/upload/resumable"
    );
    assert_eq!(
        tus_endpoint_from_supabase_url("https://abc.supabase.co/"),
        "https://abc.storage.supabase.co/storage/v1/upload/resumable"
    );
    assert_eq!(
        tus_endpoint_from_supabase_url("https://db.example.com"),
        "https://db.example.com/storage/v1/upload/resumable"
    );
}

#[test]
fn tus_location_must_share_the_endpoint_origin() {
    let endpoint = "https://abc.storage.supabase.co/storage/v1/upload/resumable";
    assert_eq!(
        resolve_tus_location(endpoint, "/upload/resumable/relative-1").unwrap(),
        "https://abc.storage.supabase.co/upload/resumable/relative-1"
    );
    assert_eq!(
        resolve_tus_location(
            endpoint,
            "https://abc.storage.supabase.co/upload/resumable/upload-1"
        )
        .unwrap(),
        "https://abc.storage.supabase.co/upload/resumable/upload-1"
    );
    let err = resolve_tus_location(endpoint, "https://evil.example/steal").unwrap_err();
    assert_eq!(err, TransferError::OriginMismatch);
}

#[test]
fn slice_rejects_a_range_past_the_end_of_the_bytes() {
    let bytes = [0_u8; 10];
    let error = slice(&bytes, 5, 11).expect_err("11 is past the end of a 10-byte slice");
    assert!(
        matches!(&error, TransferError::Failed(message) if message.contains("5..11")),
        "{error}"
    );
}

#[tokio::test]
async fn a_small_payload_goes_single_shot() {
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);

    let progress = upload_with_policy(&transfer, &target(), b"small", 0, None)
        .await
        .expect("single shot");

    assert!(progress.tus_url.is_none());
    let requests = transport.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url,
        "https://abc.supabase.co/storage/v1/object/media/u1/p1.bin"
    );
    assert_eq!(requests[0].header("x-upsert"), Some("true"));
    assert_eq!(requests[0].body, b"small");
}

#[tokio::test]
async fn creation_sends_the_documented_tus_headers() {
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);
    let bytes = vec![7_u8; 64];

    let progress = transfer
        .upload_resumable(&target(), &bytes, 0, None)
        .await
        .expect("upload");

    assert_eq!(progress.bytes_uploaded, 64);
    assert_eq!(progress.tus_url.as_deref(), Some(UPLOAD_URL));

    let requests = transport.requests();

    let create = &requests[0];
    assert_eq!(create.method, HttpMethod::Post);
    assert_eq!(
        create.url,
        "https://abc.storage.supabase.co/storage/v1/upload/resumable"
    );
    assert_eq!(create.header("Tus-Resumable"), Some("1.0.0"));
    assert_eq!(create.header("Upload-Length"), Some("64"));
    assert_eq!(create.header("Content-Type"), Some(OFFSET_CONTENT_TYPE));
    assert_eq!(create.header("x-upsert"), Some("true"));
    assert_eq!(
        create.header("Upload-Metadata"),
        Some(
            "bucketName bWVkaWE=,objectName dTEvcDEuYmlu,\
             contentType YXBwbGljYXRpb24vb2N0ZXQtc3RyZWFt,cacheControl MzYwMA=="
        )
    );

    let patch = &requests[1];
    assert_eq!(patch.method, HttpMethod::Patch);
    assert_eq!(patch.url, UPLOAD_URL);
    assert_eq!(patch.header("Upload-Offset"), Some("0"));
    assert_eq!(patch.header("Content-Type"), Some(OFFSET_CONTENT_TYPE));
    assert_eq!(patch.header("Content-Length"), Some("64"));
    // Resume-only header: creation already carried the upsert intent.
    assert_eq!(patch.header("x-upsert"), None);
    assert_eq!(server.offset(), 64);
}

#[tokio::test]
async fn a_mid_chunk_kill_resumes_from_the_server_offset() {
    let server = FakeTusServer::new(Some(40));
    let (transfer, transport) = transfer_against(&server);
    let bytes: Vec<u8> = (0..100_u32)
        .map(|i| u8::try_from(i % 251).unwrap())
        .collect();

    let failure = transfer
        .upload_resumable(&target(), &bytes, 0, None)
        .await
        .expect_err("the server dies mid-chunk");
    assert!(
        matches!(&failure, TransferError::Http { status: 500, .. }),
        "{failure}"
    );
    assert_eq!(server.offset(), 40);

    // A fresh attempt reuses the session URL and continues from 40.
    let progress = transfer
        .upload_resumable(&target(), &bytes, 40, Some(UPLOAD_URL))
        .await
        .expect("resume");

    assert_eq!(progress.bytes_uploaded, 100);
    assert_eq!(progress.tus_url.as_deref(), Some(UPLOAD_URL));
    assert_eq!(
        server.received.lock().unwrap().as_slice(),
        bytes.as_slice(),
        "the resumed upload must not duplicate or skip bytes"
    );

    let resume = transport.requests();

    let head = resume.iter().find(|r| r.method == HttpMethod::Head);
    assert!(head.is_some(), "resume must HEAD the session URL first");
    // Exactly one session was ever created.
    assert_eq!(
        resume
            .iter()
            .filter(|r| r.method == HttpMethod::Post)
            .count(),
        1
    );
    let last_patch = resume
        .iter()
        .rfind(|r| r.method == HttpMethod::Patch)
        .expect("a resumed PATCH");
    assert_eq!(last_patch.header("Upload-Offset"), Some("40"));
}

/// The network change / process-kill case: no HTTP response at all, so the
/// server-confirmed offset and the live session URL must reach the caller as
/// resume state rather than a dead `Failed`.
#[tokio::test]
async fn a_transport_loss_mid_patch_is_a_resumable_interrupt() {
    let transport = Arc::new(FakeTransport::new(|request| match request.method {
        HttpMethod::Head => Ok(empty(200, session_head(40, 100))),
        HttpMethod::Patch => Err(HttpError::Transport("connection reset by peer".into())),
        HttpMethod::Get | HttpMethod::Post | HttpMethod::Delete => Ok(empty(500, Vec::new())),
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect_err("the network goes away mid-PATCH");

    assert_eq!(
        error,
        TransferError::Interrupted {
            offset: 40,
            tus_url: Some(UPLOAD_URL.to_string())
        }
    );
}

/// A status the server chose to answer with is a refusal the caller can read,
/// carried as the status itself rather than as prose to parse.
#[tokio::test]
async fn an_http_status_failure_mid_patch_carries_the_status() {
    let transport = Arc::new(FakeTransport::new(|request| {
        Ok(match request.method {
            HttpMethod::Head => empty(200, session_head(40, 100)),
            HttpMethod::Get | HttpMethod::Post | HttpMethod::Patch | HttpMethod::Delete => {
                empty(400, Vec::new())
            }
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect_err("a 400 is the server refusing the chunk");

    assert!(
        matches!(&error, TransferError::Http { status: 400, .. }),
        "{error}"
    );
}

/// A server that keeps refusing the very offset its own HEAD reports never
/// converges. The budget ends the loop and hands the live session back as
/// resume state, which is where the caller's durable offset belongs.
#[tokio::test]
async fn patch_all_returns_interrupted_after_repeated_409_without_progress() {
    let transport = Arc::new(FakeTransport::new(|request| {
        Ok(match request.method {
            HttpMethod::Head => empty(200, session_head(0, 100)),
            HttpMethod::Patch => empty(409, Vec::new()),
            HttpMethod::Get | HttpMethod::Post | HttpMethod::Delete => empty(405, Vec::new()),
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect_err("the server's offset never moves");

    assert_eq!(
        error,
        TransferError::Interrupted {
            offset: 0,
            tus_url: Some(UPLOAD_URL.to_string())
        }
    );
    let patches = transport
        .requests()
        .iter()
        .filter(|request| request.method == HttpMethod::Patch)
        .count();
    assert_eq!(
        patches,
        usize::try_from(TUS_MAX_OFFSET_CONFLICTS).unwrap_or(0) + 1
    );
}

/// The re-HEAD a 409 triggers must not hand the PATCH loop an offset past the
/// object's own length: that would ask the next chunk to start beyond `total`.
#[tokio::test]
async fn patch_all_rejects_a_server_offset_beyond_the_total() {
    let heads = Arc::new(Mutex::new(0_u32));
    let handler_heads = Arc::clone(&heads);
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(match request.method {
            HttpMethod::Head => {
                let mut count = handler_heads.lock().unwrap();
                *count += 1;
                if *count == 1 {
                    // The upload_resumable entry HEAD: a valid, in-range offset.
                    empty(200, session_head(0, 100))
                } else {
                    // The 409's re-HEAD: past the 100-byte object.
                    empty(200, session_head(150, 100))
                }
            }
            HttpMethod::Patch => empty(409, Vec::new()),
            HttpMethod::Get | HttpMethod::Post | HttpMethod::Delete => empty(405, Vec::new()),
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect_err("a HEAD offset past the object's length breaks the protocol");

    assert!(
        matches!(&error, TransferError::Protocol { detail }
            if detail.contains("150") && detail.contains("100")),
        "{error}"
    );
}

#[tokio::test]
async fn a_stale_durable_offset_loses_to_the_server() {
    let server = FakeTusServer::holding_a_session_of(50);
    let (transfer, _) = transfer_against(&server);
    let bytes = vec![3_u8; 50];

    // Session exists and the server has nothing yet, but the caller claims 30.
    transfer.remember_session(&TusTransfer::session_key(&target()), UPLOAD_URL);

    let progress = transfer
        .upload_resumable(&target(), &bytes, 30, None)
        .await
        .expect("upload");

    assert_eq!(progress.bytes_uploaded, 50);
    assert_eq!(server.received.lock().unwrap().len(), 50);
}

#[tokio::test]
async fn an_expired_session_restarts_from_zero() {
    let created = Arc::new(Mutex::new(0_usize));
    let handler_created = Arc::clone(&created);
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(match request.method {
            HttpMethod::Head => empty(410, Vec::new()),
            HttpMethod::Post => {
                *handler_created
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
                empty(201, vec![("Location".into(), UPLOAD_URL.into())])
            }
            HttpMethod::Get | HttpMethod::Patch | HttpMethod::Delete => {
                empty(204, vec![("Upload-Offset".into(), "50".into())])
            }
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());

    let progress = transfer
        .upload_resumable(
            &target(),
            &[1_u8; 50],
            40,
            Some("https://abc.storage.supabase.co/upload/resumable/dead-session"),
        )
        .await
        .expect("upload");

    assert_eq!(progress.bytes_uploaded, 50);
    assert_eq!(*created.lock().unwrap(), 1);

    let patch = transport
        .requests()
        .into_iter()
        .find(|r| r.method == HttpMethod::Patch)
        .expect("patch");
    assert_eq!(patch.header("Upload-Offset"), Some("0"));
}

#[tokio::test]
async fn a_relative_location_resolves_against_the_endpoint() {
    let transport = Arc::new(FakeTransport::new(|request| {
        Ok(match request.method {
            HttpMethod::Post => empty(
                201,
                vec![("Location".into(), "/upload/resumable/relative-1".into())],
            ),
            HttpMethod::Get | HttpMethod::Head | HttpMethod::Patch | HttpMethod::Delete => {
                empty(204, vec![("Upload-Offset".into(), "20".into())])
            }
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let progress = transfer
        .upload_resumable(&target(), &[0_u8; 20], 0, None)
        .await
        .expect("upload");

    assert_eq!(
        progress.tus_url.as_deref(),
        Some("https://abc.storage.supabase.co/upload/resumable/relative-1")
    );
}

#[tokio::test]
async fn a_path_relative_location_resolves_against_the_origin_like_the_ts_client() {
    // tus-client.ts: `new URL(location, base.origin)`. A Location with no
    // leading slash must NOT inherit the `/storage/v1/upload/` endpoint path.
    let transport = Arc::new(FakeTransport::new(|request| {
        Ok(match request.method {
            HttpMethod::Post => empty(201, vec![("Location".into(), "sessions/relative-2".into())]),
            HttpMethod::Get | HttpMethod::Head | HttpMethod::Patch | HttpMethod::Delete => {
                empty(204, vec![("Upload-Offset".into(), "20".into())])
            }
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let progress = transfer
        .upload_resumable(&target(), &[0_u8; 20], 0, None)
        .await
        .expect("upload");

    assert_eq!(
        progress.tus_url.as_deref(),
        Some("https://abc.storage.supabase.co/sessions/relative-2")
    );
}

#[tokio::test]
async fn the_single_shot_path_sends_the_apikey_when_configured() {
    // storage-js sends `apikey` alongside the bearer; without it Kong
    // rejects a user-JWT upload, so parity requires the header.
    let server = FakeTusServer::new(None);
    let handler_server = Arc::clone(&server);
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(handler_server.handle(request))
    }));
    let transfer = TusTransfer::with_transport(
        config().with_publishable_key("pub-key-1"),
        transport.clone(),
    );

    upload_with_policy(&transfer, &target(), b"small", 0, None)
        .await
        .expect("single shot");

    let requests = transport.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].header("apikey"), Some("pub-key-1"));
    assert_eq!(requests[0].header("Authorization"), Some("Bearer tok"));
}

#[tokio::test]
async fn a_chunk_is_never_larger_than_the_tus_chunk_size() {
    // Guard the 6 MiB policy without a live server: one byte over the chunk.
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);
    let bytes = vec![0_u8; usize::try_from(TUS_CHUNK_SIZE).unwrap_or(0) + 1];

    let progress = transfer
        .upload_resumable(&target(), &bytes, 0, None)
        .await
        .expect("upload");

    assert_eq!(progress.bytes_uploaded, TUS_CHUNK_SIZE + 1);
    let patches: Vec<usize> = transport
        .requests()
        .iter()
        .filter(|r| r.method == HttpMethod::Patch)
        .map(|r| r.body.len())
        .collect();
    assert_eq!(
        patches,
        vec![usize::try_from(TUS_CHUNK_SIZE).unwrap_or(0), 1]
    );
}

#[tokio::test]
async fn set_access_token_replaces_the_bearer_on_the_next_upload() {
    let server = FakeTusServer::new(None);
    let handler_server = Arc::clone(&server);
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(handler_server.handle(request))
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());
    transfer.set_access_token(Some("jwt-2".into()));
    upload_with_policy(&transfer, &target(), b"small", 0, None)
        .await
        .expect("single shot");
    assert_eq!(
        transport.requests()[0].header("Authorization"),
        Some("Bearer jwt-2")
    );
}

/// A transfer whose session was signed out, plus a transport that would
/// happily answer 200, so a recorded request proves the token check leaked.
fn signed_out_transfer() -> (TusTransfer, Arc<FakeTransport>) {
    let transport = Arc::new(FakeTransport::new(|_| {
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: b"{}".to_vec(),
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());
    transfer.set_access_token(None);
    (transfer, transport)
}

fn assert_missing_session(error: &TransferError, transport: &Arc<FakeTransport>) {
    assert_eq!(error, &TransferError::Unauthorized);
    assert!(
        transport.requests().is_empty(),
        "a cleared session must never reach the wire"
    );
}

fn object_target() -> ObjectTarget {
    ObjectTarget {
        bucket: "media".into(),
        path: "u1/p1.bin".into(),
    }
}

#[tokio::test]
async fn a_cleared_session_fails_loud_before_any_storage_request() {
    let (transfer, transport) = signed_out_transfer();
    let error = transfer
        .upload_single_shot(&target(), b"small")
        .await
        .expect_err("no session");
    assert_missing_session(&error, &transport);

    let (transfer, transport) = signed_out_transfer();
    let error = transfer
        .confirm(
            &object_target(),
            &ConfirmMeta {
                sha256: "abc".into(),
                size: 4,
                content_type: "image/png".into(),
            },
            "items",
        )
        .await
        .expect_err("no session");
    assert_missing_session(&error, &transport);

    let (transfer, transport) = signed_out_transfer();
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("p1.bin");
    let error = transfer
        .download(&object_target(), &dest.to_string_lossy(), None)
        .await
        .expect_err("no session");
    assert_missing_session(&error, &transport);
    assert!(!dest.exists(), "a refused download must not write bytes");

    let (transfer, transport) = signed_out_transfer();
    let error = transfer
        .remove(&object_target())
        .await
        .expect_err("no session");
    assert_missing_session(&error, &transport);
}

#[tokio::test]
async fn the_creation_token_is_sent_until_a_new_one_replaces_it() {
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);

    transfer
        .upload_single_shot(&target(), b"a")
        .await
        .expect("creation token");
    transfer.set_access_token(Some("jwt-2".into()));
    transfer
        .upload_single_shot(&target(), b"b")
        .await
        .expect("replacement token");

    let requests = transport.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].header("Authorization"), Some("Bearer tok"));
    assert_eq!(requests[1].header("Authorization"), Some("Bearer jwt-2"));
}

#[tokio::test]
async fn storage_object_urls_percent_encode_every_path_segment() {
    fn assert_encoded(url: &str) {
        assert!(url.contains("/media/user%20a/p%231/img.png"), "{url}");
        assert!(!url.contains(' ') && !url.contains('#'), "{url}");
    }

    let upload_target = UploadTarget {
        bucket: "media".into(),
        path: "user a/p#1/img.png".into(),
        content_type: "image/png".into(),
    };
    let object = ObjectTarget {
        bucket: upload_target.bucket.clone(),
        path: upload_target.path.clone(),
    };

    let ok = || {
        Arc::new(FakeTransport::new(|_| {
            Ok(HttpResponse {
                status: 200,
                headers: Vec::new(),
                // An empty signedURL sends `fetch_object_bytes` down the direct-GET fallback.
                body: br#"{"signedURL":""}"#.to_vec(),
            })
        }))
    };

    let transport = ok();
    TusTransfer::with_transport(config(), transport.clone())
        .upload_single_shot(&upload_target, b"x")
        .await
        .expect("single shot");
    assert_encoded(&transport.requests()[0].url);

    let transport = ok();
    TusTransfer::with_transport(config(), transport.clone())
        .remove(&object)
        .await
        .expect("remove");
    let deleted = transport
        .requests()
        .into_iter()
        .find(|r| r.method == HttpMethod::Delete)
        .expect("a DELETE");
    assert_encoded(&deleted.url);

    let transport = ok();
    TusTransfer::with_transport(config(), transport.clone())
        .fetch_object_bytes(&object)
        .await
        .expect("fetch");
    let requests = transport.requests();
    assert_eq!(requests[0].method, HttpMethod::Post);
    assert!(
        requests[0].url.contains("/object/sign/"),
        "{}",
        requests[0].url
    );
    assert_encoded(&requests[0].url);
    assert_eq!(requests[1].method, HttpMethod::Get);
    assert_encoded(&requests[1].url);
}

#[tokio::test]
async fn confirm_posts_the_attachment_confirm_rpc() {
    let transport = Arc::new(FakeTransport::new(|_| {
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: b"{}".to_vec(),
        })
    }));
    let transfer = TusTransfer::with_transport(
        config().with_publishable_key("pub-key-1"),
        transport.clone(),
    );
    transfer
        .confirm(
            &ObjectTarget {
                bucket: "media".into(),
                path: "u1/p1.bin".into(),
            },
            &ConfirmMeta {
                sha256: "abc".into(),
                size: 4,
                content_type: "image/png".into(),
            },
            "items",
        )
        .await
        .expect("confirm");
    let request = &transport.requests()[0];
    assert_eq!(
        request.url,
        "https://abc.supabase.co/rest/v1/rpc/attachment_confirm"
    );
    assert_eq!(request.header("Authorization"), Some("Bearer tok"));
    assert_eq!(request.header("apikey"), Some("pub-key-1"));
    assert_eq!(request.header("Content-Profile"), Some("kizunasync"));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "p_bucket": "media",
            "p_path": "u1/p1.bin",
            "p_sha256": "abc",
            "p_size": 4,
            "p_media_type": "image/png",
            "p_table": "items",
        })
    );
    assert_eq!(request.timeout, None);
}

#[tokio::test]
async fn download_writes_signed_bytes_and_verifies_sha256() {
    let bytes = b"png-bytes";
    let transport = Arc::new(FakeTransport::new(move |request| {
        if request.method == HttpMethod::Post {
            // Storage answers the signed path relative to its own base, which
            // supabase-js builds as `<project>/storage/v1`.
            return Ok(json_response(
                200,
                r#"{"signedURL":"/object/sign/media/u1/p1.bin?token=t0k"}"#,
            ));
        }
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: bytes.to_vec(),
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("p1.bin");
    transfer
        .download(
            &ObjectTarget {
                bucket: "media".into(),
                path: "u1/p1.bin".into(),
            },
            dest.to_str().unwrap(),
            Some(&sha256_hex(bytes)),
        )
        .await
        .expect("download");
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);

    let requests = transport.requests();
    assert_eq!(
        requests[0].url,
        "https://abc.supabase.co/storage/v1/object/sign/media/u1/p1.bin"
    );
    assert_eq!(requests[0].timeout, None);
    let fetch = &requests[1];
    assert_eq!(fetch.method, HttpMethod::Get);
    assert_eq!(
        fetch.url,
        "https://abc.supabase.co/storage/v1/object/sign/media/u1/p1.bin?token=t0k"
    );
    assert_eq!(fetch.timeout, Some(DEFAULT_BYTES_TIMEOUT));
    assert!(
        fetch.headers.is_empty(),
        "the signed URL is the credential; the fetch sends no other"
    );
}

#[tokio::test]
async fn download_refuses_bytes_that_miss_the_expected_sha256() {
    let (transfer, _) = signing_transfer("/object/sign/media/u1/p1.bin?token=t0k", b"tampered");
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("p1.bin");

    let error = transfer
        .download(
            &object_target(),
            dest.to_str().unwrap(),
            Some(&sha256_hex(b"png-bytes")),
        )
        .await
        .expect_err("the bytes miss the expected hash");

    assert_eq!(
        error,
        TransferError::HashMismatch {
            path: "u1/p1.bin".into()
        }
    );
    assert!(!dest.exists(), "refused bytes must never be written");
}

#[tokio::test]
async fn download_maps_a_404_to_not_yet_available() {
    let transport = Arc::new(FakeTransport::new(|_| Ok(empty(404, Vec::new()))));
    let transfer = TusTransfer::with_transport(config(), transport);
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("p1.bin");

    let error = transfer
        .download(&object_target(), dest.to_str().unwrap(), None)
        .await
        .expect_err("the object is not on Storage yet");

    assert_eq!(error, TransferError::NotYetAvailable);
    assert!(
        !dest.exists(),
        "a not-yet-available download must not write bytes"
    );
}

/// A transfer whose sign call answers `signed_url` and whose every GET answers
/// `bytes`.
fn signing_transfer(signed_url: &str, bytes: &'static [u8]) -> (TusTransfer, Arc<FakeTransport>) {
    let signed = serde_json::json!({ "signedURL": signed_url }).to_string();
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(if request.method == HttpMethod::Post {
            json_response(200, &signed)
        } else {
            HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: bytes.to_vec(),
            }
        })
    }));
    (
        TusTransfer::with_transport(config(), transport.clone()),
        transport,
    )
}

/// Storage returns the signed path as it stored the key, unescaped, so every
/// segment is escaped before the path goes on the wire.
#[tokio::test]
async fn a_signed_path_is_percent_encoded_segment_by_segment() {
    let (transfer, transport) =
        signing_transfer("/object/sign/media/user a/p(1)/img.png?token=t0k", b"x");

    transfer
        .fetch_object_bytes(&ObjectTarget {
            bucket: "media".into(),
            path: "user a/p(1)/img.png".into(),
        })
        .await
        .expect("fetch");

    assert_eq!(
        transport.requests()[1].url,
        "https://abc.supabase.co/storage/v1/object/sign/media/user%20a/p%281%29/img.png?token=t0k"
    );
}

#[tokio::test]
async fn an_absolute_signed_url_on_the_project_origin_is_fetched_as_is() {
    let url = "https://abc.supabase.co/storage/v1/object/sign/media/u1/p1.bin?token=t0k";
    let (transfer, transport) = signing_transfer(url, b"x");

    transfer
        .fetch_object_bytes(&object_target())
        .await
        .expect("fetch");

    assert_eq!(transport.requests()[1].url, url);
}

#[tokio::test]
async fn an_absolute_signed_url_off_the_project_origin_is_refused() {
    for url in [
        "https://evil.example/storage/v1/object/sign/media/u1/p1.bin?token=t0k",
        "http://abc.supabase.co/storage/v1/object/sign/media/u1/p1.bin?token=t0k",
    ] {
        let (transfer, transport) = signing_transfer(url, b"x");

        let error = transfer
            .fetch_object_bytes(&object_target())
            .await
            .expect_err("a signed URL off the project origin");

        assert_eq!(error, TransferError::OriginMismatch, "{url}");
        assert_eq!(transport.requests().len(), 1, "{url} must never be fetched");
    }
}

#[tokio::test]
async fn metadata_reads_the_attachment_metadata_rpc() {
    let transport = Arc::new(FakeTransport::new(|_| {
        Ok(json_response(
            200,
            r#"[{"sha256":"abc","size":4,"media_type":"image/png","created_at":null,"updated_at":null}]"#,
        ))
    }));
    let transfer = TusTransfer::with_transport(
        config().with_publishable_key("pub-key-1"),
        transport.clone(),
    );

    let sha = transfer.metadata(&object_target()).await.expect("metadata");

    assert_eq!(sha.as_deref(), Some("abc"));
    let request = &transport.requests()[0];
    assert_eq!(request.method, HttpMethod::Post);
    assert_eq!(
        request.url,
        "https://abc.supabase.co/rest/v1/rpc/attachment_metadata"
    );
    assert_eq!(request.header("Authorization"), Some("Bearer tok"));
    assert_eq!(request.header("apikey"), Some("pub-key-1"));
    assert_eq!(request.header("Content-Profile"), Some("kizunasync"));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "p_bucket_id": "media", "p_object_path": "u1/p1.bin" })
    );
}

#[tokio::test]
async fn metadata_answers_none_when_the_rpc_returns_no_row() {
    let transport = Arc::new(FakeTransport::new(|_| Ok(json_response(200, "[]"))));
    let transfer = TusTransfer::with_transport(config(), transport);

    assert_eq!(
        transfer.metadata(&object_target()).await.expect("metadata"),
        None
    );
}

#[tokio::test]
async fn object_bytes_travel_under_the_bytes_deadline_and_control_requests_do_not() {
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);

    transfer
        .upload_single_shot(&target(), b"small")
        .await
        .expect("single shot");
    transfer
        .upload_resumable(&target(), &[5_u8; 64], 0, None)
        .await
        .expect("resumable");

    let requests = transport.requests();
    let single_shot = &requests[0];
    assert_eq!(single_shot.timeout, Some(DEFAULT_BYTES_TIMEOUT));
    for request in &requests[1..] {
        let expected = (request.method == HttpMethod::Patch).then_some(DEFAULT_BYTES_TIMEOUT);
        assert_eq!(request.timeout, expected, "{:?}", request.method);
    }
    assert!(requests.iter().any(|r| r.method == HttpMethod::Patch));
}

#[tokio::test]
async fn a_refused_offset_probe_drops_the_persisted_session() {
    let transport = Arc::new(FakeTransport::new(|request| {
        Ok(match request.method {
            HttpMethod::Head => json_response(403, r#"{"message":"forbidden"}"#),
            HttpMethod::Get | HttpMethod::Post | HttpMethod::Patch | HttpMethod::Delete => {
                empty(500, Vec::new())
            }
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());
    let key = TusTransfer::session_key(&target());
    transfer.remember_session(&key, UPLOAD_URL);

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 40, Some(UPLOAD_URL))
        .await
        .expect_err("the host refused the session");

    assert!(
        matches!(&error, TransferError::SessionRefused { status: 403, .. }),
        "{error}"
    );
    let methods: Vec<HttpMethod> = transport.requests().iter().map(|r| r.method).collect();
    assert_eq!(methods, vec![HttpMethod::Head]);
    assert_eq!(transfer.remembered_session(&key), None);
}

#[tokio::test]
async fn a_server_error_on_the_offset_probe_carries_its_status() {
    let transport = Arc::new(FakeTransport::new(|_| Ok(empty(503, Vec::new()))));
    let transfer = TusTransfer::with_transport(config(), transport);

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 40, Some(UPLOAD_URL))
        .await
        .expect_err("the host is down");

    assert!(
        matches!(&error, TransferError::Http { status: 503, .. }),
        "{error}"
    );
}

#[tokio::test]
async fn a_refused_re_probe_after_a_conflict_drops_the_session() {
    let heads = Arc::new(Mutex::new(0_u32));
    let handler_heads = Arc::clone(&heads);
    let transport = Arc::new(FakeTransport::new(move |request| {
        Ok(match request.method {
            HttpMethod::Head => {
                let mut count = handler_heads.lock().unwrap();
                *count += 1;
                if *count == 1 {
                    empty(200, session_head(0, 100))
                } else {
                    empty(403, Vec::new())
                }
            }
            HttpMethod::Patch => empty(409, Vec::new()),
            HttpMethod::Get | HttpMethod::Post | HttpMethod::Delete => empty(405, Vec::new()),
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let error = transfer
        .upload_resumable(&target(), &[1_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect_err("the re-probe is refused");

    assert!(
        matches!(&error, TransferError::SessionRefused { status: 403, .. }),
        "{error}"
    );
}

/// A session URL persisted on another origin would take the user's token
/// there, so it is never probed: a fresh session replaces it.
#[tokio::test]
async fn a_persisted_session_on_another_origin_is_replaced_by_a_new_one() {
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);

    let progress = transfer
        .upload_resumable(
            &target(),
            &[4_u8; 30],
            10,
            Some("https://evil.example/upload/resumable/stolen"),
        )
        .await
        .expect("a new session");

    assert_eq!(progress.tus_url.as_deref(), Some(UPLOAD_URL));
    assert_eq!(progress.bytes_uploaded, 30);
    assert!(
        transport
            .requests()
            .iter()
            .all(|r| !r.url.contains("evil.example")),
        "the foreign session must never be contacted"
    );
}

/// A session created for other bytes cannot take these: its declared length
/// is the proof, so a mismatch starts a new session from zero.
#[tokio::test]
async fn a_persisted_session_of_another_length_is_replaced_by_a_new_one() {
    let server = FakeTusServer::holding_a_session_of(99);
    let (transfer, transport) = transfer_against(&server);

    let progress = transfer
        .upload_resumable(&target(), &[4_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect("a new session");

    assert_eq!(progress.bytes_uploaded, 100);
    let create = transport
        .requests()
        .into_iter()
        .find(|r| r.method == HttpMethod::Post)
        .expect("a new session is created");
    assert_eq!(create.header("Upload-Length"), Some("100"));
}

#[tokio::test]
async fn a_persisted_session_that_declares_no_length_is_replaced_by_a_new_one() {
    let server = FakeTusServer::new(None);
    let (transfer, transport) = transfer_against(&server);

    transfer
        .upload_resumable(&target(), &[4_u8; 100], 0, Some(UPLOAD_URL))
        .await
        .expect("a new session");

    assert!(
        transport
            .requests()
            .iter()
            .any(|r| r.method == HttpMethod::Post)
    );
}

#[tokio::test]
async fn a_request_past_its_deadline_is_a_typed_timeout() {
    let transport = Arc::new(FakeTransport::new(|_| {
        Err(HttpError::Timeout("operation timed out".into()))
    }));
    let transfer = TusTransfer::with_transport(config(), transport);

    let error = transfer
        .confirm(
            &object_target(),
            &ConfirmMeta {
                sha256: "abc".into(),
                size: 4,
                content_type: "image/png".into(),
            },
            "items",
        )
        .await
        .expect_err("the confirm timed out");

    assert!(matches!(&error, TransferError::TimedOut { .. }), "{error}");
}

#[tokio::test]
async fn a_finished_upload_forgets_its_session() {
    let server = FakeTusServer::new(None);
    let (transfer, _) = transfer_against(&server);

    transfer
        .upload_resumable(&target(), &[6_u8; 64], 0, None)
        .await
        .expect("upload");

    assert_eq!(
        transfer.remembered_session(&TusTransfer::session_key(&target())),
        None
    );
}

#[tokio::test]
async fn an_interrupted_upload_keeps_its_session_for_the_retry() {
    let server = FakeTusServer::new(Some(40));
    let (transfer, _) = transfer_against(&server);

    transfer
        .upload_resumable(&target(), &[6_u8; 100], 0, None)
        .await
        .expect_err("the server dies mid-chunk");

    assert_eq!(
        transfer
            .remembered_session(&TusTransfer::session_key(&target()))
            .as_deref(),
        Some(UPLOAD_URL)
    );
}

#[test]
fn a_tus_config_debug_hides_the_token_and_the_key() {
    let config = TusConfig::new("https://abc.supabase.co", "user-jwt-secret")
        .with_publishable_key("publishable-secret");

    let debug = format!("{config:?}");

    assert!(!debug.contains("user-jwt-secret"), "{debug}");
    assert!(!debug.contains("publishable-secret"), "{debug}");
    assert!(debug.contains("https://abc.supabase.co"), "{debug}");
}

#[test]
fn a_signed_url_response_debug_hides_the_signed_url() {
    let response: SignedUrlResponse = serde_json::from_str(
        r#"{"signedURL":"/object/sign/media/u1/p1.png?token=signed-url-secret"}"#,
    )
    .expect("sign response");

    let debug = format!("{response:?}");

    assert!(!debug.contains("signed-url-secret"), "{debug}");
    assert!(!debug.contains("/object/sign/media"), "{debug}");
    assert!(debug.contains("signed_url"), "{debug}");
}

#[test]
fn the_live_transfer_refuses_a_plain_http_url() {
    let plain_project = TusConfig::new("http://abc.supabase.co", "tok");
    let mut plain_endpoint = TusConfig::new("https://abc.supabase.co", "tok");
    plain_endpoint.tus_endpoint =
        "http://abc.storage.supabase.co/storage/v1/upload/resumable".into();

    for config in [plain_project, plain_endpoint] {
        assert!(
            matches!(TusTransfer::new(config), Err(HttpError::Config(_))),
            "a plain http URL must be refused"
        );
    }
    assert!(TusTransfer::new(TusConfig::new("http://127.0.0.1:54321", "tok")).is_ok());
    assert!(TusTransfer::new(TusConfig::new("http://192.168.3.235:54321", "tok")).is_ok());
    assert!(TusTransfer::new(TusConfig::new("https://abc.supabase.co", "tok")).is_ok());
}

// MARK: - The status Storage means

/// Storage answers most refusals with HTTP 400 and names the status it means
/// in the body, the way the local stack does.
fn storage_refusal(status_code: &str, code: &str) -> HttpResponse {
    json_response(
        400,
        &serde_json::json!({ "statusCode": status_code, "code": code, "error": code, "message": "refused" })
            .to_string(),
    )
}

/// A transfer whose every request Storage answers with `response`.
fn answering(response: HttpResponse) -> TusTransfer {
    let transport = Arc::new(FakeTransport::new(move |_| Ok(response.clone())));
    TusTransfer::with_transport(config(), transport)
}

#[tokio::test]
async fn a_download_refused_with_a_body_carried_404_is_not_yet_available() {
    let dir = tempfile::tempdir().expect("temp dir");
    let dest = dir.path().join("p1.bin");

    for refusal in [
        storage_refusal("404", "not_found"),
        storage_refusal("400", "NoSuchKey"),
    ] {
        let error = answering(refusal)
            .download(&object_target(), dest.to_str().unwrap(), None)
            .await
            .expect_err("the object is not on Storage yet");

        assert_eq!(error, TransferError::NotYetAvailable);
    }
    assert!(!dest.exists());
}

#[tokio::test]
async fn an_upload_refused_with_a_body_carried_401_is_a_session_refusal() {
    for refusal in [
        storage_refusal("401", "Unauthorized"),
        storage_refusal("400", "InvalidJWT"),
    ] {
        let error = answering(refusal)
            .upload_single_shot(&target(), b"small")
            .await
            .expect_err("the session is refused");

        assert_eq!(error.status(), Some(401), "{error}");
    }
}

#[tokio::test]
async fn a_body_carried_status_replaces_the_400_on_every_storage_refusal() {
    let upload = answering(storage_refusal("403", "AccessDenied"))
        .upload_single_shot(&target(), b"small")
        .await
        .expect_err("refused");
    let create = answering(storage_refusal("403", "AccessDenied"))
        .upload_resumable(&target(), &[1_u8; 32], 0, None)
        .await
        .expect_err("refused");
    let remove = answering(storage_refusal("403", "AccessDenied"))
        .remove(&object_target())
        .await
        .expect_err("refused");

    for error in [upload, create, remove] {
        assert!(
            matches!(&error, TransferError::Http { status: 403, .. }),
            "{error}"
        );
    }
}

#[tokio::test]
async fn a_refusal_without_a_body_status_keeps_the_http_status() {
    let error = answering(json_response(400, "not json"))
        .upload_single_shot(&target(), b"small")
        .await
        .expect_err("refused");

    assert!(
        matches!(&error, TransferError::Http { status: 400, .. }),
        "{error}"
    );
}

/// A removal of an object Storage no longer holds has nothing left to do, so
/// it goes on to the vacuum RPC.
#[tokio::test]
async fn a_removal_of_an_object_already_gone_succeeds() {
    let transport = Arc::new(FakeTransport::new(|request| {
        Ok(if request.method == HttpMethod::Delete {
            storage_refusal("404", "not_found")
        } else {
            json_response(200, "null")
        })
    }));
    let transfer = TusTransfer::with_transport(config(), transport.clone());

    transfer
        .remove(&object_target())
        .await
        .expect("an object already gone is removed");

    let methods: Vec<HttpMethod> = transport.requests().iter().map(|r| r.method).collect();
    assert_eq!(methods, vec![HttpMethod::Delete, HttpMethod::Post]);
}
