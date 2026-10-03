//! Direct Postgres access: connection resolution, redaction, and the
//! schema-parameterized introspection queries.
//!
//! Connection resolution order (`resolve_db_url`): the `--db-url` flag, then
//! [`URL_KEYS`] from the process environment, the same keys from the project's
//! `.env` files, then a local fallback parsed from the project's
//! `supabase/config.toml` (`[db] port`, defaulting to Supabase's documented
//! 54322 when the key is absent): a plain file read, never a CLI spawn. The
//! process environment always outranks a file, so an explicit shell export is
//! never shadowed by a checked-in default. Every URL handed back for logging
//! goes through [`redact_db_url`] first.

use std::fmt;
use std::sync::OnceLock;

use regex::Regex;

use crate::env::Env;
use crate::env_file::EnvFileValues;
use crate::error::{Error, Result};
use crate::tls_url::percent_decode;
use crate::ui::Ui;
use crate::workdir::ProjectPaths;

/// Which rung of the resolution ladder produced the connection string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbUrlSource {
    /// The `--db-url` flag.
    Flag,
    /// The `KSYNC_DB_URL` environment variable.
    EnvKizunaSyncDbUrl,
    /// The `DIRECT_URL` environment variable.
    EnvDirectUrl,
    /// The `POSTGRES_URL_NON_POOLING` environment variable.
    EnvPostgresUrlNonPooling,
    /// The `DATABASE_URL` environment variable.
    EnvDatabaseUrl,
    /// The `POSTGRES_URL` environment variable.
    EnvPostgresUrl,
    /// `KSYNC_DB_URL`, in the named `.env` file.
    DotenvKizunaSyncDbUrl(&'static str),
    /// `DIRECT_URL`, in the named `.env` file.
    DotenvDirectUrl(&'static str),
    /// `POSTGRES_URL_NON_POOLING`, in the named `.env` file.
    DotenvPostgresUrlNonPooling(&'static str),
    /// `DATABASE_URL`, in the named `.env` file.
    DotenvDatabaseUrl(&'static str),
    /// `POSTGRES_URL`, in the named `.env` file.
    DotenvPostgresUrl(&'static str),
    /// The project's `supabase/config.toml` `[db] port`.
    LocalConfig,
}

impl DbUrlSource {
    /// The input that declared the URL, as the user would name it.
    #[must_use]
    pub const fn key(&self) -> &'static str {
        match self {
            Self::Flag => "--db-url",
            Self::EnvKizunaSyncDbUrl | Self::DotenvKizunaSyncDbUrl(_) => "KSYNC_DB_URL",
            Self::EnvDirectUrl | Self::DotenvDirectUrl(_) => "DIRECT_URL",
            Self::EnvPostgresUrlNonPooling | Self::DotenvPostgresUrlNonPooling(_) => {
                "POSTGRES_URL_NON_POOLING"
            }
            Self::EnvDatabaseUrl | Self::DotenvDatabaseUrl(_) => "DATABASE_URL",
            Self::EnvPostgresUrl | Self::DotenvPostgresUrl(_) => "POSTGRES_URL",
            Self::LocalConfig => "supabase/config.toml",
        }
    }

    /// Whether the user named this URL outright (the flag or the process
    /// environment) rather than a file declaring it.
    #[must_use]
    pub const fn is_explicit(&self) -> bool {
        matches!(
            self,
            Self::Flag
                | Self::EnvKizunaSyncDbUrl
                | Self::EnvDirectUrl
                | Self::EnvPostgresUrlNonPooling
                | Self::EnvDatabaseUrl
                | Self::EnvPostgresUrl
        )
    }
}

impl std::fmt::Display for DbUrlSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Flag => f.write_str("flag"),
            Self::EnvKizunaSyncDbUrl
            | Self::EnvDirectUrl
            | Self::EnvPostgresUrlNonPooling
            | Self::EnvDatabaseUrl
            | Self::EnvPostgresUrl => write!(f, "env:{}", self.key()),
            Self::DotenvKizunaSyncDbUrl(file)
            | Self::DotenvDirectUrl(file)
            | Self::DotenvPostgresUrlNonPooling(file)
            | Self::DotenvDatabaseUrl(file)
            | Self::DotenvPostgresUrl(file) => write!(f, "{} from {file}", self.key()),
            Self::LocalConfig => f.write_str("local-config"),
        }
    }
}

/// One connection-string key the ladder reads, and the rung it names in the
/// process environment and in a `.env` file.
pub struct UrlKey {
    /// The variable name.
    pub name: &'static str,
    env: DbUrlSource,
    dotenv: fn(&'static str) -> DbUrlSource,
}

/// The connection-string keys, in the order both the process environment and
/// the `.env` files are read: Kizuna's own, then the direct URLs Prisma and the
/// Vercel Supabase integration write, then their pooled counterparts.
pub const URL_KEYS: [UrlKey; 5] = [
    UrlKey {
        name: "KSYNC_DB_URL",
        env: DbUrlSource::EnvKizunaSyncDbUrl,
        dotenv: DbUrlSource::DotenvKizunaSyncDbUrl,
    },
    UrlKey {
        name: "DIRECT_URL",
        env: DbUrlSource::EnvDirectUrl,
        dotenv: DbUrlSource::DotenvDirectUrl,
    },
    UrlKey {
        name: "POSTGRES_URL_NON_POOLING",
        env: DbUrlSource::EnvPostgresUrlNonPooling,
        dotenv: DbUrlSource::DotenvPostgresUrlNonPooling,
    },
    UrlKey {
        name: "DATABASE_URL",
        env: DbUrlSource::EnvDatabaseUrl,
        dotenv: DbUrlSource::DotenvDatabaseUrl,
    },
    UrlKey {
        name: "POSTGRES_URL",
        env: DbUrlSource::EnvPostgresUrl,
        dotenv: DbUrlSource::DotenvPostgresUrl,
    },
];

/// A resolved connection plus the rung it came from.
#[derive(Clone)]
pub struct ResolvedDbUrl {
    /// The connection string, unredacted.
    pub url: String,
    /// Where it was found.
    pub source: DbUrlSource,
}

impl fmt::Debug for ResolvedDbUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedDbUrl")
            .field("url", &redact_db_url(&self.url))
            .field("source", &self.source)
            .finish()
    }
}

