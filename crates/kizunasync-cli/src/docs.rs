//! Deep links into kizunasync.com that the TTY chrome can open.
//!
//! The phase title or command intro *is* the link: OSC 8 wraps the words
//! already on screen (iTerm2, VS Code, Windows Terminal, Ghostty underline
//! them). The URL never appears in the chrome; `--help` still prints it.
//! Scripted backends record the URL and do not draw.

/// The published docs origin. Paths below are site slugs, not repo paths.
pub const SITE: &str = "https://kizunasync.com";

/// OSC 8 start: `ESC ] 8 ; ; URL ST`.
const OSC8_OPEN: &str = "\u{1b}]8;;";
/// String Terminator that closes an OSC 8 parameter.
const OSC8_ST: &str = "\u{1b}\\";
/// OSC 8 with an empty URL, which ends the hyperlink.
const OSC8_CLOSE: &str = "\u{1b}]8;;\u{1b}\\";

/// A titled step the wizard can name, with the docs page people can open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocsRef {
    /// The line the chrome prints (phase title or command intro).
    pub title: &'static str,
    /// Absolute https URL. Lives in the OSC 8 payload, never as chrome copy.
    pub url: &'static str,
}

impl DocsRef {
    /// The title as an OSC 8 hyperlink: the words already on screen, no URL.
    #[must_use]
    pub fn linked_title(&self) -> String {
        hyperlink(self.title, self.url)
    }
}

/// Wrap `label` in an OSC 8 hyperlink to `url`.
#[must_use]
pub fn hyperlink(label: &str, url: &str) -> String {
    format!("{OSC8_OPEN}{url}{OSC8_ST}{label}{OSC8_CLOSE}")
}

/// `label` as a hyperlink on a terminal that advertises OSC 8, else the bare
/// URL, so a link that would render as an inert word carries its address
/// instead.
#[must_use]
pub fn link_or_url(label: &str, url: &str) -> String {
    if crate::prompts::is_pretty_tty() && supports_hyperlinks() {
        return hyperlink(label, url);
    }

    url.to_owned()
}

/// The terminals that advertise OSC 8 through the environment. There is no
/// query for it, so this is the advertisement itself: a program the terminal
/// named, a VTE new enough to have shipped the escape, or one of the emulators
/// that identifies itself by a variable of its own.
#[must_use]
pub fn supports_hyperlinks() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    if ["WT_SESSION", "KONSOLE_VERSION", "DOMTERM"]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
    {
        return true;
    }
    if std::env::var("TERM").is_ok_and(|term| term == "xterm-kitty") {
        return true;
    }
    if std::env::var("VTE_VERSION").is_ok_and(|version| {
        version
            .parse::<u32>()
            .is_ok_and(|version| version >= VTE_WITH_OSC8)
    }) {
        return true;
    }

    std::env::var("TERM_PROGRAM").is_ok_and(|program| {
        HYPERLINK_TERMINALS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(&program))
    })
}

/// The first VTE that shipped OSC 8.
const VTE_WITH_OSC8: u32 = 5000;

/// `TERM_PROGRAM` values that render OSC 8.
const HYPERLINK_TERMINALS: [&str; 7] = [
    "iTerm.app",
    "WezTerm",
    "vscode",
    "Hyper",
    "ghostty",
    "rio",
    "Tabby",
];

/// The backend picker, before connection discovery.
pub const SOLUTION_PHASE: DocsRef = DocsRef {
    title: "Solution",
    url: "https://kizunasync.com/docs/introduction",
};

/// The connection picker: shared by bare `kizunasync`, `init`, and `sync`.
pub const CONNECTION_PHASE: DocsRef = DocsRef {
    title: "Supabase connection discovery",
    url: "https://kizunasync.com/docs/cli#database-connection",
};

/// Schedules, retention, and the HLC ceiling.
pub const MAINTENANCE_PHASE: DocsRef = DocsRef {
    title: "Server maintenance",
    url: "https://kizunasync.com/docs/configuration#kizunasync_settings",
};

/// Table checkbox, after the schema is known.
pub const TABLES_PHASE: DocsRef = DocsRef {
    title: "Synced tables",
    url: "https://kizunasync.com/docs/manage-synced-tables",
};

