//! Hosted-Postgres URL policy: rustls does not honour `sslmode` inside
//! `ClientConfig`, so Kizuna decides TLS *before* connect.
//!
//! Hosted TCP always connects over rustls: a missing `sslmode` (the shape of
//! the dashboard's Connect strings), `prefer`, `require`, `verify-ca`, and
//! `verify-full` all select driver `Require`, and rustls verifies the chain and
//! the host name under every one of them, so `require` and `verify-ca` are as
//! strict here as libpq's `verify-full`. `disable` and `allow` are refused on a
//! remote host. Loopback TCP may omit `sslmode`. Unix sockets use `NoTls`.
//!
//! `sslrootcert=<path>`, the libpq key, names a PEM file whose certificates the
//! rustls store trusts on top of its defaults. The driver rejects keys it does
//! not know, so this one is taken out of the string it parses. Duplicate
//! `sslmode` keys are rejected so a trailing `disable` cannot downgrade a
//! passing guard, and duplicate `sslrootcert` keys so the trusted file is never
//! a guess.

use std::net::IpAddr;
use std::path::PathBuf;
use std::str::FromStr;

use postgres::Config;
use postgres::config::{Host, SslMode};

use crate::error::{Error, Result};

const SSLMODE: &str = "sslmode";
const SSLROOTCERT: &str = "sslrootcert";

/// rustls vs cleartext, chosen by [`prepare_connect`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsChoice {
    Rustls,
    NoTls,
}

/// A driver [`Config`], the connector [`postgres::Client::connect`] must use, and the
/// URL's `sslrootcert` file for the rustls store.
pub struct PreparedConnect {
    pub config: Config,
    pub tls: TlsChoice,
    pub root_cert: Option<PathBuf>,
}

/// Sentence hosted URLs get when they ask for a cleartext-capable `sslmode`.
pub const HOSTED_CLEARTEXT_REFUSED: &str =
    "hosted Postgres refuses sslmode=disable or sslmode=allow: remove it or set sslmode=require";

/// Parse `url`, enforce the hosted TLS policy, and return a connectable config.
///
/// # Errors
/// Returns [`Error::Db`] when the URL is malformed, lists `sslmode` or
/// `sslrootcert` twice, mixes Unix and TCP hosts, or targets a non-loopback
/// host with `sslmode=disable` or `sslmode=allow`.
pub fn prepare_connect(url: &str) -> Result<PreparedConnect> {
    let modes = param_values(url, SSLMODE);
    if modes.len() > 1 {
        return Err(Error::Db(
            "connection URL must not list sslmode more than once".into(),
        ));
    }

    let mode = modes.first().map(|value| value.to_ascii_lowercase());
    if let Some(value) = mode.as_deref()
        && !matches!(
            value,
            "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full"
        )
    {
        return Err(Error::Db(format!("unsupported sslmode={value}")));
    }

    let root_cert = root_cert(url)?;
    let mut config = Config::from_str(&driver_url(url))
        .map_err(|cause| Error::Db(format!("invalid Postgres URL: {cause}")))?;

    let unix = has_unix_host(&config);
    let remote = has_remote_tcp(&config);
    if unix && remote {
        return Err(Error::Db(
            "connection URL mixes Unix-socket and TCP hosts".into(),
        ));
    }

    if unix {
        config.ssl_mode(SslMode::Disable);
        return Ok(PreparedConnect {
            config,
            tls: TlsChoice::NoTls,
            root_cert,
        });
    }

    if remote {
        if let Some("disable" | "allow") = mode.as_deref() {
            return Err(Error::Db(HOSTED_CLEARTEXT_REFUSED.into()));
        }

        config.ssl_mode(SslMode::Require);
        return Ok(PreparedConnect {
            config,
            tls: TlsChoice::Rustls,
            root_cert,
        });
    }

    // Loopback TCP (remote already returned). Omit, disable, allow, and prefer
    // stay cleartext so local stacks without TLS keep working. Explicit
    // require / verify-ca / verify-full still selects rustls.
    if let Some("require" | "verify-ca" | "verify-full") = mode.as_deref() {
        config.ssl_mode(SslMode::Require);
        Ok(PreparedConnect {
            config,
            tls: TlsChoice::Rustls,
            root_cert,
        })
    } else {
        config.ssl_mode(SslMode::Disable);
        Ok(PreparedConnect {
            config,
            tls: TlsChoice::NoTls,
            root_cert,
        })
    }
}

