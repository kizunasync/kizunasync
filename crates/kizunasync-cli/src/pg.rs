//! The direct-Postgres [`Applier`], over short-lived connections.
//!
//! Statements run through the **simple query protocol** (`simple_query`), so
//! fully-composed statements and multi-statement scripts (a `begin; …; commit;`
//! down-migration, a seed insert) are not forced through the extended
//! protocol's one-command limit, and every value arrives as text, which is
//! exactly the normalization [`crate::row`] expects.
//!
//! TLS is rustls-only (no OpenSSL toolchain). Its root store is Mozilla's roots
//! plus Supabase's own database CA, which hosted Supabase chains end at, plus
//! the certificates of the URL's `sslrootcert` file. rustls does not map
//! `sslmode` into `ClientConfig`; the crate-private `tls_url` module decides
//! whether a hosted URL is allowed and whether the connector is rustls or
//! `NoTls`.

use std::path::Path;
use std::sync::Arc;

use postgres::tls::MakeTlsConnect;
use postgres::{Client, NoTls, SimpleQueryMessage, Socket};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use rustls::{CertificateError, ClientConfig, RootCertStore};
use serde_json::Value;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::applier::Applier;
use crate::error::{Error, Result};
use crate::interrupt::{self, Cancel};
use crate::row::Row;
use crate::server_facts::{ServerFacts, read_server_facts};
use crate::tls_url::{self, TlsChoice};

/// Supabase's database CA. Every hosted Supabase Postgres chain, pooler and
/// direct host alike, ends at it, and Mozilla's roots do not include it. It is
/// the `prod-ca-2021.crt` the dashboard offers under Database Settings, SSL
/// configuration, valid until 2031-04-26. Verify a copy with
/// `openssl x509 -in supabase-root-2021.pem -noout -fingerprint -sha256`: it
/// must print
/// `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`,
/// the fingerprint the tests pin.
const SUPABASE_ROOT_PEM: &str = include_str!("../certs/supabase-root-2021.pem");

/// What a chain rustls refuses as `UnknownIssuer` means here, and the way out.
const UNKNOWN_ISSUER_REMEDY: &str = "the server's certificate chain is signed by a CA the client does not trust; hosted Supabase chains end at the embedded Supabase Root 2021 CA, so re-check the host; for another CA pass `sslrootcert=<path to its PEM>` in the URL";

/// An [`Applier`] that opens a connection per statement and always closes it.
pub struct PgApplier {
    url: String,
}

impl PgApplier {
    /// Bind the applier to a connection string. Nothing is connected until a
    /// statement runs.
    #[must_use]
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_owned(),
        }
    }

    /// The connection, and the cancel request for its statement, sent over
    /// the TLS the connection used.
    fn connect(&self) -> Result<(Client, Cancel)> {
        let mut prepared = tls_url::prepare_connect(&self.url)?;
        fill_password(
            &mut prepared.config,
            std::env::var("PGPASSWORD").ok().as_deref(),
        );
        let connected = match prepared.tls {
            TlsChoice::NoTls => prepared
                .config
                .connect(NoTls)
                .map(|client| cancel_request(client, NoTls)),
            TlsChoice::Rustls => {
                let tls = make_tls(prepared.root_cert.as_deref())?;
                prepared
                    .config
                    .connect(tls.clone())
                    .map(|client| cancel_request(client, tls))
            }
        };

        connected.map_err(|cause| Error::Db(describe(&cause)))
    }
}

impl Applier for PgApplier {
    fn run_query(&self, sql: &str) -> Result<Vec<Row>> {
        let (mut client, cancel) = self.connect()?;
        let messages = interrupt::cancellable(
            cancel,
            || client.simple_query(sql),
            |cause| cause.as_db_error().is_some(),
        )
        .map_err(|cause| statement_error(&cause))?;

        Ok(map_rows(&messages))
    }
}

/// The password `PGPASSWORD` carries, for a URL that names none. libpq reads
/// it the same way, and every command this CLI prints leaves the password to
/// it (@docs/cli/cli.md).
fn fill_password(config: &mut postgres::Config, pgpassword: Option<&str>) {
    if config.get_password().is_some() {
        return;
    }

    if let Some(password) = pgpassword.filter(|password| !password.is_empty()) {
        config.password(password);
    }
}