/// Supabase's documented default local Postgres port (used when config.toml
/// exists but its `[db]` section omits `port`, or the file does not parse).
const LOCAL_DEFAULT_PORT: u16 = 54322;

/// Resolve a connection string, or explain every rung that was tried.
///
/// # Errors
/// Returns [`Error::Db`] carrying the full explanation, rung by rung, when
/// nothing resolves.
pub fn resolve_db_url(
    flag: Option<&str>,
    env: &Env,
    env_files: &EnvFileValues,
    paths: &ProjectPaths,
) -> Result<ResolvedDbUrl> {
    if let Some(url) = flag.filter(|value| !value.is_empty()) {
        return Ok(ResolvedDbUrl {
            url: url.to_owned(),
            source: DbUrlSource::Flag,
        });
    }

    for key in &URL_KEYS {
        if let Some(url) = env.get(key.name) {
            return Ok(ResolvedDbUrl {
                url: url.to_owned(),
                source: key.env,
            });
        }
    }

    for key in &URL_KEYS {
        if let Some((url, file)) = env_files.get_with_origin(key.name) {
            return Ok(ResolvedDbUrl {
                url: url.to_owned(),
                source: (key.dotenv)(file),
            });
        }
    }

    if paths.config_toml.exists() {
        let port = std::fs::read_to_string(&paths.config_toml)
            .map_or(LOCAL_DEFAULT_PORT, |text| parse_config_toml_port(&text));

        return Ok(ResolvedDbUrl {
            url: format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres"),
            source: DbUrlSource::LocalConfig,
        });
    }

    Err(Error::Db(resolution_error(
        &paths.config_toml.display().to_string(),
    )))
}

fn resolution_error(config_path: &str) -> String {
    let keys = URL_KEYS.map(|key| key.name).join(", ");
    let files = crate::env_file::FILE_NAMES.join(", ");

    format!(
        "could not resolve a database connection. Tried, in order:\n\
         \x20   1. the --db-url flag: not given\n\
         \x20   2. the environment variables {keys}: not set\n\
         \x20   3. the same keys in {files}: not set\n\
         \x20   4. {config_path}: not found\n\
         \x20 Set one of the above, or run this from a directory with a supabase/config.toml.\n\
         \x20 For a hosted project, use the session pooler URL (not the transport pooler on 6543,\n\
         \x20 and not the IPv6 direct host):\n\
         \x20   postgres://postgres.<project-ref>:[PASSWORD]@aws-<region>.pooler.supabase.com:5432/postgres\n\
         \x20 Hosted URLs always connect over TLS: the CLI refuses sslmode=disable and sslmode=allow to remote hosts."
    )
}

/// The `[db]` section's `port` from a `supabase/config.toml` body, or
/// Supabase's documented default when the section or the key is absent or the
/// body does not parse.
#[must_use]
pub fn parse_config_toml_port(text: &str) -> u16 {
    crate::supabase_config::read(text)
        .db
        .port
        .unwrap_or(LOCAL_DEFAULT_PORT)
}

/// What [`redact_db_url`] returns when its pattern is unavailable: failing
/// closed keeps a credential out of output/errors instead of passing the raw
/// URL through unredacted.
const REDACTION_UNAVAILABLE: &str = "<db url redacted>";

/// Masks every password a Postgres connection string can carry: every URL or
/// conninfo string echoed in output or errors, or a `supabase` child's
/// stderr, must pass through this first.
///
/// A URI's userinfo password (`scheme://user:password@host`, the password
/// possibly carrying a raw, unencoded `@`) and its `?password=`/`&password=`
/// query pair are both masked; libpq's alternative space-separated
/// `key=value` conninfo form (no `://`, the form the `tls_url` module also
/// parses) has its `password=` pair masked the same way.
#[must_use]
pub fn redact_db_url(url: &str) -> String {
    if !url.contains("://") {
        return redact_conninfo_password(url);
    }

    let masked = redact_with_pattern(userinfo_password_pattern(), url);

    redact_query_password(&masked)
}

/// The compiled userinfo-password pattern, shared with
/// [`split_db_url_password`]: group 1 is `scheme://user`, group 2 is the
/// password. Greedy backtracking finds the *last* `@` before the authority's
/// first `/`, so a password carrying a raw `@` is captured whole rather than
/// truncated at its first character.
fn userinfo_password_pattern() -> Option<&'static Regex> {
    static PATTERN: OnceLock<Option<Regex>> = OnceLock::new();

    PATTERN
        .get_or_init(|| Regex::new(r"^([0-9A-Za-z_]+://[^:/@]+):([^/]*)@").ok())
        .as_ref()
}

/// The redaction step, taking the compiled pattern directly so the
/// pattern-unavailable branch can be exercised without depending on
/// `OnceLock`'s process-global, set-once state.
fn redact_with_pattern(pattern: Option<&Regex>, url: &str) -> String {
    pattern.map_or_else(
        || REDACTION_UNAVAILABLE.to_owned(),
        |pattern| pattern.replace(url, "$1:***@").into_owned(),
    )
}

