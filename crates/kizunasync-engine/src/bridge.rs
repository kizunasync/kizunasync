//! What every bridge (`kizunasync-ffi`, `kizunasync-napi`, `kizunasync-wasm`) needs before it
//! can build an engine: the embedder's JSON config turned into an
//! [`EngineConfig`], and the store the embedder named.
//!
//! One owner for the three bridges, so a config accepted by one of them is
//! accepted identically by the others; a bridge that parsed its own would let
//! the same JSON mean two things. `kizunasync-napi`, `kizunasync-ffi` and `kizunasync-wasm` are
//! its only callers, and every embedder reaches an engine through one of them.

use crate::config::{
    AttachmentSpec, DEFAULT_ATTACHMENT_ATTEMPTS, EngineConfig, SyncMode, TableConfig,
};
use crate::engine::PK_COLUMN;
use crate::error::EngineError;
use kizunasync_protocol::{ColumnValues, ConflictMode};
use kizunasync_store::LocalStore;
use serde_json::Value;
use std::collections::BTreeMap;

/// The first non-empty string among `keys`, for the `snake_case`/`camelCase`
/// pairs every embedder spells differently.
#[must_use]
pub fn first_str(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| v.get(*key).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The `database_path` the embedder spelled, read raw so every bridge refuses the
/// same values: absent or null is no path, a string is that string including the
/// empty one, and any other JSON type is a configuration error. The opener, not
/// this, decides what a given string means.
///
/// # Errors
///
/// [`EngineError::Config`] when the key holds anything but a string or null.
pub fn database_path(v: &Value) -> Result<Option<&str>, EngineError> {
    match v.get("database_path").or_else(|| v.get("databasePath")) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(path)) => Ok(Some(path)),
        Some(_) => Err(EngineError::Config("database_path must be a string".into())),
    }
}

/// Parse [`EngineConfig`] from the embedder's JSON. Every field the engine
/// cannot invent is required: a defaulted `client_id` would sync a client under
/// a made-up identity instead of failing at create time. An optional key may be
/// absent or null; present with another JSON type, it is refused rather than
/// read as absent.
///
/// The engine derives the pull scope from `bucket_params`, and an empty map is
/// the unbucketed table of `docs/sync/sync-rules-and-buckets.md`. A table with a
/// `bucket_column` starts with that column set to `""` unless the config names
/// a value, so its pull is refused with `BUCKET_UNSET` until `set_bucket`
/// fills it. A `bucket_owner` table waits for the store's owner instead, which
/// the engine fills in itself.
///
/// # Errors
///
/// [`EngineError::Config`] naming the offending field when a key is absent,
/// empty, or of the wrong JSON type, and naming the table when a
/// `bucket_owner` table has no bucket column, is bucketed on `id`, or names a
/// value for its bucket column.
pub fn parse_config(v: &Value) -> Result<EngineConfig, EngineError> {
    let client_id = v
        .get("client_id")
        .and_then(|c| c.as_str())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| EngineError::Config("client_id is required".into()))?;

    let mut tables = BTreeMap::new();
    match v.get("tables") {
        None | Some(Value::Null) => {}
        Some(Value::Object(obj)) => {
            for (name, cfg) in obj {
                tables.insert(name.clone(), parse_table(name, cfg)?);
            }
        }
        Some(_) => return Err(EngineError::Config("tables must be an object".into())),
    }

    Ok(EngineConfig {
        tables,
        schema_version: parse_schema_version(v)?,
        default_limit: parse_default_limit(v)?,
        attachment_attempts: parse_attachment_attempts(v)?,
        client_id: client_id.into(),
    })
}