/// `client`, with the request that cancels its running statement.
fn cancel_request<T>(client: Client, tls: T) -> (Client, Cancel)
where
    T: MakeTlsConnect<Socket> + Send + 'static,
{
    let token = client.cancel_token();
    let cancel: Cancel = Box::new(move || {
        let _ = token.cancel_query(tls);
    });

    (client, cancel)
}

/// Connectivity probe that also reads the [`ServerFacts`] the connection
/// test reports. Honest failure text is the caller's job (it knows which flags
/// and env vars it offers): this only reports the connection error.
///
/// # Errors
/// Returns [`Error::Db`] carrying the driver's own message, and
/// [`Error::Boundary`] when the facts read does not carry its columns.
pub fn probe_db(url: &str) -> Result<ServerFacts> {
    read_server_facts(&PgApplier::new(url))
}

/// A statement that failed: [`Error::Sql`] with its SQLSTATE when the server
/// answered it with an error, [`Error::Db`] when the connection failed first.
fn statement_error(cause: &postgres::Error) -> Error {
    match cause.as_db_error() {
        Some(db) => Error::Sql {
            sqlstate: db.code().code().to_owned(),
            text: describe(cause),
        },
        None => Error::Db(describe(cause)),
    }
}

/// What a driver failure says, which `Display` alone does not.
///
/// `postgres::Error`'s own `Display` for a server error is the bare
/// `db error`: the SQLSTATE, the message, the detail and the hint all live one
/// level down, in a source the caller never sees. A CLI that printed that
/// would tell a user their statement failed and nothing else, so the parts are
/// pulled out here; a failure with no `DbError` behind it (a TLS handshake, a
/// refused connection) reports its source chain instead.
fn describe(cause: &postgres::Error) -> String {
    match cause.as_db_error() {
        Some(db) => db_error_text(db.code().code(), db.message(), db.detail(), db.hint()),
        None => failure_text(cause),
    }
}

/// The source chain, followed by [`UNKNOWN_ISSUER_REMEDY`] when rustls refused
/// the server's chain because no trusted root signs it.
fn failure_text(error: &(dyn std::error::Error + 'static)) -> String {
    let chain = source_chain(error);
    if is_unknown_issuer(error) {
        return format!("{chain}: {UNKNOWN_ISSUER_REMEDY}");
    }

    chain
}

/// Whether any link of the chain is rustls' `UnknownIssuer`. The driver gets
/// the rustls error wrapped in an `io::Error`, whose `source()` skips the error
/// it wraps, so each link is also opened with `get_ref`.
fn is_unknown_issuer(error: &(dyn std::error::Error + 'static)) -> bool {
    std::iter::successors(Some(error), |cause| cause.source()).any(|cause| {
        let tls = cause
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .and_then(|inner| inner.downcast_ref::<rustls::Error>())
            .or_else(|| cause.downcast_ref::<rustls::Error>());

        matches!(
            tls,
            Some(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer
            ))
        )
    })
}

/// One line carrying every part the server sent.
fn db_error_text(code: &str, message: &str, detail: Option<&str>, hint: Option<&str>) -> String {
    let mut text = format!("{code}: {message}");
    for (label, part) in [("detail", detail), ("hint", hint)] {
        if let Some(part) = part {
            text.push_str(" (");
            text.push_str(label);
            text.push_str(": ");
            text.push_str(part);
            text.push(')');
        }
    }

    text
}

/// The error and everything under it, joined the way a reader reads it. The
/// outermost `Display` is often a category (`error connecting to server`) and
/// the cause below it is the sentence that names the problem.
fn source_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !parts.iter().any(|part| part == &text) {
            parts.push(text);
        }
        source = cause.source();
    }

    parts.join(": ")
}

