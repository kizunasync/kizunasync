//! `Transfer` over Supabase Storage: single-shot under the threshold, TUS
//! resumable above.
//!
//! The Rust twin of `packages/supabase/src/tus-client.ts` +
//! `transfer-supabase.ts`. The TUS subset Supabase documents:
//! - endpoint `{supabaseUrl}/storage/v1/upload/resumable`
//! - chunk size MUST be 6 MiB
//! - metadata `bucketName, objectName, contentType, cacheControl`
//! - auth: `Bearer` access token, optional `x-upsert`

use async_trait::async_trait;
use kizunasync_transfer::{
    ConfirmMeta, DEFAULT_SINGLE_SHOT_MAX_BYTES, ObjectTarget, TUS_CHUNK_SIZE, Transfer,
    TransferError, UploadProgress, UploadTarget, atomic_write, sha256_hex,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::auth::{AccessToken, supabase_http_headers};
use crate::base64;
use crate::rpc::DEFAULT_SCHEMA;
use crate::transport::{
    DEFAULT_BYTES_TIMEOUT, HttpError, HttpMethod, HttpRequest, HttpResponse, HttpTransport,
    ReqwestTransport, require_secure_url,
};

const TUS_RESUMABLE: &str = "1.0.0";
const OFFSET_CONTENT_TYPE: &str = "application/offset+octet-stream";

/// How many 409 conflicts in a row a chunk may draw while the server's own
/// offset stands still. A server that keeps refusing the offset it just
/// reported never converges, so past this budget the session goes back to the
/// caller as resume state rather than being re-PATCHed for as long as the
/// process lives. A 409 whose HEAD shows progress is the protocol working and
/// spends none of the budget.
const TUS_MAX_OFFSET_CONFLICTS: u32 = 5;

/// Resolve a TUS `Location` against the create endpoint. Absolute URLs on a
/// different origin are refused: later PATCH sends the user JWT there.
fn resolve_tus_location(endpoint: &str, location: &str) -> Result<String, TransferError> {
    let base = reqwest::Url::parse(endpoint)
        .map_err(|e| TransferError::Failed(format!("tus create bad endpoint: {e}")))?;
    let resolved = if location.starts_with("https://") || location.starts_with("http://") {
        reqwest::Url::parse(location)
    } else {
        reqwest::Url::parse(&base.origin().ascii_serialization())
            .and_then(|origin| origin.join(location))
    }
    .map_err(|e| TransferError::Protocol {
        detail: format!("tus create bad Location: {e}"),
    })?;

    if resolved.scheme() != base.scheme()
        || resolved.host_str() != base.host_str()
        || resolved.port_or_known_default() != base.port_or_known_default()
    {
        return Err(TransferError::OriginMismatch);
    }

    Ok(resolved.to_string())
}

/// Derive the Storage TUS endpoint from a project URL, preferring the
/// `project-ref.storage.supabase.co` host Supabase serves resumable uploads from.
#[must_use]
pub fn tus_endpoint_from_supabase_url(supabase_url: &str) -> String {
    let base = supabase_url.trim_end_matches('/');
    if let Ok(url) = reqwest::Url::parse(base)
        && let Some(host) = url.host_str()
        && host.ends_with(".supabase.co")
        && !host.contains(".storage.")
    {
        let reference = host.trim_end_matches(".supabase.co");
        return format!("https://{reference}.storage.supabase.co/storage/v1/upload/resumable");
    }

    format!("{base}/storage/v1/upload/resumable")
}

/// Everything the Storage adapter needs to address one project's uploads. Its
/// `Debug` output leaves the token and the key out.
#[derive(Clone)]
pub struct TusConfig {
    /// Project URL, e.g. `https://abc.supabase.co`, the single-shot Storage host.
    pub storage_url: String,
    /// Resumable endpoint; defaults to [`tus_endpoint_from_supabase_url`].
    pub tus_endpoint: String,
    /// User JWT (or the project key for a public-bucket demo path).
    pub access_token: String,
    /// Project publishable key. storage-js sends it as the `apikey` header
    /// alongside the bearer token on object uploads; Kong routinely rejects a
    /// user-JWT bearer without it, so the single-shot path needs it for parity.
    pub publishable_key: Option<String>,
    /// Whether an upload replaces an object that already exists.
    pub upsert: bool,
    /// The `Cache-Control` max age recorded with the object, in seconds.
    pub cache_control: String,
    /// Payloads at or under this go single-shot. Supabase's policy is 6 MiB;
    /// tests lower it to avoid allocating megabytes.
    pub single_shot_max_bytes: u64,
}

impl TusConfig {
    /// A config for one project, with the resumable endpoint derived from
    /// `supabase_url` and Supabase's own defaults for the rest.
    #[must_use]
    pub fn new(supabase_url: impl Into<String>, access_token: impl Into<String>) -> Self {
        let storage_url = supabase_url.into();
        let tus_endpoint = tus_endpoint_from_supabase_url(&storage_url);
        Self {
            storage_url,
            tus_endpoint,
            access_token: access_token.into(),
            publishable_key: None,
            upsert: true,
            cache_control: "3600".to_string(),
            single_shot_max_bytes: DEFAULT_SINGLE_SHOT_MAX_BYTES,
        }
    }

    /// Send the publishable key as the `apikey` header beside the bearer token.
    #[must_use]
    pub fn with_publishable_key(mut self, publishable_key: impl Into<String>) -> Self {
        self.publishable_key = Some(publishable_key.into());
        self
    }

    /// Move the threshold above which an upload takes the resumable path.
    #[must_use]
    pub const fn with_single_shot_max_bytes(mut self, max_bytes: u64) -> Self {
        self.single_shot_max_bytes = max_bytes;
        self
    }
}

impl fmt::Debug for TusConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TusConfig")
            .field("storage_url", &self.storage_url)
            .field("tus_endpoint", &self.tus_endpoint)
            .field("access_token", &"<redacted>")
            .field(
                "publishable_key",
                &self.publishable_key.as_ref().map(|_| "<redacted>"),
            )
            .field("upsert", &self.upsert)
            .field("cache_control", &self.cache_control)
            .field("single_shot_max_bytes", &self.single_shot_max_bytes)
            .finish()
    }
}