fn parse_table(name: &str, cfg: &Value) -> Result<TableConfig, EngineError> {
    if !cfg.is_object() {
        return Err(EngineError::Config(format!(
            "tables.{name} must be an object"
        )));
    }

    let bucket_column = match cfg.get("bucket_column") {
        None | Some(Value::Null) => "",
        Some(Value::String(column)) => column.as_str(),
        Some(_) => {
            return Err(EngineError::Config(format!(
                "tables.{name}.bucket_column must be a string"
            )));
        }
    };
    let mut bucket_params = match cfg.get("bucket_params") {
        None | Some(Value::Null) => ColumnValues::new(),
        Some(Value::Object(params)) => params.clone(),
        Some(_) => {
            return Err(EngineError::Config(format!(
                "tables.{name}.bucket_params must be an object"
            )));
        }
    };
    if !bucket_column.is_empty() {
        bucket_params
            .entry(bucket_column)
            .or_insert_with(|| Value::String(String::new()));
    }
    let bucket_owner = match cfg.get("bucket_owner") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            return Err(EngineError::Config(format!(
                "tables.{name}.bucket_owner must be a boolean"
            )));
        }
    };
    if bucket_owner {
        refuse_unfillable_owner_bucket(name, bucket_column, &bucket_params)?;
    }
    let soft_delete_column = match cfg.get("soft_delete_column") {
        None | Some(Value::Null) => None,
        Some(Value::String(column)) => Some(column.clone()).filter(|column| !column.is_empty()),
        Some(_) => {
            return Err(EngineError::Config(format!(
                "tables.{name}.soft_delete_column must be a string"
            )));
        }
    };

    Ok(TableConfig {
        bucket_column: bucket_column.into(),
        bucket_params,
        bucket_owner,
        attachments: parse_attachments(name, cfg)?,
        soft_delete_column,
        sync_mode: parse_sync_mode(name, cfg)?,
        conflict_mode: parse_conflict_mode(name, cfg)?,
    })
}

/// Owner buckets are filled by the engine only, so a `bucket_owner` table
/// needs a bucket column to fill, one that is not the primary key, and no
/// value of its own for that column. `bucket_params` holds `""` there when the
/// config names none, and that is the only value accepted.
fn refuse_unfillable_owner_bucket(
    name: &str,
    bucket_column: &str,
    bucket_params: &ColumnValues,
) -> Result<(), EngineError> {
    if bucket_column.is_empty() {
        return Err(EngineError::Config(format!(
            "tables.{name}.bucket_owner needs a non-empty bucket_column"
        )));
    }
    if bucket_column == PK_COLUMN {
        return Err(EngineError::Config(format!(
            "tables.{name}.bucket_owner cannot fill the primary key column \"{PK_COLUMN}\""
        )));
    }
    if bucket_params
        .get(bucket_column)
        .is_some_and(|value| value.as_str() != Some(""))
    {
        return Err(EngineError::Config(format!(
            "tables.{name}.bucket_params.{bucket_column} cannot be set on a bucket_owner table: the engine fills it with the store owner"
        )));
    }
    Ok(())
}

/// The app's table schema version. Absent or null is version 1; a present value
/// that is not an integer is refused, because reading it as 1 would pass the
/// server's schema gate under a version the app never declared.
fn parse_schema_version(v: &Value) -> Result<i64, EngineError> {
    match v.get("schema_version") {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_i64()
            .ok_or_else(|| EngineError::Config("schema_version must be an integer".into())),
    }
}

/// Open the store the embedder named: `None` or `":memory:"` is a private
/// in-memory database, anything else is a file path.
///
/// # Errors
///
/// [`EngineError::Store`] when the database cannot be opened or migrated, so the
/// caller reads the store's own code instead of a sentence, and
/// [`EngineError::Config`] for an empty path.
pub fn open_store_at(path: Option<&str>) -> Result<LocalStore, EngineError> {
    match path {
        None | Some(":memory:") => Ok(LocalStore::open_in_memory()?),
        Some("") => Err(EngineError::Config(
            "database_path must be a non-empty path or \":memory:\"".into(),
        )),
        Some(path) => Ok(LocalStore::open_path(path)?),
    }
}