/// Masks a `password` pair in a URL's query string, case-insensitive on the
/// key: some tools hand Kizuna a connection string with the password only in
/// `?password=…`, alongside or instead of the userinfo.
fn redact_query_password(url: &str) -> String {
    let Some(query_start) = url.find('?') else {
        return url.to_owned();
    };
    let query_end = url[query_start..]
        .find('#')
        .map_or(url.len(), |offset| query_start + offset);
    let redacted: Vec<String> = url[query_start + 1..query_end]
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if key.eq_ignore_ascii_case("password") => format!("{key}=***"),
            _ => pair.to_owned(),
        })
        .collect();

    format!(
        "{}{}{}",
        &url[..=query_start],
        redacted.join("&"),
        &url[query_end..]
    )
}

/// Masks a `password=…` pair in libpq's space-separated `key=value` conninfo
/// form.
fn redact_conninfo_password(conn: &str) -> String {
    conn.split_whitespace()
        .map(|pair| match pair.split_once('=') {
            Some((key, _)) if key.eq_ignore_ascii_case("password") => format!("{key}=***"),
            _ => pair.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `url` with every password it carries removed, and the password itself for
/// `PGPASSWORD`: the `supabase` child's argv must never carry a database
/// password.
///
/// A URI loses its userinfo password (`user:password@` becomes `user@`) and
/// every `password` query pair, whatever the key's case; a key-value conninfo
/// string loses its `password` pairs. A URI's password is percent-decoded and
/// a conninfo value is taken as written, as libpq reads each form. When a URI
/// carries both, the query's value is the one returned, since a connection
/// reads the query after the userinfo. `None` when no non-empty password is
/// present: a `--linked`/`--local` push, a URL with a bare user, or an empty
/// password (`user:@host`, `?password=`), itself taken as "no password".
#[must_use]
pub fn split_db_url_password(url: &str) -> (String, Option<String>) {
    if !url.contains("://") {
        return split_conninfo_password(url);
    }

    let (without_userinfo, userinfo_password) = split_userinfo_password(url);
    let (stripped, query_password) = split_query_password(&without_userinfo);

    (stripped, query_password.or(userinfo_password))
}

/// The userinfo half of [`split_db_url_password`].
fn split_userinfo_password(url: &str) -> (String, Option<String>) {
    let Some(pattern) = userinfo_password_pattern() else {
        return (url.to_owned(), None);
    };
    let Some(captures) = pattern.captures(url) else {
        return (url.to_owned(), None);
    };
    let whole_end = captures.get(0).map_or(0, |m| m.end());
    let scheme_and_user = captures.get(1).map_or("", |m| m.as_str());
    let encoded = captures.get(2).map_or("", |m| m.as_str());
    let stripped = format!("{scheme_and_user}@{}", &url[whole_end..]);
    if encoded.is_empty() {
        return (stripped, None);
    }

    let password = percent_decode(encoded).unwrap_or_else(|| encoded.to_owned());

    (stripped, Some(password))
}

/// The query half of [`split_db_url_password`]: every `password` pair leaves
/// the query, the first non-empty value is returned percent-decoded, and a
/// query left with no pair loses its `?`.
fn split_query_password(url: &str) -> (String, Option<String>) {
    let Some(query_start) = url.find('?') else {
        return (url.to_owned(), None);
    };
    let query_end = url[query_start..]
        .find('#')
        .map_or(url.len(), |offset| query_start + offset);
    let mut password = None;
    let mut kept = Vec::new();
    for pair in url[query_start + 1..query_end].split('&') {
        match pair.split_once('=') {
            Some((key, value)) if key.eq_ignore_ascii_case("password") => {
                if password.is_none() && !value.is_empty() {
                    password = Some(percent_decode(value).unwrap_or_else(|| value.to_owned()));
                }
            }
            _ => kept.push(pair),
        }
    }
    let query = if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    };

    (
        format!("{}{query}{}", &url[..query_start], &url[query_end..]),
        password,
    )
}

/// The key-value conninfo half of [`split_db_url_password`], split the way
/// [`redact_conninfo_password`] reads the same form.
fn split_conninfo_password(conn: &str) -> (String, Option<String>) {
    let mut password = None;
    let mut kept = Vec::new();
    for pair in conn.split_whitespace() {
        match pair.split_once('=') {
            Some((key, value)) if key.eq_ignore_ascii_case("password") => {
                if password.is_none() && !value.is_empty() {
                    password = Some(value.to_owned());
                }
            }
            _ => kept.push(pair),
        }
    }

    (kept.join(" "), password)
}

/// `value` quoted for a POSIX shell when it carries anything but the
/// characters a bare word or a Postgres URL commonly uses: an operator hint
/// built from this stays one command an operator can copy and run, even when
/// a `--db-url` value carries `&`, `?`, `$`, or a space.
#[must_use]
pub fn shell_quote(value: &str) -> String {
    let bare = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '@'));
    if bare {
        return value.to_owned();
    }

    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The Supabase pooler's host suffix and transaction-mode port, as one
/// authority tail.
const TRANSACTION_POOLER_TAIL: &str = ".pooler.supabase.com:6543";

/// The same pooler's session-mode port.
const SESSION_POOLER_PORT: &str = "5432";

/// `url` moved from the Supabase transaction pooler (port 6543) to its session
/// mode (5432) on the same host, user, password, database, and query, or `None`
/// when `url` does not name the transaction pooler. Transaction mode does not
/// support prepared statements, which the catalog reads and DDL rely on.
#[must_use]
pub fn session_mode_url(url: &str) -> Option<String> {
    let tail = url.find(TRANSACTION_POOLER_TAIL)?;
    let end = tail + TRANSACTION_POOLER_TAIL.len();
    if !matches!(url[end..].chars().next(), None | Some('/' | '?')) {
        return None;
    }

    // The label in front of the suffix must be the host itself, opened by the
    // userinfo's `@` or the scheme's `//`, so a password that merely contains
    // the suffix is never rewritten.
    let opener = url[..tail].rfind(['@', '/'])?;
    let label = &url[opener + 1..tail];
    if label.is_empty()
        || !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return None;
    }

    let port = end - "6543".len();

    Some(format!(
        "{}{SESSION_POOLER_PORT}{}",
        &url[..port],
        &url[end..]
    ))
}

