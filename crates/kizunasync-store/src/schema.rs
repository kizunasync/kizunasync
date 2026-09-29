pub(crate) const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS _kizunasync_rows (
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  row_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_seq TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (table_name, pk)
);
CREATE TABLE IF NOT EXISTS _kizunasync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  op TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  precondition_json TEXT,
  -- D-base-hint: unread local slot so a client can persist a value if one
  -- arrives. The wire decision is open; neither the slot nor this
  -- column carries semantics.
  base_hint_json TEXT,
  batch_id TEXT,
  pre_image_json TEXT,
  hlc TEXT,
  created_at TEXT NOT NULL,
  in_flight INTEGER NOT NULL DEFAULT 0,
  transforms_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS _kizunasync_outbox_mutation_id ON _kizunasync_outbox (mutation_id);
CREATE TABLE IF NOT EXISTS _kizunasync_tombstones (
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  seq TEXT NOT NULL DEFAULT '0',
  deleted_at TEXT,
  PRIMARY KEY (table_name, pk)
);
CREATE TABLE IF NOT EXISTS _kizunasync_dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mutation_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  op TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  server_row_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _kizunasync_rejections (
  mutation_id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_columns TEXT NOT NULL,
  server_row TEXT,
  at INTEGER NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS _kizunasync_overwrites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  column_name TEXT NOT NULL,
  loser_value TEXT NOT NULL,
  winner_mutation_id TEXT NOT NULL,
  conflict_mode TEXT NOT NULL,
  winner_seq TEXT,
  at INTEGER NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS _kizunasync_pushed (
  mutation_id TEXT PRIMARY KEY,
  pushed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _kizunasync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS _kizunasync_pull_pages (
  page_no INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS _kizunasync_attachments (
  ref TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  column_name TEXT NOT NULL,
  bucket TEXT NOT NULL,
  owner TEXT NOT NULL,
  sha256 TEXT,
  content_type TEXT,
  size INTEGER,
  local_path TEXT,
  direction TEXT NOT NULL,
  state TEXT NOT NULL,
  in_flight INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  permanent INTEGER NOT NULL DEFAULT 0,
  chunk_offset INTEGER NOT NULL DEFAULT 0,
  tus_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS _kizunasync_attachments_state ON _kizunasync_attachments (state);
";

// A column a table gains is declared last in SCHEMA, which creates it on a new
// database; `LocalStore::init` adds it to a database whose table predates it.

/// `_kizunasync_meta` keys and the cursor default are the on-disk format.
pub(crate) const LAST_MUTATION_ID_KEY: &str = "last_mutation_id";
pub(crate) const CURSOR_KEY: &str = "cursor";
pub(crate) const BOOTSTRAP_CURSOR: &str = "0";

/// `_kizunasync_meta` key of the last origin HLC this device minted, kept as
/// `<millis>|<counter>|<node>`. [`crate::LocalStore::reset`] keeps it, so a stamp
/// minted after a reset still sorts after every stamp minted before it.
pub const ORIGIN_HLC_KEY: &str = "origin_hlc";

/// `_kizunasync_meta` key of the identity this device pulls and pushes under.
/// [`crate::LocalStore::reset`] replaces it with the identity its caller minted.
pub const CLIENT_ID_KEY: &str = "client_id";