/// Same rules as [`open_store_at`], but a name opens through the async wasm32
/// VFS installer instead of the synchronous (and always-failing) wasm
/// `open_path`.
///
/// The failure keeps the [`kizunasync_store::StoreError`] rather than flattening it
/// to text: the browser is the only caller, and a pool held by another tab
/// (retry later) reads exactly like a browser with no persistent VFS at all
/// (never retry) once both are a message.
///
/// # Errors
///
/// Returns the store's error when the database cannot be opened or migrated,
/// and an unavailable-engine error for an empty path.
#[cfg(target_arch = "wasm32")]
pub async fn open_store_at_async(path: Option<&str>) -> Result<LocalStore, EngineError> {
    match path {
        None | Some(":memory:") => LocalStore::open_in_memory().map_err(EngineError::Store),
        Some("") => Err(EngineError::EngineUnavailable {
            message: "database_path must be a non-empty path or \":memory:\"".into(),
        }),
        Some(name) => LocalStore::open_path_async(name)
            .await
            .map_err(EngineError::Store),
    }
}

/// Pull page size. Absent or null means the embedder expressed no preference and
/// the request omits `limit` entirely; a present value that is not a positive
/// integer is a configuration error, never a silent default; a page of zero or
/// fewer rows would make every pull degenerate.
fn parse_default_limit(v: &Value) -> Result<Option<i64>, EngineError> {
    match v.get("default_limit").or_else(|| v.get("defaultLimit")) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_i64() {
            Some(limit) if limit > 0 => Ok(Some(limit)),
            Some(_) => Err(EngineError::Config(
                "default_limit must be a positive integer".into(),
            )),
            None => Err(EngineError::Config(
                "default_limit must be an integer".into(),
            )),
        },
    }
}

/// Attachment budget. Absent or null is the shipped default; a present value
/// that is not an integer of one or more is a configuration error, because a
/// budget of zero would fail every attachment on its first claim and a fractional
/// one names no attempt at all.
fn parse_attachment_attempts(v: &Value) -> Result<i64, EngineError> {
    match v
        .get("attachment_attempts")
        .or_else(|| v.get("attachmentAttempts"))
    {
        None | Some(Value::Null) => Ok(DEFAULT_ATTACHMENT_ATTEMPTS),
        Some(value) => match value.as_i64() {
            Some(attempts) if attempts >= 1 => Ok(attempts),
            Some(_) => Err(EngineError::Config(
                "attachment_attempts must be 1 or more".into(),
            )),
            None => Err(EngineError::Config(
                "attachment_attempts must be an integer".into(),
            )),
        },
    }
}

/// Sync direction. The value set is closed: an unknown spelling is refused
/// rather than defaulted, because defaulting a misspelled `pull-only` to
/// `read-write` would let this device push a table the server owns.
fn parse_sync_mode(table: &str, cfg: &Value) -> Result<SyncMode, EngineError> {
    match cfg.get("sync_mode").or_else(|| cfg.get("syncMode")) {
        None | Some(Value::Null) => Ok(SyncMode::ReadWrite),
        Some(Value::String(mode)) => match mode.as_str() {
            "read-write" => Ok(SyncMode::ReadWrite),
            "pull-only" => Ok(SyncMode::PullOnly),
            other => Err(EngineError::Config(format!(
                "tables.{table}.sync_mode must be \"read-write\" or \"pull-only\", got \"{other}\""
            ))),
        },
        Some(_) => Err(EngineError::Config(format!(
            "tables.{table}.sync_mode must be a string"
        ))),
    }
}