/// The connection to open for `url`: [`session_mode_url`]'s rewrite when it
/// applies, announced on `ui` under `label` (the input that declared the URL),
/// else `url` itself.
#[must_use]
pub fn session_mode(url: String, label: &str, ui: &mut Ui) -> String {
    let Some(rewritten) = session_mode_url(&url) else {
        return url;
    };

    ui.log(&format!("  {}", transaction_pooler_note(label)));

    rewritten
}

/// The line that announces [`session_mode_url`]'s rewrite of the URL `label`
/// declared.
#[must_use]
pub fn transaction_pooler_note(label: &str) -> String {
    format!(
        "{label} points at the transaction pooler (6543); using session mode on 5432 for catalog reads and DDL"
    )
}

/// A valid unquoted Postgres identifier: letter/underscore, then
/// letters/digits/underscores, up to the 63-byte NAMEDATALEN limit.
/// Fully-composed statements are what reach the transport, so every schema or
/// table name interpolated into one MUST pass this first: flag- and
/// env-sourced input is untrusted.
#[must_use]
pub fn is_valid_schema_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    if name.len() > 63 {
        return false;
    }

    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Doubles embedded single quotes for safe use inside a `'…'` SQL string
/// literal. Belt-and-braces alongside [`is_valid_schema_name`]: a name matching
/// that predicate can never contain a quote, so this never actually fires on
/// validated input.
#[must_use]
pub fn escape_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// `value` with every control character removed, safe to embed in a
/// `-- …` SQL line comment: a raw newline would end the comment early and let
/// whatever followed run as real SQL, and a stray CR or other control byte
/// can confuse a naive `-- ` reader too. Belt-and-braces alongside
/// [`is_valid_schema_name`] and the catalog's own control-character refusal
/// ([`crate::proposals::introspect_catalog`]): validated input never actually
/// loses anything here.
#[must_use]
pub fn strip_control_chars(value: &str) -> String {
    value.chars().filter(|c| !c.is_control()).collect()
}

/// Validate then escape a schema name for interpolation into a WHERE-clause
/// literal.
///
/// # Errors
/// Returns [`Error::Db`] on an invalid identifier, so a caller that bypasses an
/// up-front check still cannot get unchecked input into a composed statement.
pub fn assert_schema_literal(schema: &str) -> Result<String> {
    if is_valid_schema_name(schema) {
        return Ok(escape_literal(schema));
    }

    Err(Error::Db(format!("invalid schema name: {schema:?}")))
}

/// Base tables (excludes views) for the given schema.
///
/// # Errors
/// Returns [`Error::Db`] when `schema` is not a valid Postgres identifier.
pub fn tables_query(schema: &str) -> Result<String> {
    let literal = assert_schema_literal(schema)?;

    Ok(format!(
        "select table_name\nfrom information_schema.tables\nwhere table_schema = '{literal}'\n  and table_type = 'BASE TABLE'\norder by table_name;"
    ))
}

/// Column name + `data_type` for every table in the given schema.
///
/// # Errors
/// Returns [`Error::Db`] when `schema` is not a valid Postgres identifier.
pub fn columns_query(schema: &str) -> Result<String> {
    let literal = assert_schema_literal(schema)?;

    Ok(format!(
        "select table_name, column_name, data_type\nfrom information_schema.columns\nwhere table_schema = '{literal}'\norder by table_name, ordinal_position;"
    ))
}

/// The `pg_policies` read, parameterized off the schema.
///
/// # Errors
/// Returns [`Error::Db`] when `schema` is not a valid Postgres identifier.
pub fn policies_query(schema: &str) -> Result<String> {
    let literal = assert_schema_literal(schema)?;

    Ok(format!(
        "select tablename, coalesce(qual, '') as qual\nfrom pg_policies\nwhere schemaname = '{literal}'\norder by tablename;"
    ))
}

/// The base tables in `schema` whose row level security is disabled.
///
/// # Errors
/// Returns [`Error::Db`] when `schema` is not a valid Postgres identifier.
pub fn rls_disabled_query(schema: &str) -> Result<String> {
    let literal = assert_schema_literal(schema)?;

    Ok(format!(
        "select c.relname as table_name\nfrom pg_class c\njoin pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = '{literal}'\n  and c.relkind in ('r', 'p')\n  and not c.relrowsecurity\norder by c.relname;"
    ))
}

/// The primary key of every table in `schema` that has one: the constraint's
/// name, which is also its index's, then each key column in key order with its
/// declared type, the type under every domain it is declared as, its identity
/// (`a` always, `d` by default, null for none), and its default.
///
/// A domain over a domain names its parent in `typbasetype`, so the base type
/// is the end of that walk rather than one step of it.
///
/// # Errors
/// Returns [`Error::Db`] when `schema` is not a valid Postgres identifier.
pub fn primary_keys_query(schema: &str) -> Result<String> {
    let literal = assert_schema_literal(schema)?;

    Ok(format!(
        "select t.relname as table_name, ic.relname as constraint_name, a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type, base.base_type, nullif(a.attidentity::text, '') as identity, pg_get_expr(d.adbin, d.adrelid) as default_expression\n\
         from pg_index i\n\
         join pg_class t on t.oid = i.indrelid\n\
         join pg_class ic on ic.oid = i.indexrelid\n\
         join pg_namespace n on n.oid = t.relnamespace\n\
         join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, position) on true\n\
         join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum\n\
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum\n\
         join lateral (\n\
           with recursive walk(oid, basetype) as (\n\
             select ty.oid, ty.typbasetype from pg_type ty where ty.oid = a.atttypid\n\
             union all\n\
             select ty.oid, ty.typbasetype from pg_type ty join walk w on ty.oid = w.basetype\n\
           )\n\
           select format_type(walk.oid, null) as base_type from walk where walk.basetype = 0\n\
         ) base on true\n\
         where i.indisprimary\n\
           and n.nspname = '{literal}'\n\
         order by t.relname, k.position;"
    ))
}

