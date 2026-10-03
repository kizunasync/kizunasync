//! A Supabase project ref, checked once where it enters the CLI.
//!
//! A ref becomes a host label (`db.<ref>.supabase.co`) and a Management API
//! path segment (`/v1/projects/<ref>`), so anything but lowercase ASCII
//! letters and digits could point the access token, or a connection, at
//! another host. The `--project-ref` flag, `SUPABASE_PROJECT_ID`,
//! `supabase/.temp/project-ref`, and the project the account picker returns
//! are parsed into a [`ProjectRef`] where they are read, and every function
//! that builds a URL or a host from a ref takes one, so none of them handles
//! a ref that was not checked.

use std::fmt;

/// A checked Supabase project ref: lowercase ASCII letters and digits only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef(String);

/// Why a value is not a [`ProjectRef`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("not a Supabase project ref: expected lowercase letters and digits only")]
pub struct InvalidProjectRef;

impl ProjectRef {
    /// Check `value`. Also the `--project-ref` flag's clap value parser, so an
    /// invalid ref is a usage error before any command runs.
    ///
    /// # Errors
    /// Returns [`InvalidProjectRef`] when `value` is empty or carries anything
    /// but lowercase ASCII letters and digits.
    pub fn parse(value: &str) -> Result<Self, InvalidProjectRef> {
        let valid = !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
        if !valid {
            return Err(InvalidProjectRef);
        }

        Ok(Self(value.to_owned()))
    }

    /// The ref, as the host label and path segment it becomes.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProjectRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_project_ref_is_lowercase_ascii_letters_and_digits_only() {
        assert_eq!(
            ProjectRef::parse("abcdefghijklmnopqrst").unwrap().as_str(),
            "abcdefghijklmnopqrst"
        );
        assert_eq!(ProjectRef::parse("a0").unwrap().to_string(), "a0");
        for bad in [
            "",
            "ABC",
            "a-b",
            "a.b",
            "a b",
            "a/b",
            "evil.example/x#",
            "abc\n",
            "é",
        ] {
            assert_eq!(ProjectRef::parse(bad), Err(InvalidProjectRef), "{bad:?}");
        }
    }
}
