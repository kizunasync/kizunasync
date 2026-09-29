//! `kizunasync`: the Kizuna command-line tool.
//!
//! The library half of the binary: argv in, exit code out, every byte of output
//! written through an injected [`Ui`]. `main.rs` only supplies the real streams,
//! so the whole surface (parsing, transport resolution, every command's
//! decisions) is driven from tests without spawning a process.
//!
//! Two contracts hold everywhere:
//!
//! * **Streams.** stdout carries machine payloads only (JSON, JSONL, SQL);
//!   every human line goes to stderr. A `--json` run's stdout is exactly one
//!   object.
//! * **Exit codes**: `0` success, `1` the command ran and reported a real
//!   failure, `2` it could not run at all, and `130` when Ctrl+C stopped a
//!   write or a network call outside a prompt ([`interrupt`]).
//!
//! `init` and `sync` prompt on a TTY (via `cliclack`); `status` draws a Clack
//! report on a TTY and never asks. Every other path is flag-driven so CI and
//! tests never block on input.
//!
//! # Allocation
//!
//! Allocation-conscious binary surface. Not heapless.

#![forbid(unsafe_code)]
// `clippy::doc_markdown` is off for this crate on purpose. Two thirds of the
// doc comments here are not rustdoc at all: clap renders them verbatim as
// `--help` text, and backticking `KSYNC_DB_URL` or `--project-ref` would put
// literal backticks in front of a user. The rest name products and extensions
// in prose (PostgREST, pg_cron), which read worse as code spans.
#![allow(clippy::doc_markdown)]

pub mod api_schemas;
pub mod applier;
pub mod catalog;
mod cli;
pub mod clock;
pub mod commands;
pub mod config;
pub mod config_sql;
pub mod constants;
pub mod cron;
pub mod db;
pub mod detect;
pub mod discovery;
mod dispatch;
pub mod docs;
pub mod emit;
pub mod env;
pub mod env_file;
pub mod error;
pub mod interrupt;
pub mod ledger;
pub mod lint;
pub mod login_role;
pub mod management;
pub mod migration_history;
pub mod mock_churn;
pub mod mock_seed;
pub mod pack;
pub mod pg;
pub mod project_ref;
pub mod prompts;
pub mod proposals;
pub mod provision;
pub mod row;
pub mod server_facts;
pub mod solution;
pub mod supabase_cli;
pub mod supabase_config;
pub mod sync_delta;
mod tls_url;
pub mod token;
pub mod ui;
pub mod version;
pub mod wizard;
mod wizard_theme;
pub mod workdir;

pub use crate::ui::Ui;
pub use dispatch::{Session, help_text, run};

/// The version reported by `--version`: the crate version from Cargo.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