/// Every value `key` takes in `conn`, a URL's query or a key-value string,
/// exactly as written.
fn param_values<'a>(conn: &'a str, key: &str) -> Vec<&'a str> {
    let pairs: Vec<&str> = if conn.contains("://") {
        conn.split_once('?')
            .map_or_else(Vec::new, |(_, query)| query.split('&').collect())
    } else {
        conn.split_whitespace().collect()
    };

    pairs
        .into_iter()
        .filter_map(|pair| pair.split_once('='))
        .filter(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value)
        .collect()
}

/// The `sslrootcert` path `conn` names. A URL's value is percent-decoded the
/// way libpq and the driver read URL parameters; a key-value string's is taken
/// as written, as libpq takes it.
fn root_cert(conn: &str) -> Result<Option<PathBuf>> {
    let values = param_values(conn, SSLROOTCERT);
    if values.len() > 1 {
        return Err(Error::Db(
            "connection URL must not list sslrootcert more than once".into(),
        ));
    }

    let Some(&raw) = values.first() else {
        return Ok(None);
    };
    let path = if conn.contains("://") {
        percent_decode(raw)
            .ok_or_else(|| Error::Db(format!("invalid percent-encoding in sslrootcert={raw}")))?
    } else {
        raw.to_owned()
    };

    Ok(Some(PathBuf::from(path)))
}

/// `value` with each `%XX` escape decoded. `+` stays a plus sign, as libpq
/// reads it; a truncated or non-hex escape, or bytes that are not UTF-8, is
/// `None`. `pub(crate)`: [`crate::db::split_db_url_password`] decodes a
/// `--db-url` userinfo or query password with it too.
pub(crate) fn percent_decode(value: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(value.len());
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            decoded.push(byte);
            continue;
        }

        let high = hex_digit(bytes.next()?)?;
        let low = hex_digit(bytes.next()?)?;
        decoded.push((high << 4) | low);
    }

    String::from_utf8(decoded).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}

/// `url` as the driver must parse it: without `sslrootcert`, which the driver
/// rejects and the rustls store reads instead, and with its `sslmode` value
/// spelled the way the driver parses it. The driver knows neither `verify-ca`,
/// `verify-full`, nor `allow`: both verifying modes become `require` (rustls
/// verifies anyway) and `allow` becomes `disable`, so the URL parses and the
/// policy above, not the driver, decides what a cleartext-capable mode means
/// for the host it names.
fn driver_url(url: &str) -> String {
    if let Some((head, query)) = url.split_once('?') {
        let pairs = query
            .split('&')
            .filter_map(driver_pair)
            .collect::<Vec<_>>()
            .join("&");
        return format!("{head}?{pairs}");
    }
    if url.contains("://") {
        return url.to_owned();
    }

    url.split_whitespace()
        .filter_map(driver_pair)
        .collect::<Vec<_>>()
        .join(" ")
}

fn driver_pair(pair: &str) -> Option<String> {
    let Some((key, value)) = pair.split_once('=') else {
        return Some(pair.to_owned());
    };
    if key.eq_ignore_ascii_case(SSLROOTCERT) {
        return None;
    }
    if !key.eq_ignore_ascii_case(SSLMODE) {
        return Some(pair.to_owned());
    }

    let value = value.to_ascii_lowercase();
    let driver = match value.as_str() {
        "verify-ca" | "verify-full" => "require",
        "allow" => "disable",
        other => other,
    };

    Some(format!("{key}={driver}"))
}

fn has_unix_host(config: &Config) -> bool {
    #[cfg(unix)]
    {
        config
            .get_hosts()
            .iter()
            .any(|host| matches!(host, Host::Unix(_)))
    }
    #[cfg(not(unix))]
    {
        let _ = config;
        false
    }
}

fn has_remote_tcp(config: &Config) -> bool {
    let remote_name = config.get_hosts().iter().any(|host| match host {
        Host::Tcp(name) => !is_loopback_host(name),
        #[cfg(unix)]
        Host::Unix(_) => false,
    });
    let remote_addr = config
        .get_hostaddrs()
        .iter()
        .any(|addr| !addr.is_loopback());
    remote_name || remote_addr
}

