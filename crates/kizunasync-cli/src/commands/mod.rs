//! One module per command. Each exposes a pure core (fed rows, flags, and an
//! [`Applier`](crate::applier::Applier) or an executor) plus a thin `run` that
//! resolves the real transport around it, so every decision a command makes is
//! unit-testable without a process, a database, or a network.

pub mod deprovision;
pub mod doctor;
pub(crate) mod history_gate;
pub mod init;
pub mod jobs;
pub mod lint;
pub mod mock;
pub mod panel;
pub(crate) mod reconcile;
pub mod smart;
pub mod status;
pub mod sync;
pub(crate) mod table_checks;
pub mod upgrade;

use crate::provision::{LedgerRow, describe_ledger_ahead, ledger_newer};
use crate::ui::Ui;

/// Exit codes: `0` success, `1` the
/// command ran and reported a real failure (a breaking migration, a refused
/// drift, an apply that errored), `2` the command could not run at all (bad
/// flags, no config, no connection, a refused destructive apply).
pub const OK: i32 = 0;
/// The command ran and reported a failure.
pub const FAILURE: i32 = 1;
/// The command could not run.
pub const UNUSABLE: i32 = 2;

/// `Some(2)` once the refusal is on `ui`, when a `pack-file` row in `rows`
/// was recorded by a newer kizunasync than this one: a command that writes to
/// the database refuses before it writes, so an older build never puts its
/// pack or its config over a newer one.
pub(crate) fn refuse_newer_ledger(rows: &[LedgerRow], ui: &mut Ui) -> Option<i32> {
    let newer = ledger_newer(rows, crate::VERSION);
    if newer.is_empty() {
        return None;
    }

    ui.error(&describe_ledger_ahead(&newer, crate::VERSION));

    Some(UNUSABLE)
}
