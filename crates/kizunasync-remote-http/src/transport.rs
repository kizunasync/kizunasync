//! The injectable HTTP seam every adapter in this crate talks through.
//!
//! Keeping the wire behind a trait is what lets the RPC and TUS adapters be unit
//! tested for request shape and error classification with zero network: the tests
//! bind a [`FakeTransport`], production binds [`ReqwestTransport`].

use async_trait::async_trait;
use std::fmt;
use std::sync::Mutex;
use std::time::Duration;
use thiserror::Error;

/// Hard per-request deadline. Without it a half-open socket parks the caller's
/// in-flight slot until the OS gives up; matches the scheduler backoff ceiling
/// (`MAX_BACKOFF_MS` in `packages/core/src/host/sync-scheduler.ts`), so a
/// wedged request costs at most one retry window.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Deadline for establishing the connection alone, so a black-holed SYN fails
/// well before the whole-request deadline.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Deadline for a request that carries an object's bytes (a single-shot
/// upload, a TUS chunk, a download). A 6 MiB body on a slow mobile link
/// legitimately outlives [`DEFAULT_REQUEST_TIMEOUT`], so these requests set it
/// through [`HttpRequest::timeout`]; `DEFAULT_TRANSFER_BYTES_TIMEOUT_MS` in
/// `packages/core/src/util/deadline.ts` is the same value.
pub const DEFAULT_BYTES_TIMEOUT: Duration = Duration::from_secs(120);

/// The largest response body [`ReqwestTransport`] buffers. A body is held whole
/// in memory before any caller sees it, so the ceiling is what keeps one
/// oversized object (or a host answering with an endless stream) from growing
/// the process until it is killed.
pub const DEFAULT_MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// The failure shape [`HttpTransport::execute`] returns.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum HttpError {
    /// The request never produced a response (DNS, TLS, connection).
    #[error("{0}")]
    Transport(String),
    /// The request ran past its deadline before the response was complete.
    #[error("{0}")]
    Timeout(String),
    /// The adapter refused its configuration before sending anything.
    #[error("{0}")]
    Config(String),
    /// The response body crosses the transport's ceiling. The body is not read,
    /// or the read stops at the ceiling, so the bytes past it never allocate.
    #[error("response body exceeds the {limit} byte limit")]
    BodyTooLarge {
        /// The ceiling the body would have crossed, in bytes.
        limit: u64,
    },
}

/// The HTTP methods this crate's adapters issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    /// `GET`.
    Get,
    /// `POST`.
    Post,
    /// `HEAD`.
    Head,
    /// `PATCH`.
    Patch,
    /// `DELETE`.
    Delete,
}

impl HttpMethod {
    /// The wire method name, e.g. `"GET"`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Head => "HEAD",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

/// Case-insensitive header lookup (HTTP header names are not case sensitive, and
/// a real server answers with whatever casing it likes).
fn find_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// One outgoing HTTP request, transport-agnostic. Its `Debug` output leaves
/// out the credential header values, the URL query, and the body.
#[derive(Clone)]
pub struct HttpRequest {
    /// The HTTP method.
    pub method: HttpMethod,
    /// The full request URL, including query string.
    pub url: String,
    /// Request headers, in the order they are sent.
    pub headers: Vec<(String, String)>,
    /// Raw request body. Empty for a bodyless request.
    pub body: Vec<u8>,
    /// This request's own deadline, or `None` for the transport's default.
    pub timeout: Option<Duration>,
}

impl HttpRequest {
    /// The first header whose name matches `name` case-insensitively.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        find_header(&self.headers, name)
    }
}

/// What `Debug` prints in place of a credential.
const REDACTED: &str = "<redacted>";

/// The headers whose values are credentials: the user JWT and the project key.
fn is_credential_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization") || name.eq_ignore_ascii_case("apikey")
}

/// `url` without its query, which is where a signed URL carries its token.
fn redacted_url(url: &str) -> String {
    match url.split_once('?') {
        Some((path, _)) => format!("{path}?{REDACTED}"),
        None => url.to_owned(),
    }
}

/// Leaves out the credential header values, the URL query, and the body,
/// which can carry user rows: only its length is shown.
impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(name, value)| {
                let shown = if is_credential_header(name) {
                    REDACTED
                } else {
                    value.as_str()
                };
                (name.as_str(), shown)
            })
            .collect();
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &redacted_url(&self.url))
            .field("headers", &headers)
            .field("body_len", &self.body.len())
            .field("timeout", &self.timeout)
            .finish()
    }
}