/// What a HEAD on a session URL says about continuing it.
enum HeadOutcome {
    /// The session is live and holds this many bytes.
    Offset(u64),
    /// The session cannot take these bytes: the host no longer has it
    /// (404/410), or it declares a length other than the object's. The
    /// upload is created again from zero.
    Unusable,
}

/// The Supabase Storage [`Transfer`] adapter: single-shot below the threshold,
/// resumable TUS above it.
pub struct TusTransfer {
    config: TusConfig,
    access_token: AccessToken,
    transport: Arc<dyn HttpTransport>,
    /// `bucket/path` -> TUS upload URL. The durable copy lives in the store
    /// (`_kizunasync_attachments.tus_url`); this is the in-process fingerprint that
    /// survives a retry inside one run, mirroring `FakeTransfer.tus_sessions`.
    sessions: Mutex<HashMap<String, String>>,
}

impl TusTransfer {
    /// Binds `config` to a live `reqwest` client.
    ///
    /// # Errors
    /// [`HttpError::Config`] when the Storage URL or the resumable endpoint is
    /// not `https` (plain `http` is accepted on a loopback or local-network
    /// host only), or an error when the HTTP client cannot be built (TLS
    /// backend initialisation).
    pub fn new(config: TusConfig) -> Result<Self, HttpError> {
        require_secure_url(&config.storage_url, "remote.url")?;
        require_secure_url(&config.tus_endpoint, "the resumable upload endpoint")?;
        let transport = Arc::new(ReqwestTransport::new()?);
        Ok(Self::with_transport(config, transport))
    }