fn map_rows(messages: &[SimpleQueryMessage]) -> Vec<Row> {
    let mut rows = Vec::new();
    for message in messages {
        if let SimpleQueryMessage::Row(simple) = message {
            let mut row = Row::new();
            for (index, column) in simple.columns().iter().enumerate() {
                let value = simple
                    .get(index)
                    .map_or(Value::Null, |text| Value::String(text.to_owned()));
                row.insert(column.name().to_owned(), value);
            }
            rows.push(row);
        }
    }

    rows
}

/// [`root_store`] behind rustls' ring provider. Built per connection: the CLI
/// opens a handful of them per run, so caching it would buy nothing and would
/// keep a process-wide default provider installed as a side effect.
fn make_tls(root_cert: Option<&Path>) -> Result<MakeRustlsConnect> {
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|cause| Error::Db(format!("could not configure TLS: {cause}")))?
            .with_root_certificates(root_store(root_cert)?)
            .with_no_client_auth();

    Ok(MakeRustlsConnect::new(config))
}

/// Mozilla's roots, the Supabase root, and every certificate in `root_cert`,
/// the URL's `sslrootcert` file.
fn root_store(root_cert: Option<&Path>) -> Result<RootCertStore> {
    let mut roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    add_pem_roots(&mut roots, SUPABASE_ROOT_PEM.as_bytes()).map_err(|cause| {
        Error::Internal(format!(
            "the embedded Supabase root CA does not load: {cause}"
        ))
    })?;

    if let Some(path) = root_cert {
        std::fs::read(path)
            .map_err(|cause| cause.to_string())
            .and_then(|pem| add_pem_roots(&mut roots, &pem))
            .map_err(|cause| {
                Error::Db(format!(
                    "could not load sslrootcert={}: {cause}",
                    path.display()
                ))
            })?;
    }

    Ok(roots)
}