/// Columns in `schema` whose foreign key targets `auth.users`.
///
/// A profile table often has no `auth.uid()` policy and still belongs to the
/// account through `id` (or `user_id`) referencing `auth.users`. The wizard
/// suggests that column as the owner when RLS did not name one.
///
/// # Errors
/// Returns [`Error::Db`] when `schema` is not a valid Postgres identifier.
pub fn auth_user_fk_query(schema: &str) -> Result<String> {
    let literal = assert_schema_literal(schema)?;

    Ok(format!(
        "select src.relname as table_name, att.attname as column_name\n\
         from pg_constraint con\n\
         join pg_class src on src.oid = con.conrelid\n\
         join pg_namespace src_ns on src_ns.oid = src.relnamespace\n\
         join pg_class dst on dst.oid = con.confrelid\n\
         join pg_namespace dst_ns on dst_ns.oid = dst.relnamespace\n\
         join lateral unnest(con.conkey) as src_att(attnum) on true\n\
         join pg_attribute att on att.attrelid = src.oid and att.attnum = src_att.attnum and not att.attisdropped\n\
         where con.contype = 'f'\n\
           and src_ns.nspname = '{literal}'\n\
           and dst_ns.nspname = 'auth'\n\
           and dst.relname = 'users'\n\
         order by src.relname, att.attnum;"
    ))
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    /// A project root that exists nowhere: every filesystem rung misses.
    fn nowhere() -> ProjectPaths {
        ProjectPaths::rooted_at(PathBuf::from("/nowhere"))
    }

    fn dotenv(pairs: &[(&str, &str)]) -> (tempfile::TempDir, EnvFileValues) {
        let dir = tempfile::tempdir().unwrap();
        let body: Vec<String> = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        std::fs::write(dir.path().join(".env"), body.join("\n")).unwrap();
        let values = crate::env_file::load(dir.path());

        (dir, values)
    }

    fn project_at(root: &Path) -> ProjectPaths {
        ProjectPaths::rooted_at(root.to_path_buf())
    }

    #[test]
    fn the_flag_wins_over_every_environment_variable() {
        let env = Env::from_pairs(&[
            ("KSYNC_DB_URL", "env-kizunasync"),
            ("DATABASE_URL", "env-database"),
        ]);
        let (_guard, files) = dotenv(&[("KSYNC_DB_URL", "dotenv-kizunasync")]);
        let resolved = resolve_db_url(Some("flag-url"), &env, &files, &nowhere()).unwrap();

        assert_eq!(resolved.url, "flag-url");
        assert_eq!(resolved.source, DbUrlSource::Flag);
    }

    #[test]
    fn the_environment_keys_resolve_in_the_documented_order() {
        let all = [
            ("KSYNC_DB_URL", DbUrlSource::EnvKizunaSyncDbUrl),
            ("DIRECT_URL", DbUrlSource::EnvDirectUrl),
            (
                "POSTGRES_URL_NON_POOLING",
                DbUrlSource::EnvPostgresUrlNonPooling,
            ),
            ("DATABASE_URL", DbUrlSource::EnvDatabaseUrl),
            ("POSTGRES_URL", DbUrlSource::EnvPostgresUrl),
        ];
        for skipped in 0..all.len() {
            let pairs: Vec<(&str, &str)> =
                all[skipped..].iter().map(|(key, _)| (*key, *key)).collect();
            let resolved = resolve_db_url(
                None,
                &Env::from_pairs(&pairs),
                &EnvFileValues::default(),
                &nowhere(),
            )
            .unwrap();

            assert_eq!(resolved.url, all[skipped].0);
            assert_eq!(resolved.source, all[skipped].1);
            assert_eq!(
                resolved.source.to_string(),
                format!("env:{}", all[skipped].0)
            );
            assert!(resolved.source.is_explicit());
        }
    }

    #[test]
    fn the_env_file_keys_resolve_in_the_same_order() {
        let (_guard, files) = dotenv(&[
            ("POSTGRES_URL", "pooled"),
            ("DATABASE_URL", "database"),
            ("POSTGRES_URL_NON_POOLING", "non-pooling"),
            ("DIRECT_URL", "direct"),
        ]);
        let resolved = resolve_db_url(None, &Env::default(), &files, &nowhere()).unwrap();

        assert_eq!(resolved.url, "direct");
        assert_eq!(resolved.source, DbUrlSource::DotenvDirectUrl(".env"));
        assert!(!resolved.source.is_explicit());

        let (_guard, files) = dotenv(&[("POSTGRES_URL", "pooled")]);
        let resolved = resolve_db_url(None, &Env::default(), &files, &nowhere()).unwrap();

        assert_eq!(resolved.source.to_string(), "POSTGRES_URL from .env");
    }

    #[test]
    fn the_later_env_file_wins_and_is_named() {
        let dir = tempfile::tempdir().unwrap();
        for (name, value) in [
            (".env", "base"),
            (".env.development", "development"),
            (".env.local", "local"),
            (".env.development.local", "development-local"),
        ] {
            std::fs::write(dir.path().join(name), format!("DIRECT_URL={value}\n")).unwrap();
        }
        let files = crate::env_file::load(dir.path());
        let resolved = resolve_db_url(None, &Env::default(), &files, &nowhere()).unwrap();

        assert_eq!(resolved.url, "development-local");
        assert_eq!(
            resolved.source.to_string(),
            "DIRECT_URL from .env.development.local"
        );
    }

    #[test]
    fn the_transaction_pooler_is_moved_to_session_mode() {
        assert_eq!(
            session_mode_url(
                "postgresql://postgres.abcd:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require"
            )
            .as_deref(),
            Some(
                "postgresql://postgres.abcd:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require"
            )
        );
        assert_eq!(
            session_mode_url("postgres://u:p@aws-1-us-east-1.pooler.supabase.com:6543").as_deref(),
            Some("postgres://u:p@aws-1-us-east-1.pooler.supabase.com:5432")
        );
    }

    #[test]
    fn a_6543_url_that_is_not_the_supabase_pooler_is_left_alone() {
        for url in [
            "postgresql://postgres:pw@db.example.com:6543/postgres",
            "postgresql://postgres:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
            "postgresql://postgres:pw@aws-0.pooler.supabase.com:65430/postgres",
            "postgresql://postgres:x.pooler.supabase.com:6543@db.example.com:6543/postgres",
            "postgresql://postgres:pw@evil.pooler.supabase.com.example:6543/postgres",
        ] {
            assert_eq!(session_mode_url(url), None, "{url}");
        }
    }

    #[test]
    fn session_mode_announces_the_rewrite_under_the_declaring_key() {
        let (mut ui, capture) = Ui::capture();
        let url = session_mode(
            "postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres".to_owned(),
            "DATABASE_URL",
            &mut ui,
        );

        assert!(url.contains(".pooler.supabase.com:5432/"), "{url}");
        assert!(capture.stderr().contains(
            "DATABASE_URL points at the transaction pooler (6543); using session mode on 5432 for catalog reads and DDL"
        ));

        let (mut ui, capture) = Ui::capture();
        let untouched = session_mode(
            "postgres://u:p@db.example:6543/x".to_owned(),
            "DATABASE_URL",
            &mut ui,
        );

        assert_eq!(untouched, "postgres://u:p@db.example:6543/x");
        assert!(capture.stderr().is_empty());
    }

    #[test]
    fn kizunasync_db_url_wins_over_database_url() {
        let env = Env::from_pairs(&[
            ("KSYNC_DB_URL", "env-kizunasync"),
            ("DATABASE_URL", "env-database"),
        ]);
        let resolved = resolve_db_url(None, &env, &EnvFileValues::default(), &nowhere()).unwrap();

        assert_eq!(resolved.url, "env-kizunasync");
        assert_eq!(resolved.source, DbUrlSource::EnvKizunaSyncDbUrl);
    }

    #[test]
    fn database_url_is_the_third_rung() {
        let env = Env::from_pairs(&[("DATABASE_URL", "env-database")]);
        let resolved = resolve_db_url(None, &env, &EnvFileValues::default(), &nowhere()).unwrap();

        assert_eq!(resolved.source, DbUrlSource::EnvDatabaseUrl);
    }

    #[test]
    fn the_process_environment_outranks_the_env_files() {
        let env = Env::from_pairs(&[("DATABASE_URL", "env-database")]);
        let (_guard, files) = dotenv(&[("KSYNC_DB_URL", "dotenv-kizunasync")]);
        let resolved = resolve_db_url(None, &env, &files, &nowhere()).unwrap();

        assert_eq!(resolved.url, "env-database");
        assert_eq!(resolved.source, DbUrlSource::EnvDatabaseUrl);
    }

    #[test]
    fn inside_the_env_files_kizunasync_db_url_still_wins() {
        let (_guard, files) = dotenv(&[
            ("KSYNC_DB_URL", "dotenv-kizunasync"),
            ("DATABASE_URL", "dotenv-database"),
        ]);
        let resolved = resolve_db_url(None, &Env::default(), &files, &nowhere()).unwrap();

        assert_eq!(resolved.url, "dotenv-kizunasync");
        assert_eq!(resolved.source, DbUrlSource::DotenvKizunaSyncDbUrl(".env"));
    }

    #[test]
    fn an_env_file_outranks_the_local_config_fallback() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
        std::fs::write(
            dir.path().join("supabase").join("config.toml"),
            "[db]\nport = 55555\n",
        )
        .unwrap();
        std::fs::write(dir.path().join(".env"), "DATABASE_URL=dotenv-database\n").unwrap();
        let files = crate::env_file::load(dir.path());
        let resolved =
            resolve_db_url(None, &Env::default(), &files, &project_at(dir.path())).unwrap();

        assert_eq!(resolved.url, "dotenv-database");
        assert_eq!(resolved.source, DbUrlSource::DotenvDatabaseUrl(".env"));
    }

    #[test]
    fn the_provenance_label_names_the_file_the_value_came_from() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".env"), "DATABASE_URL=from-env\n").unwrap();
        std::fs::write(
            dir.path().join(".env.local"),
            "DATABASE_URL=from-env-local\n",
        )
        .unwrap();
        let files = crate::env_file::load(dir.path());
        let resolved = resolve_db_url(None, &Env::default(), &files, &nowhere()).unwrap();

        assert_eq!(resolved.url, "from-env-local");
        assert_eq!(resolved.source.to_string(), "DATABASE_URL from .env.local");
    }

    #[test]
    fn the_local_config_fallback_reads_the_db_port() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("supabase")).unwrap();
        std::fs::write(
            dir.path().join("supabase").join("config.toml"),
            "[api]\nport = 1\n\n[db]\nport = 55555\n",
        )
        .unwrap();

        let resolved = resolve_db_url(
            None,
            &Env::default(),
            &EnvFileValues::default(),
            &project_at(dir.path()),
        )
        .unwrap();

        assert_eq!(
            resolved.url,
            "postgresql://postgres:postgres@127.0.0.1:55555/postgres"
        );
        assert_eq!(resolved.source, DbUrlSource::LocalConfig);
    }

    #[test]
    fn nothing_resolvable_names_every_rung() {
        let dir = tempfile::tempdir().unwrap();
        let error = resolve_db_url(
            None,
            &Env::default(),
            &EnvFileValues::default(),
            &project_at(dir.path()),
        )
        .unwrap_err();
        let Error::Db(text) = error else {
            panic!("an unresolvable database URL is a database failure");
        };

        assert!(text.contains("--db-url flag"));
        for key in URL_KEYS {
            assert!(text.contains(key.name), "{text}");
        }
        assert!(
            text.contains(".env, .env.development, .env.local, .env.development.local"),
            "{text}"
        );
        assert!(text.contains("config.toml"));
    }

    #[test]
    fn config_toml_port_ignores_other_sections_and_defaults_when_absent() {
        assert_eq!(parse_config_toml_port(""), 54322);
        assert_eq!(parse_config_toml_port("[api]\nport = 1\n"), 54322);
        assert_eq!(parse_config_toml_port("[db]\n"), 54322);
        assert_eq!(parse_config_toml_port("[db]\nport=6543\n"), 6543);
        assert_eq!(
            parse_config_toml_port("[db]\nport  =  6543  # comment\n"),
            6543
        );
        assert_eq!(
            parse_config_toml_port("[db]\nport = 1\n[api]\nport = 2\n"),
            1
        );
        assert_eq!(
            parse_config_toml_port("[db.pooler]\nport = 54329\n\n[db]\nmajor_version = 17\n"),
            54322
        );
    }

    #[test]
    fn config_toml_port_reads_through_comments_and_other_sections() {
        assert_eq!(
            parse_config_toml_port(
                "# A string with [db] in it\nproject_id = \"[db]\"\n\n[api]\nport = 54321\nschemas = [\n  \"public\",\n]\n\n[db]\n# port = 1\nport = 55432 # local\nshadow_port = 54320\n\n[studio]\nport = 54323\n"
            ),
            55432
        );
    }

    #[test]
    fn a_config_toml_that_does_not_parse_falls_back_to_the_default_port() {
        assert_eq!(parse_config_toml_port("[db]\nport = 55432\n[db\n"), 54322);
        assert_eq!(parse_config_toml_port("[db]\nport = \"55432\"\n"), 54322);
    }

    #[test]
    fn redaction_masks_the_password_and_leaves_everything_else() {
        assert_eq!(
            redact_db_url("postgresql://postgres:hunter2@127.0.0.1:54322/postgres"),
            "postgresql://postgres:***@127.0.0.1:54322/postgres"
        );
        assert_eq!(
            redact_db_url("postgresql://127.0.0.1:54322/postgres"),
            "postgresql://127.0.0.1:54322/postgres"
        );
    }

    #[test]
    fn an_unavailable_pattern_fails_closed_instead_of_leaking_the_password() {
        let url = "postgresql://postgres:hunter2@127.0.0.1:54322/postgres";

        assert_eq!(redact_with_pattern(None, url), REDACTION_UNAVAILABLE);
        assert!(!redact_with_pattern(None, url).contains("hunter2"));
    }

    #[test]
    fn a_raw_at_sign_inside_the_password_is_still_masked_whole() {
        assert_eq!(
            redact_db_url("postgresql://user:p@ss@host:5432/db"),
            "postgresql://user:***@host:5432/db"
        );
    }

    #[test]
    fn a_query_string_password_is_masked_alongside_the_userinfo_one() {
        assert_eq!(
            redact_db_url("postgresql://host:5432/db?password=hunter2&sslmode=require"),
            "postgresql://host:5432/db?password=***&sslmode=require"
        );
        assert_eq!(
            redact_db_url("postgresql://u:pw@host:5432/db?PASSWORD=hunter2"),
            "postgresql://u:***@host:5432/db?PASSWORD=***"
        );
        assert_eq!(
            redact_db_url("postgresql://host:5432/db?sslmode=require"),
            "postgresql://host:5432/db?sslmode=require"
        );
    }

    #[test]
    fn a_key_value_conninfo_password_is_masked() {
        assert_eq!(
            redact_db_url("host=db.example port=5432 password=hunter2 user=postgres"),
            "host=db.example port=5432 password=*** user=postgres"
        );
        assert_eq!(
            redact_db_url("host=db.example PASSWORD=hunter2"),
            "host=db.example PASSWORD=***"
        );
        assert_eq!(redact_db_url("host=db.example"), "host=db.example");
    }

    #[test]
    fn split_password_strips_the_userinfo_password_and_decodes_it() {
        assert_eq!(
            split_db_url_password("postgresql://postgres:hunter2@127.0.0.1:54322/postgres"),
            (
                "postgresql://postgres@127.0.0.1:54322/postgres".to_owned(),
                Some("hunter2".to_owned())
            )
        );
    }

    #[test]
    fn split_password_percent_decodes_the_password() {
        let (stripped, password) =
            split_db_url_password("postgresql://postgres:p%40ss%3Aw%2Frd@host:5432/db");

        assert_eq!(stripped, "postgresql://postgres@host:5432/db");
        assert_eq!(password.as_deref(), Some("p@ss:w/rd"));
    }

    #[test]
    fn split_password_keeps_a_raw_at_sign_whole() {
        let (stripped, password) = split_db_url_password("postgresql://user:p@ss@host:5432/db");

        assert_eq!(stripped, "postgresql://user@host:5432/db");
        assert_eq!(password.as_deref(), Some("p@ss"));
    }

    #[test]
    fn split_password_moves_a_query_string_password_out_of_the_url() {
        assert_eq!(
            split_db_url_password(
                "postgresql://postgres@127.0.0.1:55322/db?sslmode=disable&password=hunter2"
            ),
            (
                "postgresql://postgres@127.0.0.1:55322/db?sslmode=disable".to_owned(),
                Some("hunter2".to_owned())
            )
        );
        assert_eq!(
            split_db_url_password("postgresql://host:5432/db?PassWord=p%40ss&sslmode=require"),
            (
                "postgresql://host:5432/db?sslmode=require".to_owned(),
                Some("p@ss".to_owned())
            )
        );
        assert_eq!(
            split_db_url_password("postgresql://host:5432/db?password="),
            ("postgresql://host:5432/db".to_owned(), None)
        );
    }

    /// Both forms at once: the child would read the query's value, so that is
    /// the one `PGPASSWORD` carries, and neither stays in the URL.
    #[test]
    fn split_password_takes_the_query_password_over_the_userinfo_one() {
        assert_eq!(
            split_db_url_password("postgresql://u:userinfo@host:5432/db?password=query"),
            (
                "postgresql://u@host:5432/db".to_owned(),
                Some("query".to_owned())
            )
        );
    }

    #[test]
    fn split_password_moves_a_key_value_conninfo_password_out() {
        assert_eq!(
            split_db_url_password("host=db.example port=5432 password=hunter2 user=postgres"),
            (
                "host=db.example port=5432 user=postgres".to_owned(),
                Some("hunter2".to_owned())
            )
        );
        assert_eq!(
            split_db_url_password("host=db.example PASSWORD=hunter2"),
            ("host=db.example".to_owned(), Some("hunter2".to_owned()))
        );
        assert_eq!(
            split_db_url_password("host=db.example"),
            ("host=db.example".to_owned(), None)
        );
    }

    #[test]
    fn split_password_is_none_for_a_bare_user_or_an_empty_password() {
        assert_eq!(
            split_db_url_password("postgresql://user@host:5432/db"),
            ("postgresql://user@host:5432/db".to_owned(), None)
        );
        assert_eq!(
            split_db_url_password("postgresql://user:@host:5432/db"),
            ("postgresql://user@host:5432/db".to_owned(), None)
        );
        assert_eq!(
            split_db_url_password("postgresql://host:5432/db"),
            ("postgresql://host:5432/db".to_owned(), None)
        );
    }

    #[test]
    fn shell_quote_leaves_a_bare_url_or_flag_untouched() {
        assert_eq!(shell_quote("--linked"), "--linked");
        assert_eq!(
            shell_quote("postgresql://postgres@127.0.0.1:5432/postgres"),
            "postgresql://postgres@127.0.0.1:5432/postgres"
        );
        assert_eq!(shell_quote("20260925201900"), "20260925201900");
    }

    #[test]
    fn shell_quote_quotes_anything_a_shell_would_otherwise_reinterpret() {
        assert_eq!(
            shell_quote("postgresql://host:5432/db?sslmode=require"),
            "'postgresql://host:5432/db?sslmode=require'"
        );
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn schema_name_validation_accepts_only_postgres_identifiers() {
        assert!(is_valid_schema_name("public"));
        assert!(is_valid_schema_name("_private"));
        assert!(is_valid_schema_name("Mixed_Case9"));
        assert!(is_valid_schema_name(&"a".repeat(63)));

        assert!(!is_valid_schema_name(""));
        assert!(!is_valid_schema_name("9leading"));
        assert!(!is_valid_schema_name("has space"));
        assert!(!is_valid_schema_name("has-dash"));
        assert!(!is_valid_schema_name("drop';--"));
        assert!(!is_valid_schema_name(&"a".repeat(64)));
    }

    #[test]
    fn escape_literal_doubles_single_quotes() {
        assert_eq!(escape_literal("o'brien"), "o''brien");
        assert_eq!(escape_literal("plain"), "plain");
    }

    #[test]
    fn strip_control_chars_drops_every_control_byte_and_nothing_else() {
        assert_eq!(
            strip_control_chars("todos\ndrop table users;--"),
            "todosdrop table users;--"
        );
        assert_eq!(strip_control_chars("a\tb\rc"), "abc");
        assert_eq!(strip_control_chars("plain-table_1"), "plain-table_1");
        assert_eq!(strip_control_chars("café"), "café");
    }

    #[test]
    fn the_query_builders_refuse_an_invalid_schema_instead_of_interpolating_it() {
        assert!(tables_query("public").is_ok());
        assert!(columns_query("public").is_ok());
        assert!(policies_query("public").is_ok());
        assert!(auth_user_fk_query("public").is_ok());

        for builder in [
            tables_query,
            columns_query,
            policies_query,
            auth_user_fk_query,
        ] {
            let Error::Db(message) = builder("public'; drop table x; --").unwrap_err() else {
                panic!("an invalid schema name is a database failure");
            };
            assert!(message.starts_with("invalid schema name:"), "{message}");
        }
    }

    #[test]
    fn the_query_builders_interpolate_the_validated_schema() {
        assert!(
            tables_query("reporting")
                .unwrap()
                .contains("table_schema = 'reporting'")
        );
        assert!(
            columns_query("reporting")
                .unwrap()
                .contains("table_schema = 'reporting'")
        );
        assert!(
            policies_query("reporting")
                .unwrap()
                .contains("schemaname = 'reporting'")
        );
        assert!(
            auth_user_fk_query("reporting")
                .unwrap()
                .contains("src_ns.nspname = 'reporting'")
        );
    }
}