    /// The same adapter over a caller-supplied transport, which is how the tests
    /// drive it without a network. The URL rule of [`Self::new`] is the
    /// injector's to enforce.
    #[must_use]
    pub fn with_transport(config: TusConfig, transport: Arc<dyn HttpTransport>) -> Self {
        let access_token = AccessToken::new(Some(config.access_token.clone()));
        Self {
            config,
            access_token,
            transport,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// The token every Storage call must carry. There is no fallback to the
    /// creation-time JWT: once a sign-out clears the slot, a transfer fails
    /// loud with [`TransferError::Unauthorized`] instead of reusing a revoked
    /// session.
    fn bearer(&self) -> Result<String, TransferError> {
        self.access_token.get().ok_or(TransferError::Unauthorized)
    }

    fn publishable_key(&self) -> Option<&str> {
        self.config.publishable_key.as_deref()
    }

    fn auth_headers(&self, upsert: bool) -> Result<Vec<(String, String)>, TransferError> {
        let mut headers = supabase_http_headers(&self.bearer()?, self.publishable_key());
        headers.push(("Tus-Resumable".into(), TUS_RESUMABLE.into()));
        if upsert {
            headers.push(("x-upsert".into(), "true".into()));
        }
        Ok(headers)
    }

    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransferError> {
        self.transport
            .execute(request)
            .await
            .map_err(transfer_error)
    }

    /// The transport result before classification. Only [`Self::patch_all`] wants
    /// it: there a request that produced no HTTP response at all is a mid-flight
    /// network loss with durable resume state, not a failed transfer.
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        self.transport.execute(request).await
    }

    fn head_request(&self, upload_url: &str) -> Result<HttpRequest, TransferError> {
        Ok(HttpRequest {
            method: HttpMethod::Head,
            url: upload_url.to_string(),
            headers: self.auth_headers(false)?,
            body: Vec::new(),
            timeout: None,
        })
    }

    /// Reads a HEAD on a session that should hold `total` bytes. Any other
    /// client error than 404/410 is a refusal of the session itself, so the
    /// caller drops its URL; a server error is an ordinary HTTP failure.
    fn head_outcome(response: &HttpResponse, total: u64) -> Result<HeadOutcome, TransferError> {
        let status = storage_status(response);
        if status == 404 || status == 410 {
            return Ok(HeadOutcome::Unusable);
        }
        if (400..500).contains(&status) {
            return Err(TransferError::SessionRefused {
                status,
                detail: format!("tus HEAD refused: {}", response.text()),
            });
        }
        if !response.is_success() {
            return Err(TransferError::Http {
                status,
                detail: format!("tus HEAD failed: {}", response.text()),
            });
        }
        // TUS requires `Upload-Offset` on every successful HEAD; its absence or
        // a non-numeric value is the server breaking the protocol, not a state
        // this adapter can guess at (defaulting to 0 would silently restart the
        // upload with no diagnostic of why).
        let offset = response
            .header("Upload-Offset")
            .ok_or_else(|| TransferError::Protocol {
                detail: "tus HEAD answered without an Upload-Offset header".to_owned(),
            })?
            .parse::<u64>()
            .map_err(|cause| TransferError::Protocol {
                detail: format!("tus HEAD answered a non-numeric Upload-Offset: {cause}"),
            })?;

        // The declared length is what ties a session to these bytes: a session
        // created for another object, or one that does not say, cannot be
        // continued with them.
        let declared = response
            .header("Upload-Length")
            .and_then(|value| value.parse::<u64>().ok());
        if declared != Some(total) {
            return Ok(HeadOutcome::Unusable);
        }

        Ok(HeadOutcome::Offset(offset))
    }

    async fn head_offset(
        &self,
        upload_url: &str,
        total: u64,
    ) -> Result<HeadOutcome, TransferError> {
        let response = self.send(self.head_request(upload_url)?).await?;
        Self::head_outcome(&response, total)
    }

    async fn create(&self, target: &UploadTarget, size: u64) -> Result<String, TransferError> {
        let metadata = [
            ("bucketName", target.bucket.as_str()),
            ("objectName", target.path.as_str()),
            ("contentType", target.content_type.as_str()),
            ("cacheControl", self.config.cache_control.as_str()),
        ]
        .iter()
        .map(|(key, value)| format!("{key} {}", base64::encode(value.as_bytes())))
        .collect::<Vec<_>>()
        .join(",");

        let mut headers = self.auth_headers(self.config.upsert)?;
        headers.push(("Upload-Length".into(), size.to_string()));
        headers.push(("Upload-Metadata".into(), metadata));
        headers.push(("Content-Type".into(), OFFSET_CONTENT_TYPE.into()));

        let response = self
            .send(HttpRequest {
                method: HttpMethod::Post,
                url: self.config.tus_endpoint.clone(),
                headers,
                body: Vec::new(),
                timeout: None,
            })
            .await?;
        if !response.is_success() {
            return Err(TransferError::Http {
                status: storage_status(&response),
                detail: format!("tus create refused: {}", response.text()),
            });
        }

        let location = response.header("Location").unwrap_or_default();
        if location.is_empty() {
            return Err(TransferError::Protocol {
                detail: "tus create answered without a Location header".into(),
            });
        }

        resolve_tus_location(&self.config.tus_endpoint, location)
    }

    /// PATCH successive 6 MiB chunks until the object is complete.
    ///
    /// A transport-class failure, where the request produced no HTTP response
    /// because the network went away under a live session, surfaces as
    /// [`TransferError::Interrupted`] carrying the last offset the server
    /// confirmed and the session URL, which is what makes a kill mid-flight
    /// resumable instead of a full re-upload. So does a run of
    /// [`TUS_MAX_OFFSET_CONFLICTS`] conflicts over an offset that never moves:
    /// the session is live and the durable resume state belongs to the caller.
    /// A refusal the server chose is [`TransferError::Http`], a session the
    /// server has dropped is [`TransferError::SessionExpired`], a re-probe the
    /// server refuses is [`TransferError::SessionRefused`], and a response
    /// that breaks the TUS contract is [`TransferError::Protocol`].
    async fn patch_all(
        &self,
        upload_url: &str,
        bytes: &[u8],
        start_offset: u64,
    ) -> Result<u64, TransferError> {
        let total = bytes.len() as u64;
        let mut offset = start_offset.min(total);
        let mut conflicts: u32 = 0;
        while offset < total {
            let end = (offset + TUS_CHUNK_SIZE).min(total);
            let chunk = slice(bytes, offset, end)?;
            let mut headers = self.auth_headers(false)?;
            headers.push(("Content-Type".into(), OFFSET_CONTENT_TYPE.into()));
            headers.push(("Upload-Offset".into(), offset.to_string()));
            headers.push(("Content-Length".into(), chunk.len().to_string()));

            let patched = self
                .execute(HttpRequest {
                    method: HttpMethod::Patch,
                    url: upload_url.to_string(),
                    headers,
                    body: chunk.to_vec(),
                    timeout: Some(DEFAULT_BYTES_TIMEOUT),
                })
                .await;

            let Ok(response) = patched else {
                return Err(interrupted_at(offset, upload_url));
            };

            let status = storage_status(&response);
            if status == 409 {
                // Offset conflict: re-HEAD and continue from the server's truth.
                let Ok(head) = self.execute(self.head_request(upload_url)?).await else {
                    return Err(interrupted_at(offset, upload_url));
                };
                match Self::head_outcome(&head, total)? {
                    HeadOutcome::Offset(server_offset) => {
                        if server_offset > total {
                            return Err(TransferError::Protocol {
                                detail: format!(
                                    "tus HEAD reported offset {server_offset} beyond the object's {total} bytes"
                                ),
                            });
                        }
                        let advanced = server_offset > offset;
                        offset = server_offset;
                        if advanced {
                            conflicts = 0;
                        } else {
                            conflicts += 1;
                            if conflicts > TUS_MAX_OFFSET_CONFLICTS {
                                return Err(interrupted_at(offset, upload_url));
                            }
                        }
                    }
                    HeadOutcome::Unusable => return Err(TransferError::SessionExpired),
                }
                continue;
            }

            if !response.is_success() {
                return Err(TransferError::Http {
                    status,
                    detail: format!("tus PATCH refused at offset {offset}: {}", response.text()),
                });
            }

            // TUS requires `Upload-Offset` on a successful PATCH; assuming `end`
            // (full chunk accepted) when it is missing or malformed would let a
            // server that silently truncated the write report success here, and
            // the client would believe bytes were durably stored that were not.
            let advanced = response
                .header("Upload-Offset")
                .ok_or_else(|| TransferError::Protocol {
                    detail: "tus PATCH answered without an Upload-Offset header".to_owned(),
                })?
                .parse::<u64>()
                .map_err(|cause| TransferError::Protocol {
                    detail: format!("tus PATCH answered a non-numeric Upload-Offset: {cause}"),
                })?;
            if advanced <= offset {
                return Err(TransferError::Protocol {
                    detail: format!("tus PATCH did not advance the offset past {offset}"),
                });
            }

            conflicts = 0;
            offset = advanced;
        }
        Ok(offset)
    }

    fn session_key(target: &UploadTarget) -> String {
        format!("{}/{}", target.bucket, target.path)
    }

    fn remembered_session(&self, key: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(key)
            .cloned()
    }

    fn remember_session(&self, key: &str, url: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.to_string(), url.to_string());
    }