/// Adds every certificate `pem` holds as a trust anchor. A file that holds none
/// is refused rather than read as trusting nothing extra.
fn add_pem_roots(roots: &mut RootCertStore, pem: &[u8]) -> std::result::Result<(), String> {
    let before = roots.len();
    for certificate in CertificateDer::pem_slice_iter(pem) {
        let certificate = certificate.map_err(|cause| cause.to_string())?;
        roots.add(certificate).map_err(|cause| cause.to_string())?;
    }

    if roots.len() == before {
        return Err("the file holds no PEM certificate".into());
    }

    Ok(())
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_tls_connector_builds_from_the_bundled_root_store() {
        assert!(make_tls(None).is_ok());
    }

    fn filled(url: &str, pgpassword: Option<&str>) -> Option<Vec<u8>> {
        let mut config = tls_url::prepare_connect(url).unwrap().config;
        fill_password(&mut config, pgpassword);

        config.get_password().map(<[u8]>::to_vec)
    }

    /// A URL with no password connects with the one `PGPASSWORD` carries, the
    /// way libpq reads it, so a printed `PGPASSWORD=… kizunasync … --db-url`
    /// command runs as printed.
    #[test]
    fn a_url_without_a_password_takes_the_one_pgpassword_carries() {
        let url = "postgresql://postgres@127.0.0.1:55322/postgres";

        assert_eq!(filled(url, Some("from-env")), Some(b"from-env".to_vec()));
    }

    #[test]
    fn a_password_in_the_url_wins_over_pgpassword() {
        let url = "postgresql://postgres:in-url@127.0.0.1:55322/postgres";

        assert_eq!(filled(url, Some("from-env")), Some(b"in-url".to_vec()));
    }

    #[test]
    fn an_unset_or_empty_pgpassword_leaves_the_url_without_one() {
        let url = "postgresql://postgres@127.0.0.1:55322/postgres";

        assert_eq!(filled(url, None), None);
        assert_eq!(filled(url, Some("")), None);
    }

    /// `postgres::DbError` has no public constructor, so the parts a server
    /// error carries are what the text is built from and what is asserted here.
    #[test]
    fn a_database_error_carries_its_sqlstate_message_detail_and_hint() {
        assert_eq!(
            db_error_text(
                "42501",
                "permission denied for function prune_clients",
                None,
                None
            ),
            "42501: permission denied for function prune_clients"
        );
        assert_eq!(
            db_error_text(
                "23505",
                "duplicate key value violates unique constraint \"todos_pkey\"",
                Some("Key (id)=(1) already exists."),
                Some("Use a different id."),
            ),
            "23505: duplicate key value violates unique constraint \"todos_pkey\" (detail: Key (id)=(1) already exists.) (hint: Use a different id.)"
        );
    }

    /// A failure with no server error behind it (a refused connection, a TLS
    /// handshake) reports the chain, because its outermost line is a category.
    #[test]
    fn a_driver_failure_without_a_server_error_reports_its_source_chain() {
        #[derive(Debug)]
        struct Outer(std::io::Error);

        impl std::fmt::Display for Outer {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "error connecting to server")
            }
        }

        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let error = Outer(std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "Connection refused (os error 61)",
        ));

        assert_eq!(
            source_chain(&error),
            "error connecting to server: Connection refused (os error 61)"
        );
    }

    /// A chain that repeats itself says it once.
    #[test]
    fn a_repeated_cause_is_not_printed_twice() {
        #[derive(Debug)]
        struct Echo(std::io::Error);

        impl std::fmt::Display for Echo {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "{}", self.0)
            }
        }

        impl std::error::Error for Echo {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        let error = Echo(std::io::Error::other("timed out"));

        assert_eq!(source_chain(&error), "timed out");
    }

    #[test]
    fn an_unreachable_host_is_an_error_not_an_empty_row_set() {
        // Port 1 on the loopback refuses immediately: no network, no timeout.
        let Error::Db(message) =
            probe_db("postgresql://postgres:postgres@127.0.0.1:1/postgres").unwrap_err()
        else {
            panic!("an unreachable host is a database failure");
        };

        // The driver's own Display is a category; the sentence a user acts on
        // is the cause below it.
        assert!(
            message.contains("Connection refused") || message.contains("connection refused"),
            "{message}"
        );
    }

    /// The published SHA-256 fingerprint of Supabase Root 2021 CA.
    const SUPABASE_ROOT_SHA256: &str = "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

    /// DER's `UTCTime` tag.
    const UTC_TIME: u8 = 0x17;

    /// The tag and contents of the DER element `bytes` starts with, and the
    /// bytes after it.
    fn der_element(bytes: &[u8]) -> (u8, &[u8], &[u8]) {
        let (&tag, rest) = bytes.split_first().unwrap();
        let (&first, rest) = rest.split_first().unwrap();
        let (length, rest) = if first < 0x80 {
            (usize::from(first), rest)
        } else {
            let (octets, rest) = rest.split_at(usize::from(first & 0x7f));
            let length = octets
                .iter()
                .fold(0, |length, &octet| (length << 8) | usize::from(octet));
            (length, rest)
        };
        let (contents, rest) = rest.split_at(length);

        (tag, contents, rest)
    }

    /// `notBefore` and `notAfter` as the certificate encodes them. `Validity`
    /// follows the version, the serial number, the signature algorithm, and the
    /// issuer in `TBSCertificate` (RFC 5280, section 4.1).
    fn validity(der: &[u8]) -> (&str, &str) {
        let (_, certificate, _) = der_element(der);
        let (_, mut fields, _) = der_element(certificate);
        for _ in 0..4 {
            fields = der_element(fields).2;
        }
        let (_, validity, _) = der_element(fields);
        let (not_before_tag, not_before, rest) = der_element(validity);
        let (not_after_tag, not_after, _) = der_element(rest);
        assert_eq!((not_before_tag, not_after_tag), (UTC_TIME, UTC_TIME));

        (
            std::str::from_utf8(not_before).unwrap(),
            std::str::from_utf8(not_after).unwrap(),
        )
    }

    /// The embedded file is Supabase Root 2021 CA, valid from 2021-04-28 to
    /// 2031-04-26, and only that certificate: a swapped file fails here.
    #[test]
    fn the_embedded_root_is_the_published_supabase_root_2021_ca() {
        let certificates = CertificateDer::pem_slice_iter(SUPABASE_ROOT_PEM.as_bytes())
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(certificates.len(), 1);

        let sha256 = rustls::crypto::ring::cipher_suite::TLS13_AES_128_GCM_SHA256
            .tls13()
            .unwrap()
            .common
            .hash_provider;
        assert_eq!(
            sha256.algorithm(),
            rustls::crypto::hash::HashAlgorithm::SHA256
        );
        let fingerprint = sha256
            .hash(&certificates[0])
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(fingerprint, SUPABASE_ROOT_SHA256);
        assert_eq!(
            validity(&certificates[0]),
            ("210428105653Z", "310426105653Z")
        );
    }

    #[test]
    fn the_root_store_is_mozillas_roots_plus_the_supabase_root() {
        let mut supabase = RootCertStore::empty();
        supabase
            .add(CertificateDer::from_pem_slice(SUPABASE_ROOT_PEM.as_bytes()).unwrap())
            .unwrap();
        let anchor = &supabase.roots[0];
        assert!(!webpki_roots::TLS_SERVER_ROOTS.contains(anchor));

        let store = root_store(None).unwrap();
        let mozilla = webpki_roots::TLS_SERVER_ROOTS.len();
        assert_eq!(store.len(), mozilla + 1);
        assert_eq!(&store.roots[..mozilla], webpki_roots::TLS_SERVER_ROOTS);
        assert_eq!(&store.roots[mozilla], anchor);
    }

    #[test]
    fn an_sslrootcert_file_adds_every_certificate_it_holds() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("custom-ca.pem");
        std::fs::write(&path, SUPABASE_ROOT_PEM.repeat(2)).unwrap();

        let store = root_store(Some(&path)).unwrap();
        assert_eq!(store.len(), webpki_roots::TLS_SERVER_ROOTS.len() + 3);
    }

    #[test]
    fn a_missing_or_unparsable_sslrootcert_file_fails_naming_its_path() {
        let directory = tempfile::tempdir().unwrap();
        let mut paths = vec![directory.path().join("missing.pem")];
        for (name, body) in [
            ("empty.pem", ""),
            ("prose.pem", "not a certificate\n"),
            ("unterminated.pem", "-----BEGIN CERTIFICATE-----\nMIIB\n"),
            (
                "not-der.pem",
                "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
            ),
        ] {
            let path = directory.path().join(name);
            std::fs::write(&path, body).unwrap();
            paths.push(path);
        }

        for path in paths {
            let Err(Error::Db(message)) = root_store(Some(&path)) else {
                panic!("{} must fail as a database error", path.display());
            };
            assert!(
                message.starts_with(&format!("could not load sslrootcert={}: ", path.display())),
                "{message}"
            );
        }
    }

    /// A handshake failure shaped the way the driver holds one: a category
    /// whose source is the boxed error the TLS connector returned.
    #[derive(Debug)]
    struct Handshake(Box<dyn std::error::Error + Send + Sync>);

    impl std::fmt::Display for Handshake {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "error performing TLS handshake")
        }
    }

    impl std::error::Error for Handshake {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&*self.0)
        }
    }

    /// `problem` inside the `io::Error` tokio-rustls returns from a handshake.
    fn refused(problem: CertificateError) -> Handshake {
        Handshake(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(problem),
        )))
    }

    #[test]
    fn a_chain_no_trusted_root_signs_names_the_remedy() {
        assert_eq!(
            failure_text(&refused(CertificateError::UnknownIssuer)),
            "error performing TLS handshake: invalid peer certificate: UnknownIssuer: the server's certificate chain is signed by a CA the client does not trust; hosted Supabase chains end at the embedded Supabase Root 2021 CA, so re-check the host; for another CA pass `sslrootcert=<path to its PEM>` in the URL"
        );

        let unwrapped = Handshake(Box::new(rustls::Error::InvalidCertificate(
            CertificateError::UnknownIssuer,
        )));
        assert!(failure_text(&unwrapped).ends_with(UNKNOWN_ISSUER_REMEDY));
    }

    #[test]
    fn any_other_certificate_failure_reports_its_chain_alone() {
        let error = refused(CertificateError::NotValidForName);
        assert_eq!(failure_text(&error), source_chain(&error));
        assert!(!failure_text(&error).contains("sslrootcert"));
    }
}
