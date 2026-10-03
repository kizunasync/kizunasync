//! Names the SQL pack fixed, mirrored from `@kizunasync/core`'s `constants.ts`.
//!
//! These are wire and schema identifiers: they change only when the pack
//! changes, never to suit a caller.

/// The schema every Kizuna object lives in.
pub const SCHEMA: &str = "kizunasync";

/// `kizunasync._config`: the per-table sync contract.
pub const INTERNAL_CONFIG: &str = "_config";

/// `kizunasync._provisions`: the provisioning ledger.
pub const INTERNAL_PROVISIONS: &str = "_provisions";

/// `kizunasync._settings`: the single-row global push policy.
pub const INTERNAL_SETTINGS: &str = "_settings";

/// `kizunasync._clients`: registered devices. Not in `@kizunasync/core`'s catalog,
/// which covers `_config`/`_provisions`/`_settings` only, so `status` spells it
/// locally.
pub const INTERNAL_CLIENTS: &str = "_clients";

/// Change-capture routine base name for insert/update.
pub const TRACKER_CHANGE: &str = "track_change";

/// Change-capture routine base name for delete.
pub const TRACKER_DELETE: &str = "track_delete";