    /// Forget a session that finished or can no longer be continued, so the
    /// map holds only uploads a retry in this process could still resume.
    fn forget_session(&self, key: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key);
    }

    fn project_url(&self) -> &str {
        self.config.storage_url.trim_end_matches('/')
    }

    fn rpc_headers(&self) -> Result<Vec<(String, String)>, TransferError> {
        let mut headers = supabase_http_headers(&self.bearer()?, self.publishable_key());
        headers.extend([
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
            ("Content-Profile".into(), DEFAULT_SCHEMA.into()),
            ("Accept-Profile".into(), DEFAULT_SCHEMA.into()),
        ]);
        Ok(headers)
    }

    async fn rpc_json(
        &self,
        function: &str,
        body: serde_json::Value,
    ) -> Result<HttpResponse, TransferError> {
        let headers = self.rpc_headers()?;
        self.send(HttpRequest {
            method: HttpMethod::Post,
            url: format!("{}/rest/v1/rpc/{function}", self.project_url()),
            headers,
            body: serde_json::to_vec(&body)
                .map_err(|e| TransferError::Failed(format!("rpc json: {e}")))?,
            timeout: None,
        })
        .await
    }
}

/// The transport's own failures in the transfer vocabulary: a body over the
/// ceiling is a size refusal, a deadline is a timeout, and a request that
/// produced no response at all is the adapter reporting what the network did.
fn transfer_error(error: HttpError) -> TransferError {
    match error {
        HttpError::BodyTooLarge { limit } => TransferError::TooLarge { limit },
        HttpError::Timeout(detail) => TransferError::TimedOut { detail },
        HttpError::Transport(message) | HttpError::Config(message) => {
            TransferError::Failed(message)
        }
    }
}

