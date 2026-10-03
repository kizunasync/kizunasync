//! `kizunasync`: the Kizuna command-line tool.
//!
//! Thin entry point: build the real stdio UI and process session, hand argv to
//! the library, and turn the returned exit code into the process status. Every
//! decision lives in `kizunasync_cli`, which tests drive with a captured UI instead
//! of a process.

#![forbid(unsafe_code)]

use std::process::ExitCode;

use kizunasync_cli::{Session, Ui, run};

fn main() -> ExitCode {
    // Without the handler, Ctrl+C falls back to the default signal, which
    // still stops the run.
    let _ = kizunasync_cli::interrupt::install();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let session = Session::from_process();
    let mut ui = Ui::stdio();
    let code = run(&argv, &session, &mut ui);

    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
