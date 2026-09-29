//! The environment a command reads, as a value.
//!
//! Connection and token resolution both consult the environment; making it an
//! argument rather than a process global is what lets those ladders be unit
//! tested without `set_var`.

use std::collections::BTreeMap;

/// A snapshot of the environment variables a command may read.
#[derive(Debug, Clone, Default)]
pub struct Env(BTreeMap<String, String>);

impl Env {
    /// The real process environment.
    #[must_use]
    pub fn from_process() -> Self {
        Self(std::env::vars().collect())
    }

    /// A fixed environment, for tests.
    #[must_use]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    /// The value of `key`, treating an empty string as unset.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    }

    /// Whether `key` holds exactly `value` (the `KSYNC_ALLOW_*` escape hatches).
    #[must_use]
    pub fn equals(&self, key: &str, value: &str) -> bool {
        self.get(key) == Some(value)
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_value_reads_as_unset() {
        let env = Env::from_pairs(&[("A", ""), ("B", "x")]);

        assert_eq!(env.get("A"), None);
        assert_eq!(env.get("B"), Some("x"));
        assert_eq!(env.get("C"), None);
    }

    #[test]
    fn equals_is_an_exact_match() {
        let env = Env::from_pairs(&[("KSYNC_ALLOW_DEPROVISION", "1")]);

        assert!(env.equals("KSYNC_ALLOW_DEPROVISION", "1"));
        assert!(!env.equals("KSYNC_ALLOW_DEPROVISION", "true"));
    }
}