/// One HTTP response, transport-agnostic.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// The HTTP status code.
    pub status: u16,
    /// Response headers, as the server sent them.
    pub headers: Vec<(String, String)>,
    /// Raw response body.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// The first header whose name matches `name` case-insensitively.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        find_header(&self.headers, name)
    }

    /// Whether [`Self::status`] falls in the `2xx` range.
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Response body as UTF-8, lossy: only for error messages, never for parsing.
    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// The injectable HTTP seam every adapter in this crate talks through.
#[async_trait]
pub trait HttpTransport: Send + Sync {
    /// Sends `request` and returns the response.
    ///
    /// # Errors
    ///
    /// [`HttpError::Transport`] when the request never produced a response
    /// (DNS, TLS, connection, or timeout failure), and
    /// [`HttpError::BodyTooLarge`] when the body crosses the implementation's
    /// ceiling. An HTTP error status is not an error here. The caller
    /// classifies it from [`HttpResponse::status`].
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, HttpError>;
}

// MARK: - URL posture

/// Parses `url` and accepts it only over `https`, or over plain `http` on a
/// loopback host (a local Supabase stack). `what` names the URL in the refusal.
///
/// # Errors
/// [`HttpError::Config`] for a URL that does not parse or fails the rule.
pub(crate) fn require_secure_url(url: &str, what: &str) -> Result<reqwest::Url, HttpError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| HttpError::Config(format!("{what} is not a URL: {e}")))?;
    if parsed.scheme() == "https" || (parsed.scheme() == "http" && is_loopback(&parsed)) {
        return Ok(parsed);
    }

    Err(HttpError::Config(format!(
        "{what} must use https; plain http is accepted on a loopback host only"
    )))
}