/// The resume state a caller must persist after a network loss mid-flight.
fn interrupted_at(offset: u64, upload_url: &str) -> TransferError {
    TransferError::Interrupted {
        offset,
        tus_url: Some(upload_url.to_string()),
    }
}

/// The body Supabase Storage answers a refusal with: the status it means and
/// the name of the error, under either key its versions use.
#[derive(Debug, Deserialize)]
struct StorageRefusal {
    #[serde(rename = "statusCode", default)]
    status_code: Option<serde_json::Value>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// The status Storage means by a refusal. Storage answers most refusals with
/// HTTP 400 and names the status in the body's `statusCode`, so a 400 that
/// carries one means that status. The error names `NoSuchKey` and
/// `InvalidJWT` mean 404 and 401 whatever the numbers say.
fn storage_status(response: &HttpResponse) -> u16 {
    if response.is_success() {
        return response.status;
    }
    let Ok(refusal) = serde_json::from_slice::<StorageRefusal>(&response.body) else {
        return response.status;
    };

    let named = [refusal.code.as_deref(), refusal.error.as_deref()];
    if named.contains(&Some("NoSuchKey")) {
        return 404;
    }
    if named.contains(&Some("InvalidJWT")) {
        return 401;
    }
    let carried = match refusal.status_code {
        Some(serde_json::Value::String(text)) => text.parse::<u16>().ok(),
        Some(serde_json::Value::Number(number)) => {
            number.as_u64().and_then(|value| u16::try_from(value).ok())
        }
        _ => None,
    };
    match carried {
        Some(status) if response.status == 400 && (400..600).contains(&status) => status,
        _ => response.status,
    }
}

/// Bounds-checked slice: an out-of-range offset is a caller bug we must not panic on.
fn slice(bytes: &[u8], from: u64, to: u64) -> Result<&[u8], TransferError> {
    let from =
        usize::try_from(from).map_err(|_| TransferError::Failed("offset overflow".into()))?;
    let to = usize::try_from(to).map_err(|_| TransferError::Failed("offset overflow".into()))?;
    bytes
        .get(from..to)
        .ok_or_else(|| TransferError::Failed(format!("chunk {from}..{to} is out of range")))
}

#[async_trait]
impl Transfer for TusTransfer {
    fn supports_resumable(&self) -> bool {
        true
    }