/// Conflict-resolution mode. The value set is closed and an unknown spelling is
/// refused rather than defaulted, because reading a misspelled `hlc` as
/// `arrival` would drop the origin order the server resolves the column by.
fn parse_conflict_mode(table: &str, cfg: &Value) -> Result<ConflictMode, EngineError> {
    match cfg.get("conflict_mode").or_else(|| cfg.get("conflictMode")) {
        None | Some(Value::Null) => Ok(ConflictMode::Arrival),
        Some(Value::String(mode)) => match mode.as_str() {
            "arrival" => Ok(ConflictMode::Arrival),
            "hlc" => Ok(ConflictMode::Hlc),
            other => Err(EngineError::Config(format!(
                "tables.{table}.conflict_mode must be \"arrival\" or \"hlc\", got \"{other}\""
            ))),
        },
        Some(_) => Err(EngineError::Config(format!(
            "tables.{table}.conflict_mode must be a string"
        ))),
    }
}

fn parse_attachments(
    table: &str,
    cfg: &Value,
) -> Result<BTreeMap<String, AttachmentSpec>, EngineError> {
    let obj = match cfg.get("attachments") {
        None | Some(Value::Null) => return Ok(BTreeMap::new()),
        Some(Value::Object(obj)) => obj,
        Some(_) => {
            return Err(EngineError::Config(format!(
                "tables.{table}.attachments must be an object"
            )));
        }
    };

    let mut attachments = BTreeMap::new();
    for (column, spec) in obj {
        let map = spec.as_object().ok_or_else(|| {
            EngineError::Config(format!(
                "tables.{table}.attachments.{column} must be an object"
            ))
        })?;
        let bucket = map
            .get("storage_bucket")
            .or_else(|| map.get("storageBucket"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                EngineError::Config(format!(
                    "tables.{table}.attachments.{column}.storage_bucket is required"
                ))
            })?;
        let owner = map
            .get("owner_column")
            .or_else(|| map.get("ownerColumn"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                EngineError::Config(format!(
                    "tables.{table}.attachments.{column}.owner_column is required"
                ))
            })?;
        attachments.insert(
            column.clone(),
            AttachmentSpec {
                storage_bucket: bucket.into(),
                owner_column: owner.into(),
            },
        );
    }
    Ok(attachments)
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{DEFAULT_ATTACHMENT_ATTEMPTS, database_path, open_store_at, parse_config};
    use crate::config::SyncMode;
    use crate::error::EngineError;
    use crate::error_catalog::CONFIG_INVALID;
    use serde_json::{Value, json};

    /// A caller-config fault reaches every bridge as one code, so a host that
    /// switches on `CONFIG_INVALID` never has to read the sentence.
    #[test]
    fn a_refused_config_is_typed_config_invalid() {
        let Err(empty_path) = open_store_at(Some("")) else {
            panic!("an empty database_path is a configuration error");
        };
        for refused in [
            parse_config(&json!({})).unwrap_err(),
            parse_config(&json!({"client_id": "u", "default_limit": 0})).unwrap_err(),
            parse_config(&json!({"client_id": "u", "tables": {"items": {"bucket_column": 5}}}))
                .unwrap_err(),
            parse_config(&json!({"client_id": "u", "attachment_attempts": 0})).unwrap_err(),
            parse_config(
                &json!({"client_id": "u", "tables": {"items": {"syncMode": "bidirectional"}}}),
            )
            .unwrap_err(),
            database_path(&json!({"database_path": 5})).unwrap_err(),
            empty_path,
        ] {
            assert!(
                matches!(refused, EngineError::Config(_)),
                "{refused} is not a config fault"
            );
            assert_eq!(refused.code(), CONFIG_INVALID);
            assert!(!refused.is_budget_exempt());
        }
    }

    /// A key of the wrong JSON type is refused rather than read as absent: a
    /// `schema_version` string would otherwise gate as version 1, and an
    /// `attachments` list would drop every attachment column.
    #[test]
    fn a_wrongly_typed_key_is_config_invalid() {
        for config in [
            json!({"client_id": "u", "tables": 5}),
            json!({"client_id": "u", "tables": ["items"]}),
            json!({"client_id": "u", "tables": {"items": 5}}),
            json!({"client_id": "u", "tables": {"items": {"attachments": []}}}),
            json!({"client_id": "u", "tables": {"items": {"bucket_params": "u1"}}}),
            json!({"client_id": "u", "tables": {"items": {"soft_delete_column": true}}}),
            json!({"client_id": "u", "schema_version": "2"}),
            json!({"client_id": "u", "schema_version": 1.5}),
        ] {
            let refused = parse_config(&config).unwrap_err();
            assert!(
                matches!(refused, EngineError::Config(_)),
                "{config} was not refused as a config fault: {refused}"
            );
            assert_eq!(refused.code(), CONFIG_INVALID);
        }
    }

    /// A null is an absent key, as for every other optional key of the config.
    #[test]
    fn a_null_key_reads_as_absent() {
        let config = parse_config(&json!({
            "client_id": "u",
            "schema_version": null,
            "tables": {
                "items": {
                    "attachments": null,
                    "bucket_params": null,
                    "soft_delete_column": null,
                },
            },
        }))
        .expect("config");
        assert_eq!(config.schema_version, 1);
        let items = &config.tables["items"];
        assert!(items.attachments.is_empty());
        assert!(items.bucket_params.is_empty());
        assert_eq!(items.soft_delete_column, None);
        assert!(
            parse_config(&json!({"client_id": "u", "tables": null}))
                .expect("config")
                .tables
                .is_empty()
        );
    }

    /// A bucketed table starts with its bucket column unset, so a pull before
    /// `set_bucket` fills it is refused on the device instead of reaching the
    /// server without the column. A value the config already carries stays.
    #[test]
    fn a_bucketed_table_starts_with_its_bucket_column_unset() {
        let config = parse_config(&json!({
            "client_id": "u",
            "tables": {
                "todos": { "bucket_column": "owner_id" },
                "boards": { "bucket_column": "team_id", "bucket_params": { "team_id": "t1" } },
                "cards": { "bucket_column": "team_id", "bucket_params": { "lane": "l1" } },
                "shared": {},
                "notes": { "bucket_column": "" },
            },
        }))
        .expect("config");
        assert_eq!(
            Value::Object(config.tables["todos"].bucket_params.clone()),
            json!({ "owner_id": "" })
        );
        assert_eq!(
            Value::Object(config.tables["boards"].bucket_params.clone()),
            json!({ "team_id": "t1" })
        );
        assert_eq!(
            Value::Object(config.tables["cards"].bucket_params.clone()),
            json!({ "lane": "l1", "team_id": "" })
        );
        assert!(config.tables["shared"].bucket_params.is_empty());
        assert!(config.tables["notes"].bucket_params.is_empty());
    }

    /// `bucket_owner` is a boolean. Absent or null leaves the bucket to the
    /// app, and any other JSON type is refused rather than read as `false`,
    /// which would leave an owner bucket unset for good.
    #[test]
    fn bucket_owner_is_a_boolean_that_defaults_to_false() {
        let parse = |flag: Option<Value>| {
            let mut todos = json!({ "bucket_column": "owner_id" });
            if let Some(flag) = flag {
                todos["bucket_owner"] = flag;
            }
            parse_config(&json!({ "client_id": "u", "tables": { "todos": todos } }))
        };

        for (flag, expected) in [
            (Some(json!(true)), true),
            (Some(json!(false)), false),
            (None, false),
            (Some(Value::Null), false),
        ] {
            let config = parse(flag.clone()).expect("config");
            assert_eq!(config.tables["todos"].bucket_owner, expected, "{flag:?}");
        }
        for flag in [json!("true"), json!(1), json!({}), json!([true])] {
            let refused = parse(Some(flag.clone())).unwrap_err();
            assert!(
                matches!(refused, EngineError::Config(_)),
                "{flag} was not refused as a config fault: {refused}"
            );
            assert_eq!(refused.code(), CONFIG_INVALID);
        }
    }

    /// An owner bucket is the engine's to fill, so the flag is refused on a
    /// table with no bucket column, on one bucketed on the primary key, and
    /// next to a value the config already names for that column. The refusal
    /// names the table, and the column when there is one.
    #[test]
    fn an_owner_bucket_the_engine_cannot_fill_is_refused() {
        let parse =
            |todos: Value| parse_config(&json!({ "client_id": "u", "tables": { "todos": todos } }));

        for (todos, named) in [
            (json!({ "bucket_owner": true }), "tables.todos"),
            (
                json!({ "bucket_owner": true, "bucket_column": "" }),
                "tables.todos",
            ),
            (
                json!({ "bucket_owner": true, "bucket_column": null }),
                "tables.todos",
            ),
            (
                json!({ "bucket_owner": true, "bucket_column": "id" }),
                "tables.todos",
            ),
            (
                json!({
                    "bucket_owner": true,
                    "bucket_column": "owner_id",
                    "bucket_params": { "owner_id": "u1" },
                }),
                "tables.todos.bucket_params.owner_id",
            ),
            (
                json!({
                    "bucket_owner": true,
                    "bucket_column": "owner_id",
                    "bucket_params": { "owner_id": null },
                }),
                "tables.todos.bucket_params.owner_id",
            ),
        ] {
            let refused = parse(todos.clone()).unwrap_err();
            let EngineError::Config(message) = &refused else {
                panic!("{todos} was not refused as a config fault: {refused}");
            };
            assert!(message.contains(named), "{message} does not name {named}");
            assert_eq!(refused.code(), CONFIG_INVALID);
        }
    }

    /// The value the parser leaves unset, and a key that is not the bucket
    /// column, are no configured owner value. Without the flag, every shape
    /// stays legal.
    #[test]
    fn an_owner_bucket_left_to_the_engine_is_accepted() {
        let config = parse_config(&json!({
            "client_id": "u",
            "tables": {
                "todos": {
                    "bucket_owner": true,
                    "bucket_column": "owner_id",
                    "bucket_params": { "owner_id": "", "lane": "l1" },
                },
                "boards": { "bucket_owner": false, "bucket_column": "id" },
                "cards": {
                    "bucket_owner": false,
                    "bucket_column": "team_id",
                    "bucket_params": { "team_id": "t1" },
                },
            },
        }))
        .expect("config");

        assert!(config.tables["todos"].bucket_owner);
        assert_eq!(
            Value::Object(config.tables["todos"].bucket_params.clone()),
            json!({ "owner_id": "", "lane": "l1" })
        );
        assert!(!config.tables["boards"].bucket_owner);
        assert!(!config.tables["cards"].bucket_owner);
    }

    /// Both spellings every embedder uses reach the same table config, and a
    /// table that names no mode syncs both ways.
    #[test]
    fn sync_mode_is_read_in_either_spelling() {
        let config = parse_config(&json!({
            "client_id": "u",
            "tables": {
                "audit": { "sync_mode": "pull-only" },
                "shared": { "syncMode": "pull-only" },
                "todos": { "bucket_column": "user_id" },
            },
        }))
        .expect("config");
        assert_eq!(config.tables["audit"].sync_mode, SyncMode::PullOnly);
        assert_eq!(config.tables["shared"].sync_mode, SyncMode::PullOnly);
        assert_eq!(config.tables["todos"].sync_mode, SyncMode::ReadWrite);
    }

    /// The budget is the app's, so an absent one is the shipped default and a
    /// present one is taken in either spelling.
    #[test]
    fn the_attachment_budget_defaults_and_takes_either_spelling() {
        let absent = parse_config(&json!({"client_id": "u"})).expect("config");
        assert_eq!(absent.attachment_attempts, DEFAULT_ATTACHMENT_ATTEMPTS);
        let snake =
            parse_config(&json!({"client_id": "u", "attachment_attempts": 2})).expect("config");
        assert_eq!(snake.attachment_attempts, 2);
        let camel =
            parse_config(&json!({"client_id": "u", "attachmentAttempts": 9})).expect("config");
        assert_eq!(camel.attachment_attempts, 9);
    }
}