/// Bare `kizunasync` on a TTY.
pub const BARE: DocsRef = DocsRef {
    title: "kizunasync",
    url: "https://kizunasync.com/docs/cli#interactive-mode-colors-and-output-streams",
};

/// `kizunasync init`.
pub const INIT: DocsRef = DocsRef {
    title: "kizunasync init",
    url: "https://kizunasync.com/docs/cli#kizunasync-init",
};

/// `kizunasync sync`.
pub const SYNC: DocsRef = DocsRef {
    title: "kizunasync sync",
    url: "https://kizunasync.com/docs/cli#kizunasync-sync",
};

/// `kizunasync status`.
pub const STATUS: DocsRef = DocsRef {
    title: "kizunasync status",
    url: "https://kizunasync.com/docs/cli#kizunasync-status",
};

/// Per-table rules the customize ladder names above each question.
pub const SYNC_MODE_RULE: DocsRef = DocsRef {
    title: "Sync mode",
    url: "https://kizunasync.com/docs/configuration#kizunasync_config",
};

/// Who a pull is scoped to.
pub const BUCKET_RULE: DocsRef = DocsRef {
    title: "Bucket",
    url: "https://kizunasync.com/docs/sync-rules-and-buckets#1-understand-the-two-layers",
};

/// The column a local delete stamps instead of removing the row.
pub const SOFT_DELETE_RULE: DocsRef = DocsRef {
    title: "Soft-delete",
    url: "https://kizunasync.com/docs/sync-rules-and-buckets#soft-delete",
};

/// How two writes to one column are ordered.
pub const CONFLICT_RULE: DocsRef = DocsRef {
    title: "Conflict",
    url: "https://kizunasync.com/docs/conflict-resolution",
};

/// The server-side record of a value a write overwrote.
pub const JOURNAL_RULE: DocsRef = DocsRef {
    title: "Conflict journal",
    url: "https://kizunasync.com/docs/conflict-resolution#conflict-history",
};

/// Device registration for retention and stale-client visibility.
pub const CLIENTS_RULE: DocsRef = DocsRef {
    title: "Clients",
    url: "https://kizunasync.com/docs/sql-pack#kizunasync_clients",
};

/// The lowest client schema version a table still accepts.
pub const SCHEMA_VERSION_RULE: DocsRef = DocsRef {
    title: "Schema version",
    url: "https://kizunasync.com/docs/protocol#lifecycle-signals",
};

/// How long a hard delete stays visible to a pull.
pub const TOMBSTONE_RULE: DocsRef = DocsRef {
    title: "Tombstones",
    url: "https://kizunasync.com/docs/sql-pack#kizunasync_tombstones",
};

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_title_is_the_link_and_the_url_is_not_chrome() {
        let line = CONNECTION_PHASE.linked_title();

        assert!(line.contains(CONNECTION_PHASE.title));
        assert!(line.contains(CONNECTION_PHASE.url));
        assert!(line.contains(OSC8_OPEN));
        assert!(line.contains(OSC8_CLOSE));
        assert_eq!(
            line,
            hyperlink(CONNECTION_PHASE.title, CONNECTION_PHASE.url)
        );
        assert!(!line.contains("Docs"));
    }

    /// Library tests never run on a pretty TTY, so the bare URL is what a
    /// hint carries there, and that is also what a piped or CI run gets.
    #[test]
    fn a_link_off_a_pretty_terminal_is_the_url_itself() {
        assert_eq!(
            link_or_url("crontab.guru", "https://crontab.guru/#16_3_*_*_*"),
            "https://crontab.guru/#16_3_*_*_*"
        );
    }

    #[test]
    fn every_ref_points_at_our_site() {
        for step in [
            SOLUTION_PHASE,
            CONNECTION_PHASE,
            MAINTENANCE_PHASE,
            TABLES_PHASE,
            BARE,
            INIT,
            SYNC,
            STATUS,
            SYNC_MODE_RULE,
            BUCKET_RULE,
            SOFT_DELETE_RULE,
            CONFLICT_RULE,
            JOURNAL_RULE,
            CLIENTS_RULE,
            SCHEMA_VERSION_RULE,
            TOMBSTONE_RULE,
        ] {
            assert!(
                step.url.starts_with(SITE),
                "{} must stay on {SITE}, got {}",
                step.title,
                step.url
            );
        }
    }
}