fn is_loopback(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

// MARK: - Production transport

/// `reqwest` over rustls. Built once and cloned per call (the client owns the
/// connection pool, so sharing it is what keeps keep-alive working).
pub struct ReqwestTransport {
    client: reqwest::Client,
    max_response_bytes: u64,
}

impl ReqwestTransport {
    /// Builds a client bounded by [`DEFAULT_REQUEST_TIMEOUT`] and
    /// [`DEFAULT_CONNECT_TIMEOUT`]; a timeout surfaces as [`HttpError::Timeout`],
    /// which every adapter classifies as retryable.
    ///
    /// Redirects are never followed: Supabase APIs do not redirect, and a
    /// followed redirect would carry the `apikey` header to whatever host the
    /// `Location` names. A redirect comes back as its own `3xx` response.
    ///
    /// # Errors
    /// When the TLS backend or the client builder cannot be initialised.
    pub fn new() -> Result<Self, HttpError> {
        let client = reqwest::Client::builder()
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .connect_timeout(DEFAULT_CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| HttpError::Transport(e.to_string()))?;
        Ok(Self {
            client,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        })
    }

    /// Wraps an already-built `reqwest` client (tests, or a host-supplied one).
    /// Its redirect policy and deadlines are the caller's.
    #[must_use]
    pub const fn with_client(client: reqwest::Client) -> Self {
        Self {
            client,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        }
    }

    /// Move the ceiling this transport buffers a response body up to, away from
    /// [`DEFAULT_MAX_RESPONSE_BYTES`].
    #[must_use]
    pub const fn with_max_response_bytes(mut self, limit: u64) -> Self {
        self.max_response_bytes = limit;
        self
    }
}

#[async_trait]
impl HttpTransport for ReqwestTransport {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let method = reqwest::Method::from_bytes(request.method.as_str().as_bytes())
            .map_err(|e| HttpError::Transport(e.to_string()))?;
        let mut builder = self.client.request(method, &request.url);
        for (key, value) in &request.headers {
            builder = builder.header(key, value);
        }
        if let Some(timeout) = request.timeout {
            builder = builder.timeout(timeout);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }

        let mut response = builder.send().await.map_err(request_failure)?;

        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(key, value)| {
                (
                    key.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();

        // A declared length over the ceiling is refused before the first byte of
        // the body is read, so an oversized object costs one set of headers.
        let declared = find_header(&headers, "Content-Length").and_then(|value| value.parse().ok());
        if declared.is_some_and(|length: u64| length > self.max_response_bytes) {
            return Err(HttpError::BodyTooLarge {
                limit: self.max_response_bytes,
            });
        }

        let mut body = Vec::with_capacity(
            declared
                .and_then(|length| usize::try_from(length).ok())
                .unwrap_or(0),
        );
        while let Some(chunk) = response.chunk().await.map_err(request_failure)? {
            // A host that declares nothing, or lies about the length, is bounded
            // here instead: the read stops the moment the ceiling is crossed.
            if body.len() as u64 + chunk.len() as u64 > self.max_response_bytes {
                return Err(HttpError::BodyTooLarge {
                    limit: self.max_response_bytes,
                });
            }
            body.extend_from_slice(&chunk);
        }

        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

/// A `reqwest` failure without its URL, which can carry a signed URL's token,
/// so the text is safe to log or to store on an attachment row. The source
/// chain is kept: the top-level text alone rarely says what went wrong.
fn request_failure(error: reqwest::Error) -> HttpError {
    let error = error.without_url();
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    if error.is_timeout() {
        HttpError::Timeout(message)
    } else {
        HttpError::Transport(message)
    }
}

// MARK: - In-process fake

/// A scripted transport: the handler answers each request, and every request is
/// recorded so a test can assert the exact wire shape it produced.
type FakeHandler = Box<dyn Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync>;

/// A scripted [`HttpTransport`]: `handler` answers each request, and every
/// request is recorded so a test can assert the exact wire shape it produced.
pub struct FakeTransport {
    handler: FakeHandler,
    requests: Mutex<Vec<HttpRequest>>,
}

impl FakeTransport {
    /// Builds a fake bound to `handler`, which answers every request issued
    /// against it.
    pub fn new(
        handler: impl Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            handler: Box::new(handler),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Every request the adapter issued, in order.
    #[must_use]
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl HttpTransport for FakeTransport {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(request.clone());
        (self.handler)(&request)
    }
}

/// A JSON response body with the given status, the shape `PostgREST` answers with.
#[must_use]
pub fn json_response(status: u16, body: &str) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: body.as_bytes().to_vec(),
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_production_client_is_built_with_a_bounded_deadline() {
        assert_eq!(DEFAULT_REQUEST_TIMEOUT, Duration::from_secs(30));
        assert!(DEFAULT_CONNECT_TIMEOUT < DEFAULT_REQUEST_TIMEOUT);
        assert!(ReqwestTransport::new().is_ok());
    }

    /// A server that accepts the connection and never answers is exactly the
    /// half-open socket the deadline exists for: without it `execute` would never
    /// return.
    #[tokio::test]
    async fn a_request_that_is_never_answered_fails_at_the_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let _accepted = listener.accept();
            // Hold the socket open, unanswered, until the client's deadline has
            // fired: closing it first would surface as a reset instead.
            let _ = released.recv();
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(50))
            .build()
            .unwrap();
        let result = ReqwestTransport::with_client(client)
            .execute(HttpRequest {
                method: HttpMethod::Get,
                url: format!("http://{address}/"),
                headers: Vec::new(),
                body: Vec::new(),
                timeout: None,
            })
            .await;

        assert!(matches!(result, Err(HttpError::Timeout(_))), "{result:?}");
        drop(release);
        server.join().unwrap();
    }

    /// The server answers after the client's own deadline, so only a
    /// per-request deadline longer than the client's lets the answer land.
    #[tokio::test]
    async fn a_request_deadline_replaces_the_client_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut request);
                std::thread::sleep(Duration::from_millis(300));
                let _ = std::io::Write::write_all(
                    &mut stream,
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(50))
            .build()
            .unwrap();

        let response = ReqwestTransport::with_client(client)
            .execute(HttpRequest {
                timeout: Some(Duration::from_secs(5)),
                ..get(&format!("http://{address}/"))
            })
            .await;

        assert_eq!(response.map(|r| r.status).ok(), Some(200));
        server.join().unwrap();
    }

    /// Supabase APIs do not redirect, and a followed redirect would carry the
    /// `apikey` header to whatever host the `Location` names.
    #[tokio::test]
    async fn the_production_transport_never_follows_a_redirect() {
        let (url, server) = serve_once(|stream| {
            let _ = std::io::Write::write_all(
                stream,
                b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\n\r\n",
            );
        });

        let response = ReqwestTransport::new()
            .unwrap()
            .execute(get(&url))
            .await
            .expect("the redirect itself is the answer");

        assert_eq!(response.status, 302);
        server.join().unwrap();
    }

    /// A signed URL carries its token in the query, so the URL itself is a
    /// credential: a transport failure must not repeat it.
    #[tokio::test]
    async fn a_transport_error_never_carries_the_request_url() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);

        let error = ReqwestTransport::new()
            .unwrap()
            .execute(get(&format!(
                "http://{address}/object/sign/secret-path?token=secret-token"
            )))
            .await
            .expect_err("nothing listens on the port");

        let text = error.to_string();
        assert!(!text.contains("secret-token"), "{text}");
        assert!(!text.contains("secret-path"), "{text}");
    }

    #[test]
    fn a_request_debug_hides_its_credentials() {
        let request = HttpRequest {
            method: HttpMethod::Post,
            url: "https://abc.supabase.co/storage/v1/object/sign/b/p?token=signed-secret".into(),
            headers: vec![
                ("Authorization".into(), "Bearer user-jwt-secret".into()),
                ("apikey".into(), "publishable-secret".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: b"{\"row\":\"private\"}".to_vec(),
            timeout: None,
        };

        let debug = format!("{request:?}");

        for secret in [
            "signed-secret",
            "user-jwt-secret",
            "publishable-secret",
            "private",
        ] {
            assert!(!debug.contains(secret), "{debug}");
        }
        assert!(debug.contains("https://abc.supabase.co/storage/v1/object/sign/b/p"));
        assert!(debug.contains("application/json"));
    }

    /// One connection, answered by `write_response` and then closed. The
    /// transport's own ceiling only shows against a real socket: a
    /// [`FakeTransport`] hands back a body that is already in memory.
    fn serve_once(
        write_response: impl FnOnce(&mut std::net::TcpStream) + Send + 'static,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0_u8; 1024];
                let _ = std::io::Read::read(&mut stream, &mut request);
                write_response(&mut stream);
                // Closing with bytes still unread by the client would reset the
                // connection and lose the response this test is about.
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        (format!("http://{address}/"), server)
    }

    fn bounded_transport(limit: u64) -> ReqwestTransport {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        ReqwestTransport::with_client(client).with_max_response_bytes(limit)
    }

    fn get(url: &str) -> HttpRequest {
        HttpRequest {
            method: HttpMethod::Get,
            url: url.to_string(),
            headers: Vec::new(),
            body: Vec::new(),
            timeout: None,
        }
    }

    /// The server declares a body it never sends, so a transport that read
    /// before checking the declared length would sit there until its deadline
    /// instead of refusing the response.
    #[tokio::test]
    async fn execute_refuses_a_body_over_the_limit_before_reading_it() {
        let (url, server) = serve_once(|stream| {
            let _ = std::io::Write::write_all(
                stream,
                b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n",
            );
        });

        let result = bounded_transport(16).execute(get(&url)).await;

        assert!(
            matches!(result, Err(HttpError::BodyTooLarge { limit: 16 })),
            "{result:?}"
        );
        server.join().unwrap();
    }

    /// Nothing declares a length here, so the ceiling has to hold during the
    /// read itself: the server keeps streaming chunks and the transport stops.
    #[tokio::test]
    async fn execute_stops_a_chunked_body_that_grows_past_the_limit() {
        let (url, server) = serve_once(|stream| {
            use std::io::Write as _;
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            let chunk = [b'k'; 1024];
            for _ in 0..64 {
                if stream.write_all(b"400\r\n").is_err()
                    || stream.write_all(&chunk).is_err()
                    || stream.write_all(b"\r\n").is_err()
                {
                    return;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });

        let result = bounded_transport(2048).execute(get(&url)).await;

        assert!(
            matches!(result, Err(HttpError::BodyTooLarge { limit: 2048 })),
            "{result:?}"
        );
        server.join().unwrap();
    }

    /// The ceiling is inclusive: a body of exactly the limit is one the
    /// transport agreed to hold.
    #[tokio::test]
    async fn a_content_length_exactly_at_the_limit_is_accepted() {
        let (url, server) = serve_once(|stream| {
            let _ = std::io::Write::write_all(
                stream,
                b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r\n0123456789abcdef",
            );
        });

        let response = bounded_transport(16)
            .execute(get(&url))
            .await
            .expect("a body at the limit");

        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"0123456789abcdef");
        server.join().unwrap();
    }

    #[test]
    fn header_lookup_ignores_case() {
        let response = HttpResponse {
            status: 200,
            headers: vec![("upload-offset".into(), "42".into())],
            body: Vec::new(),
        };
        assert_eq!(response.header("Upload-Offset"), Some("42"));
        assert_eq!(response.header("missing"), None);
        assert!(response.is_success());
    }
}
