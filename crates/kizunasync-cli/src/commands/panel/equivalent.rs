//! The one-shot command a panel action ran, so the same step can move into a
//! script or a CI job.

use crate::commands::init::WizardConnection;
use crate::db::{shell_quote, split_db_url_password};
use crate::project_ref::ProjectRef;

/// What stands in for a secret the printed command must not carry.
const ELIDED: &str = "…";

/// The connection a printed command names.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Reach<'a> {
    /// A direct Postgres connection string.
    DbUrl(&'a str),
    /// A hosted project, reached through the Management API.
    ProjectRef(&'a ProjectRef),
}

impl<'a> Reach<'a> {
    /// The connection the panel settled on.
    pub(crate) fn of(connection: &'a WizardConnection) -> Self {
        match connection {
            WizardConnection::Direct(direct) => Self::DbUrl(&direct.url),
            WizardConnection::Remote { project_ref, .. } => Self::ProjectRef(project_ref),
        }
    }
}

/// `kizunasync` with `args` over the panel's connection.
pub(crate) fn render(connection: &WizardConnection, args: &[String]) -> String {
    render_over(Reach::of(connection), args)
}

/// `kizunasync` with `args` over `reach`. The database password leaves the
/// URL for `PGPASSWORD`, and a project's token is left to
/// `SUPABASE_ACCESS_TOKEN`; neither value is ever printed.
pub(crate) fn render_over(reach: Reach<'_>, args: &[String]) -> String {
    let command = quoted(args);

    match reach {
        Reach::DbUrl(url) => {
            let (url, password) = split_db_url_password(url);
            let secret = if password.is_some() {
                format!("PGPASSWORD={ELIDED} ")
            } else {
                String::new()
            };

            format!(
                "{secret}kizunasync {command} --db-url {}",
                shell_quote(&url)
            )
        }
        Reach::ProjectRef(project_ref) => {
            format!(
                "SUPABASE_ACCESS_TOKEN={ELIDED} kizunasync {command} --project-ref {project_ref}"
            )
        }
    }
}

/// `kizunasync` with `args` over a direct connection string only the reader
/// knows: a run over the Management API never sees one.
pub(crate) fn render_over_unknown_url(args: &[String]) -> String {
    format!(
        "PGPASSWORD={ELIDED} kizunasync {} --db-url <the project's connection string>",
        quoted(args)
    )
}

fn quoted(args: &[String]) -> String {
    args.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}