fn is_loopback_host(name: &str) -> bool {
    let trimmed = name.trim().trim_matches(|c| c == '[' || c == ']');
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }

    trimmed.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn loopback_without_sslmode_is_notls() {
        for url in [
            "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
            "postgresql://postgres:postgres@localhost:54322/postgres",
            "postgresql://postgres:postgres@[::1]:5432/postgres",
            "postgresql://postgres:postgres@127.0.0.2:5432/postgres",
        ] {
            let prepared = prepare_connect(url).unwrap();
            assert_eq!(prepared.tls, TlsChoice::NoTls);
            assert_eq!(prepared.config.get_ssl_mode(), SslMode::Disable);
        }
    }

    #[test]
    fn loopback_with_require_uses_rustls() {
        let prepared = prepare_connect(
            "postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=require",
        )
        .unwrap();
        assert_eq!(prepared.tls, TlsChoice::Rustls);
        assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require);
    }

    #[test]
    fn hosted_without_sslmode_connects_over_rustls() {
        for url in [
            "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
            "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
            "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
        ] {
            let prepared = prepare_connect(url).unwrap();
            assert_eq!(prepared.tls, TlsChoice::Rustls, "{url}");
            assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require, "{url}");
        }
    }

    #[test]
    fn hosted_with_require_is_ok() {
        let prepared = prepare_connect(
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require",
        )
        .unwrap();
        assert_eq!(prepared.tls, TlsChoice::Rustls);
        assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require);
    }

    #[test]
    fn hosted_verify_full_normalizes_to_require() {
        let prepared = prepare_connect(
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=verify-full",
        )
        .unwrap();
        assert_eq!(prepared.tls, TlsChoice::Rustls);
        assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require);
    }

    #[test]
    fn hosted_prefer_is_upgraded_to_require() {
        let prepared = prepare_connect(
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=prefer",
        )
        .unwrap();
        assert_eq!(prepared.tls, TlsChoice::Rustls);
        assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require);
    }

    #[test]
    fn duplicate_sslmode_is_rejected() {
        let error = prepare_connect(
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require&sslmode=disable",
        )
        .err()
        .expect("hosted URL must fail the TLS policy");
        assert!(matches!(error, Error::Db(ref message) if message.contains("more than once")));
    }

    #[cfg(unix)]
    #[test]
    fn unix_socket_uses_notls() {
        let prepared = prepare_connect("postgresql:///postgres?host=/var/run/postgresql").unwrap();
        assert_eq!(prepared.tls, TlsChoice::NoTls);
        assert_eq!(prepared.config.get_ssl_mode(), SslMode::Disable);
    }

    #[test]
    fn hosted_disable_is_refused() {
        let error = prepare_connect(
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=disable",
        )
        .err()
        .expect("hosted URL must fail the TLS policy");
        assert!(matches!(error, Error::Db(ref message) if message == HOSTED_CLEARTEXT_REFUSED));
        assert!(!error.to_string().contains("secret"));
    }

    #[test]
    fn hosted_allow_is_refused_by_the_policy_not_the_driver() {
        for mode in ["allow", "ALLOW", "Disable"] {
            let error = prepare_connect(&format!(
                "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode={mode}"
            ))
            .err()
            .expect("hosted URL must fail the TLS policy");
            assert!(
                matches!(error, Error::Db(ref message) if message == HOSTED_CLEARTEXT_REFUSED),
                "{mode}: {error}"
            );
        }

        let error = prepare_connect(
            "host=db.example.supabase.co user=postgres password=secret sslmode=allow",
        )
        .err()
        .expect("hosted key-value string must fail the TLS policy");
        assert!(matches!(error, Error::Db(ref message) if message == HOSTED_CLEARTEXT_REFUSED));
        assert!(!error.to_string().contains("secret"));
    }

    #[test]
    fn loopback_disable_allow_and_prefer_stay_cleartext() {
        for mode in ["disable", "allow", "prefer", "ALLOW"] {
            let prepared = prepare_connect(&format!(
                "postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode={mode}"
            ))
            .unwrap();
            assert_eq!(prepared.tls, TlsChoice::NoTls, "{mode}");
            assert_eq!(prepared.config.get_ssl_mode(), SslMode::Disable, "{mode}");
        }
    }

    #[test]
    fn verify_full_inside_the_password_is_not_rewritten() {
        let prepared = prepare_connect(
            "postgresql://u:sslmode=verify-full@db.example.supabase.co:5432/postgres?sslmode=require",
        )
        .unwrap();
        assert_eq!(prepared.tls, TlsChoice::Rustls);
        assert_eq!(
            prepared.config.get_password(),
            Some(&b"sslmode=verify-full"[..])
        );
    }

    #[test]
    fn verify_full_in_password_and_query_does_not_panic() {
        let prepared = prepare_connect(
            "postgresql://u:sslmode=verify-full@db.example.supabase.co:5432/postgres?sslmode=verify-full",
        )
        .unwrap();
        assert_eq!(prepared.tls, TlsChoice::Rustls);
        assert_eq!(
            prepared.config.get_password(),
            Some(&b"sslmode=verify-full"[..])
        );
        assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require);
    }

    #[test]
    fn verify_ca_uses_rustls_like_verify_full() {
        for url in [
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=verify-ca",
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=verify-ca",
            "host=db.example.supabase.co user=postgres password=secret sslmode=VERIFY-CA",
        ] {
            let prepared = prepare_connect(url).unwrap();
            assert_eq!(prepared.tls, TlsChoice::Rustls, "{url}");
            assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require, "{url}");
        }
    }

    #[test]
    fn sslrootcert_goes_to_the_tls_store_and_never_to_the_driver() {
        // The driver refuses the key outright, so every Ok below proves it was taken out.
        assert!(
            Config::from_str(
                "postgresql://postgres@db.example.supabase.co/postgres?sslrootcert=/ca.pem"
            )
            .is_err()
        );

        for url in [
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslrootcert=/etc/ssl/Custom-CA.pem&sslmode=verify-full",
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require&sslrootcert=/etc/ssl/Custom-CA.pem",
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslrootcert=/etc/ssl/Custom-CA.pem",
            "host=db.example.supabase.co user=postgres password=secret dbname=postgres sslrootcert=/etc/ssl/Custom-CA.pem",
        ] {
            let prepared = prepare_connect(url).unwrap();
            assert_eq!(
                prepared.root_cert,
                Some(PathBuf::from("/etc/ssl/Custom-CA.pem")),
                "{url}"
            );
            assert_eq!(prepared.tls, TlsChoice::Rustls, "{url}");
            assert_eq!(prepared.config.get_ssl_mode(), SslMode::Require, "{url}");
            assert_eq!(prepared.config.get_dbname(), Some("postgres"), "{url}");
        }
    }

    #[test]
    fn without_sslrootcert_no_extra_root_file_is_named() {
        for url in [
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require",
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        ] {
            assert_eq!(prepare_connect(url).unwrap().root_cert, None, "{url}");
        }
    }

    #[test]
    fn duplicate_sslrootcert_is_rejected() {
        for url in [
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslrootcert=/a.pem&sslrootcert=/b.pem",
            "postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslrootcert=/a.pem&SSLROOTCERT=/a.pem",
            "host=db.example.supabase.co user=postgres sslrootcert=/a.pem sslrootcert=/b.pem",
        ] {
            let error = prepare_connect(url)
                .err()
                .expect("a URL naming two root files must fail");
            assert!(
                matches!(error, Error::Db(ref message) if message == "connection URL must not list sslrootcert more than once"),
                "{url}: {error}"
            );
        }
    }

    #[test]
    fn a_url_sslrootcert_is_percent_decoded_like_libpq() {
        for (url, path) in [
            (
                "postgresql://postgres@db.example.com/postgres?sslrootcert=%2Fetc%2Fssl%2FMy%20CA.pem",
                "/etc/ssl/My CA.pem",
            ),
            (
                "postgresql://postgres@db.example.com/postgres?sslrootcert=%2fetc%2fssl%2f100%25%26more.pem",
                "/etc/ssl/100%&more.pem",
            ),
            (
                "postgresql://postgres@db.example.com/postgres?sslrootcert=/etc/ssl/a+b.pem",
                "/etc/ssl/a+b.pem",
            ),
            (
                "host=db.example.com user=postgres sslrootcert=/etc/ssl/100%25.pem",
                "/etc/ssl/100%25.pem",
            ),
        ] {
            assert_eq!(
                prepare_connect(url).unwrap().root_cert,
                Some(PathBuf::from(path)),
                "{url}"
            );
        }
    }

    #[test]
    fn a_bad_percent_escape_in_sslrootcert_is_refused() {
        for raw in [
            "/etc/ssl/ca.pem%",
            "/etc/ssl/ca.pem%2",
            "/etc/ssl/%ZZca.pem",
            "/etc/ssl/%2Gca.pem",
            "/etc/ssl/%FFca.pem",
        ] {
            let error = prepare_connect(&format!(
                "postgresql://postgres@db.example.com/postgres?sslrootcert={raw}"
            ))
            .err()
            .expect("a bad escape must fail");
            assert!(
                matches!(error, Error::Db(ref message) if *message == format!("invalid percent-encoding in sslrootcert={raw}")),
                "{raw}: {error}"
            );
        }
    }
}
