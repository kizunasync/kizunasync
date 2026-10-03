//! Version precedence for the `pack_version` the ledger records, so a build
//! can tell that a project was provisioned by a newer one.
//!
//! [SemVer 2.0.0 precedence](https://semver.org/#spec-item-11) over
//! `MAJOR.MINOR.PATCH` with an optional dot-separated prerelease
//! (`0.2.6-alpha.1`), the only shape a workspace version takes. Build metadata
//! is not part of that shape and does not parse.

use std::cmp::Ordering;

/// A parsed `MAJOR.MINOR.PATCH[-prerelease]` version, ordered by SemVer
/// precedence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<Identifier>,
}

/// One dot-separated prerelease identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identifier {
    Numeric(u64),
    Alphanumeric(String),
}

impl Version {
    /// Parse `text`, or `None` when it is not `MAJOR.MINOR.PATCH` with an
    /// optional prerelease: an empty part, a leading zero on a numeric part, a
    /// character outside `[0-9A-Za-z-]`, and build metadata all fail.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let (core, prerelease) = match text.split_once('-') {
            Some((core, prerelease)) => (core, Some(prerelease)),
            None => (text, None),
        };
        let mut parts = core.split('.');
        let major = parse_numeric(parts.next()?)?;
        let minor = parse_numeric(parts.next()?)?;
        let patch = parse_numeric(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }

        let prerelease = match prerelease {
            None => Vec::new(),
            Some(prerelease) => prerelease
                .split('.')
                .map(parse_identifier)
                .collect::<Option<Vec<_>>>()?,
        };

        Some(Self {
            major,
            minor,
            patch,
            prerelease,
        })
    }
}

/// A numeric part: digits only, no leading zero unless it is `0` itself.
fn parse_numeric(part: &str) -> Option<u64> {
    let digits = !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !digits || (part.len() > 1 && part.starts_with('0')) {
        return None;
    }

    part.parse().ok()
}

fn parse_identifier(part: &str) -> Option<Identifier> {
    if part.is_empty()
        || !part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    if part.bytes().all(|byte| byte.is_ascii_digit()) {
        return parse_numeric(part).map(Identifier::Numeric);
    }

    Some(Identifier::Alphanumeric(part.to_owned()))
}

impl Ord for Identifier {
    /// Numeric identifiers compare numerically and sort before alphanumeric
    /// ones, which compare in ASCII order.
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Numeric(left), Self::Numeric(right)) => left.cmp(right),
            (Self::Numeric(_), Self::Alphanumeric(_)) => Ordering::Less,
            (Self::Alphanumeric(_), Self::Numeric(_)) => Ordering::Greater,
            (Self::Alphanumeric(left), Self::Alphanumeric(right)) => left.cmp(right),
        }
    }
}

impl PartialOrd for Identifier {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    /// A prerelease sorts before its release; two prereleases compare
    /// identifier by identifier, and the longer one wins a shared prefix.
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(
                || match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Greater,
                    (false, true) => Ordering::Less,
                    (false, false) => self.prerelease.cmp(&other.prerelease),
                },
            )
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|| panic!("{text} should parse"))
    }

    /// The precedence chain spelled out in SemVer 2.0.0, item 11.4.
    #[test]
    fn the_semver_example_chain_is_strictly_increasing() {
        let chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];

        for pair in chain.windows(2) {
            assert!(version(pair[0]) < version(pair[1]), "{pair:?}");
        }
    }

    #[test]
    fn the_core_compares_numerically_part_by_part() {
        assert!(version("0.2.6") < version("0.2.10"));
        assert!(version("0.2.10") < version("0.3.0"));
        assert!(version("0.9.9") < version("1.0.0"));
        assert!(version("0.3.0-alpha.1") > version("0.2.6"));
    }

    #[test]
    fn a_workspace_prerelease_orders_against_its_neighbours() {
        let current = version("0.2.6-alpha.1");

        assert_eq!(current.cmp(&version("0.2.6-alpha.1")), Ordering::Equal);
        assert!(current < version("0.2.6-alpha.2"));
        assert!(current < version("0.2.6-beta"));
        assert!(current < version("0.2.6"));
        assert!(current > version("0.2.6-alpha"));
        assert!(current > version("0.2.5"));
    }

    #[test]
    fn a_numeric_identifier_sorts_before_an_alphanumeric_one() {
        assert!(version("1.0.0-1") < version("1.0.0-a"));
        assert!(version("1.0.0-alpha.9") < version("1.0.0-alpha.x"));
    }

    #[test]
    fn anything_but_the_supported_shape_does_not_parse() {
        for text in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.02.3",
            "1.2.3-",
            "1.2.3-alpha..1",
            "1.2.3-alpha.01",
            "1.2.3+build",
            "1.2.3-alpha+build",
            "v1.2.3",
            " 1.2.3",
            "1.2.3-al$pha",
        ] {
            assert_eq!(Version::parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_hyphen_inside_the_prerelease_belongs_to_its_identifier() {
        assert!(version("1.0.0-alpha-2") > version("1.0.0-alpha"));
        assert!(version("1.0.0-x-y.1") < version("1.0.0-x-y.2"));
    }
}