    fn single_shot_max_bytes(&self) -> u64 {
        self.config.single_shot_max_bytes
    }

    async fn upload_single_shot(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
    ) -> Result<(), TransferError> {
        let mut headers = supabase_http_headers(&self.bearer()?, self.publishable_key());
        headers.push(("Content-Type".into(), target.content_type.clone()));
        if self.config.upsert {
            headers.push(("x-upsert".into(), "true".into()));
        }
        let response = self
            .send(HttpRequest {
                method: HttpMethod::Post,
                url: format!(
                    "{}/storage/v1/object/{}/{}",
                    self.config.storage_url.trim_end_matches('/'),
                    encode_component(&target.bucket),
                    encode_object_path(&target.path)
                ),
                headers,
                body: bytes.to_vec(),
                timeout: Some(DEFAULT_BYTES_TIMEOUT),
            })
            .await?;
        if !response.is_success() {
            return Err(TransferError::Http {
                status: storage_status(&response),
                detail: format!("attachment upload refused: {}", response.text()),
            });
        }
        Ok(())
    }

    /// Resume against the server's own offset: the durable `start_offset` is only
    /// a hint, a HEAD on the session URL is the truth (the TypeScript client does
    /// the same).
    ///
    /// A persisted session URL is dropped, and the upload created again from
    /// zero, when it sits off the endpoint's origin (it is never probed: the
    /// probe would carry the user's token there), when the HEAD answers
    /// 404/410, or when the session declares another length than these bytes.
    /// Any other client error on the HEAD is [`TransferError::SessionRefused`],
    /// which tells the caller to drop the URL it persisted.
    async fn upload_resumable(
        &self,
        target: &UploadTarget,
        bytes: &[u8],
        _start_offset: u64,
        existing_tus_url: Option<&str>,
    ) -> Result<UploadProgress, TransferError> {
        let total = bytes.len() as u64;
        let key = Self::session_key(target);
        let mut session = existing_tus_url
            .map(str::to_string)
            .or_else(|| self.remembered_session(&key))
            .and_then(|url| resolve_tus_location(&self.config.tus_endpoint, &url).ok());

        let mut offset = 0;
        if let Some(url) = session.clone() {
            match self.head_offset(&url, total).await {
                Ok(HeadOutcome::Offset(server_offset)) => offset = server_offset,
                Ok(HeadOutcome::Unusable) => session = None,
                Err(error) => {
                    if matches!(error, TransferError::SessionRefused { .. }) {
                        self.forget_session(&key);
                    }
                    return Err(error);
                }
            }
        }

        let upload_url = match session {
            Some(url) => url,
            None => self.create(target, total).await?,
        };

        // Record BEFORE patching: a mid-flight kill must leave the session URL
        // behind, or the next attempt would upload the whole object again.
        self.remember_session(&key, &upload_url);

        let patched = self.patch_all(&upload_url, bytes, offset).await;
        if matches!(
            patched,
            Ok(_) | Err(TransferError::SessionExpired | TransferError::SessionRefused { .. })
        ) {
            self.forget_session(&key);
        }

        Ok(UploadProgress {
            bytes_uploaded: patched?,
            bytes_total: total,
            tus_url: Some(upload_url),
        })
    }

    async fn confirm(
        &self,
        target: &ObjectTarget,
        meta: &ConfirmMeta,
        table: &str,
    ) -> Result<(), TransferError> {
        let response = self
            .rpc_json(
                "attachment_confirm",
                serde_json::json!({
                    "p_bucket": target.bucket,
                    "p_path": target.path,
                    "p_sha256": meta.sha256,
                    "p_size": meta.size,
                    "p_media_type": meta.content_type,
                    "p_table": table,
                }),
            )
            .await?;
        if !response.is_success() {
            return Err(TransferError::Http {
                status: response.status,
                detail: format!("attachment_confirm refused: {}", response.text()),
            });
        }
        Ok(())
    }

    async fn download(
        &self,
        target: &ObjectTarget,
        to_local_path: &str,
        sha256: Option<&str>,
    ) -> Result<(), TransferError> {
        let bytes = self.fetch_object_bytes(target).await?;
        if let Some(expected) = sha256
            && sha256_hex(&bytes) != expected
        {
            return Err(TransferError::HashMismatch {
                path: target.path.clone(),
            });
        }
        atomic_write(Path::new(to_local_path), &bytes)
    }

    /// Reads `kizunasync.attachment_metadata`, not the table: the table is
    /// owner-only under RLS, while the definer RPC also answers a peer for an
    /// object a synced row it can read carries.
    async fn metadata(&self, target: &ObjectTarget) -> Result<Option<String>, TransferError> {
        let response = self
            .rpc_json(
                "attachment_metadata",
                serde_json::json!({
                    "p_bucket_id": target.bucket,
                    "p_object_path": target.path,
                }),
            )
            .await?;
        if !response.is_success() {
            return Err(TransferError::Http {
                status: response.status,
                detail: format!("attachment_metadata refused: {}", response.text()),
            });
        }
        let rows: Vec<AttachmentShaRow> =
            serde_json::from_slice(&response.body).map_err(|e| TransferError::Protocol {
                detail: format!("attachment metadata json: {e}"),
            })?;
        Ok(rows.into_iter().next().and_then(|row| row.sha256))
    }

    async fn remove(&self, target: &ObjectTarget) -> Result<(), TransferError> {
        let headers = supabase_http_headers(&self.bearer()?, self.publishable_key());
        let response = self
            .send(HttpRequest {
                method: HttpMethod::Delete,
                url: format!(
                    "{}/storage/v1/object/{}/{}",
                    self.project_url(),
                    encode_component(&target.bucket),
                    encode_object_path(&target.path)
                ),
                headers,
                body: Vec::new(),
                timeout: None,
            })
            .await?;
        let status = storage_status(&response);
        if !response.is_success() && status != 404 {
            return Err(TransferError::Http {
                status,
                detail: format!("attachment storage remove refused: {}", response.text()),
            });
        }
        let vacuum = self
            .rpc_json(
                "attachment_vacuum",
                serde_json::json!({
                    "p_bucket": target.bucket,
                    "p_path": target.path,
                }),
            )
            .await?;
        if !vacuum.is_success() {
            return Err(TransferError::Http {
                status: vacuum.status,
                detail: format!("attachment_vacuum refused: {}", vacuum.text()),
            });
        }
        Ok(())
    }

    fn set_access_token(&self, token: Option<String>) {
        self.access_token.set(token);
    }
}

#[derive(Debug, Deserialize)]
struct AttachmentShaRow {
    sha256: Option<String>,
}

/// Storage's answer to a sign request. The signed URL is a bearer capability,
/// so `Debug` output leaves it out.
#[derive(Deserialize)]
struct SignedUrlResponse {
    #[serde(alias = "signedURL", alias = "signedUrl")]
    signed_url: Option<String>,
}

impl fmt::Debug for SignedUrlResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignedUrlResponse")
            .field(
                "signed_url",
                &self.signed_url.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl TusTransfer {
    async fn fetch_object_bytes(&self, target: &ObjectTarget) -> Result<Vec<u8>, TransferError> {
        let mut headers = supabase_http_headers(&self.bearer()?, self.publishable_key());
        headers.push(("Content-Type".into(), "application/json".into()));
        let sign = self
            .send(HttpRequest {
                method: HttpMethod::Post,
                url: format!(
                    "{}/storage/v1/object/sign/{}/{}",
                    self.project_url(),
                    encode_component(&target.bucket),
                    encode_object_path(&target.path)
                ),
                headers: headers.clone(),
                body: serde_json::to_vec(&serde_json::json!({ "expiresIn": 60 }))
                    .map_err(|e| TransferError::Failed(format!("sign json: {e}")))?,
                timeout: None,
            })
            .await?;
        if storage_status(&sign) == 404 {
            return Err(TransferError::NotYetAvailable);
        }
        if sign.is_success() {
            let payload: SignedUrlResponse =
                serde_json::from_slice(&sign.body).map_err(|e| TransferError::Protocol {
                    detail: format!("object sign response json: {e}"),
                })?;
            if let Some(signed) = payload.signed_url.filter(|url| !url.is_empty()) {
                let get = self
                    .send(HttpRequest {
                        method: HttpMethod::Get,
                        url: self.signed_object_url(&signed)?,
                        headers: Vec::new(),
                        body: Vec::new(),
                        timeout: Some(DEFAULT_BYTES_TIMEOUT),
                    })
                    .await?;
                return read_object_get(get);
            }
        }
        let get = self
            .send(HttpRequest {
                method: HttpMethod::Get,
                url: format!(
                    "{}/storage/v1/object/{}/{}",
                    self.project_url(),
                    encode_component(&target.bucket),
                    encode_object_path(&target.path)
                ),
                headers,
                body: Vec::new(),
                timeout: Some(DEFAULT_BYTES_TIMEOUT),
            })
            .await?;
        read_object_get(get)
    }

    /// Where a signed URL points. Storage answers the signed path relative to
    /// its own base, `<project>/storage/v1` (storage-js joins it the same
    /// way), with the object key unescaped, so every path segment is escaped
    /// here. An absolute URL is fetched only when it is `https` (a loopback or
    /// local-network host excepted) on the project's own origin; anything else
    /// is refused and never fetched.
    fn signed_object_url(&self, signed: &str) -> Result<String, TransferError> {
        if signed.starts_with("https://") || signed.starts_with("http://") {
            let absolute = require_secure_url(signed, "signed URL")
                .map_err(|_| TransferError::OriginMismatch)?;
            let project = reqwest::Url::parse(self.project_url())
                .map_err(|e| TransferError::Failed(format!("storage url: {e}")))?;
            if absolute.origin() != project.origin() {
                return Err(TransferError::OriginMismatch);
            }
            return Ok(signed.to_owned());
        }

        // The token never holds a `?`, so the last one starts the query even
        // when the key itself carries one.
        let (path, query) = signed
            .rsplit_once('?')
            .map_or((signed, None), |(path, query)| (path, Some(query)));
        let mut url = format!(
            "{}/storage/v1/{}",
            self.project_url(),
            encode_object_path(path.trim_start_matches('/'))
        );
        if let Some(query) = query {
            url.push('?');
            url.push_str(query);
        }
        Ok(url)
    }
}

fn read_object_get(response: HttpResponse) -> Result<Vec<u8>, TransferError> {
    let status = storage_status(&response);
    if status == 404 {
        return Err(TransferError::NotYetAvailable);
    }
    if !response.is_success() {
        return Err(TransferError::Http {
            status,
            detail: format!("attachment fetch refused: {}", response.text()),
        });
    }
    Ok(response.body)
}

/// Percent-encode an object key for a Storage URL **path**: every segment is
/// escaped, the `/` separators are not. A query-parameter context wants the
/// whole value escaped instead, which is [`encode_component`] alone.
fn encode_object_path(path: &str) -> String {
    path.split('/')
        .map(encode_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_component(value: &str) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                // `fmt::Write` for `String` only fails on allocation failure, not
                // on any input this loop can produce.
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
