//! Wire types and cursor token codec for the Kizuna protocol.
//! Source of truth for shapes remains `packages/protocol/schemas/*.schema.json`.
//!
//! # Allocation
//!
//! Allocation-conscious: parse and encode may allocate (`String`, `Vec`). The
//! crate is not heapless. [`CursorToken::parse`] borrows the input;
//! [`CursorToken::encode`] returns an owned token.
//!
//! Wire DTO fields stay public because they *are* the JSON object (API
//! Guidelines C-STRUCT-PRIVATE exception for serde wire types). Closed
//! vocabulary fields on the reply DTOs (`Signal.signal_type`, `Verdict.verdict`
//! / `reason`, `BatchOutcome.outcome`, `Conflict.conflict_mode`) stay
//! [`String`] so a payload that deserializes as JSON but names an unknown
//! member reaches the engine rather than failing at serde. The first three
//! reach the `UNKNOWN_SIGNAL`, `UNKNOWN_VERDICT_REASON`, and
//! `MALFORMED_PUSH_RESPONSE` codes; `conflict_mode` is journalled and announced
//! verbatim, because a mode this client cannot name still identifies the rule
//! the server resolved the column by. The conflict-vector oracle injects those
//! strings and pins those codes. Typing the fields as the generated enums would
//! fail at serde with `JSON` instead.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::str::FromStr;
use thiserror::Error;

mod generated;

/// The generated module holds only the wire surface, so it re-exports whole: growing the
/// schema must not require a hand edit here. See `WIRE_ENUM_PARITY.md`.
pub use generated::*;

/// The text is not a member of a closed wire vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownWireMember;

impl std::fmt::Display for UnknownWireMember {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("unknown wire member")
    }
}

impl std::error::Error for UnknownWireMember {}

macro_rules! impl_wire_from_str {
    ($ty:ty { $($rename:literal => $variant:ident),+ $(,)? }) => {
        impl FromStr for $ty {
            type Err = UnknownWireMember;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $($rename => Ok(Self::$variant),)+
                    _ => Err(UnknownWireMember),
                }
            }
        }
    };
}

impl_wire_from_str!(Op {
    "delete" => Delete,
    "insert" => Insert,
    "update" => Update,
});
impl_wire_from_str!(SignalType {
    "CHECKPOINT_EXPIRED" => CheckpointExpired,
    "RESET_REQUIRED" => ResetRequired,
});
impl_wire_from_str!(RejectReason {
    "COLUMN_DENIED" => ColumnDenied,
    "CONSTRAINT" => Constraint,
    "DELETE_WINS" => DeleteWins,
    "PRECONDITION" => Precondition,
    "RLS_DENIED" => RlsDenied,
    "SUPERSEDED" => Superseded,
});
impl_wire_from_str!(WireVerdictKind {
    "applied" => Applied,
    "rejected" => Rejected,
});
impl_wire_from_str!(WireBatchOutcome {
    "aborted" => Aborted,
});
impl_wire_from_str!(ConflictMode {
    "arrival" => Arrival,
    "hlc" => Hlc,
});

/// Parse a closed wire vocabulary from its serde rename (the JSON string).
///
/// # Allocation
///
/// Does not allocate. Matches the rename literals in place.
#[must_use]
pub fn parse_wire_member<T: FromStr>(raw: &str) -> Option<T> {
    raw.parse().ok()
}

/// An opaque pull cursor token. Decode it with [`CursorToken::parse`].
pub type Cursor = String;

/// A wire identifier, carried as text because the wire is JSON.
pub type Uuid = String;

/// A server sequence number, carried as text so it survives any integer width.
pub type Seq = String;

/// One row's columns as the wire spells them.
pub type ColumnValues = serde_json::Map<String, serde_json::Value>;

/// One local write on its way to the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mutation {
    /// The client-assigned identity the server's verdict names.
    pub mutation_id: Uuid,
    /// The table the write targets.
    pub table: String,
    /// The key text of the row the write targets (D-row-key).
    pub pk: RowKey,
    /// Insert, update, or delete.
    pub op: Op,
    /// The values the write sets.
    #[serde(default)]
    pub columns: ColumnValues,
    /// The column values the server must still see for the write to apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precondition: Option<ColumnValues>,
    /// The write's hybrid logical clock stamp, when the client sent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hlc: Option<String>,
    /// Server-evaluated column operations (an increment, an append) instead of
    /// literal values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transforms: Option<ColumnValues>,
}

/// The mutations one push carries, and whether the server applies them together.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushBatch {
    /// `true` when every member must apply or none does.
    pub atomic: bool,
    /// The batch members, in the order the client queued them.
    pub mutations: Vec<Mutation>,
}

/// One push request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushRequest {
    /// The client the server registers this push under: see
    /// [`PullRequest::client_id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<Uuid>,
    /// The schema version the client expects the server to hold.
    pub schema_version: i64,
    /// The mutations to apply.
    pub batch: PushBatch,
    /// Serialized even when unset, as an explicit null: `push-request.schema.json`
    /// lists it in `required` and the SQL argument has no default, so `PostgREST`
    /// resolves no overload when the key is missing.
    #[serde(default)]
    pub last_mutation_id: Option<Uuid>,
}

/// What the server decided about one mutation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    /// The mutation this verdict answers.
    pub mutation_id: Uuid,
    /// The decision, one member of the closed verdict union. Stays [`String`]
    /// so an unknown kind reaches `UNKNOWN_VERDICT_REASON` instead of serde
    /// `JSON` (conflict-vector oracle).
    pub verdict: String,
    /// Why the server refused it, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The authoritative row after the decision, when the server sent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_row: Option<ColumnValues>,
}

/// One push reply: per-mutation verdicts, a whole-batch abort, or a signal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushResponse {
    /// One verdict per mutation, for a non-atomic batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdicts: Option<Vec<Verdict>>,
    /// An out-of-band instruction to the client (a required reset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<Signal>,
    /// Transcript atomic abort envelope: `{ "batch": { "outcome": "aborted", ... } }`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<BatchOutcome>,
}

/// How an atomic batch ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchOutcome {
    /// The outcome, one member of the closed batch-outcome union. Stays
    /// [`String`] so an unknown member reaches `MALFORMED_PUSH_RESPONSE`
    /// (conflict-vector oracle).
    pub outcome: String,
    /// The member the server blamed for an abort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offender_mutation_id: Option<Uuid>,
    /// Why the server aborted the batch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The authoritative row the offender would revert to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_row: Option<ColumnValues>,
}

/// An out-of-band instruction the server attaches to a reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signal {
    /// The signal name, one member of the closed signal union. Stays [`String`]
    /// so an unknown type reaches `UNKNOWN_SIGNAL` (conflict-vector oracle).
    #[serde(rename = "type")]
    pub signal_type: String,
}

/// One table and the parameter values that scope the rows a client may pull.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bucket {
    /// The table this bucket scopes.
    pub table: String,
    /// The bucket parameters, empty for an unbucketed table.
    #[serde(default)]
    pub params: ColumnValues,
}

/// One pull request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullRequest {
    /// The client the server registers this pull under (D-client-identity). Optional on the
    /// wire: with the key absent the server falls back to the JWT `session_id`
    /// claim, so it is omitted rather than sent as null. The engine sets it from
    /// config when it builds a request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<Uuid>,
    /// The schema version the client expects the server to hold.
    pub schema_version: i64,
    /// Where the client left off.
    pub cursor: Cursor,
    /// Absent unless the app configured a page size: `pull-request.schema.json`
    /// leaves `limit` out of `required` and the server applies its own default,
    /// so an unconfigured client must not put a number on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    /// The tables and scopes the client wants rows for.
    pub buckets: Vec<Bucket>,
}

/// One row the server changed since the client's cursor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowChange {
    /// The row's table.
    pub table: String,
    /// The row's key text (D-row-key).
    pub pk: RowKey,
    /// The server sequence this change landed at.
    pub seq: Seq,
    /// Wire transcripts use `row`; some schemas use `columns`.
    #[serde(default, alias = "row")]
    pub columns: ColumnValues,
    /// `true` when the change is a soft delete rather than an update.
    #[serde(default)]
    pub deleted: bool,
}

/// One row the server hard-deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    /// The row's table.
    pub table: String,
    /// The row's key text (D-row-key).
    pub pk: RowKey,
    /// The server sequence the delete landed at.
    pub seq: Seq,
}

/// One pull reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PullResponse {
    /// The cursor the next pull sends.
    pub cursor: Cursor,
    /// `true` when the server has more rows past this page.
    pub has_more: bool,
    /// The changed rows.
    #[serde(default)]
    pub rows: Vec<RowChange>,
    /// The deleted rows.
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
    /// An out-of-band instruction to the client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<Signal>,
    /// Columns a concurrent write took from this client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<Vec<Conflict>>,
}

/// One column a concurrent write took from this client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    /// The row's table.
    pub table: String,
    /// The row's key text (D-row-key).
    pub pk: RowKey,
    /// The column that changed owner.
    pub column_name: String,
    /// The value that lost.
    pub loser_value: serde_json::Value,
    /// The mutation that won.
    pub winner_mutation_id: String,
    /// The conflict rule that decided it.
    pub conflict_mode: String,
    /// The changelog seq of the winning write, always one of the seqs the same
    /// page delivers in `rows` (D-conflict-journal-visibility).
    pub winner_seq: Seq,
}

// MARK: - Cursor token

/// Separates a continuation token's start from its position.
const START_SEPARATOR: char = ':';

/// Separates the high-water mark from the hole list.
const HIGH_WATER_HOLES_SEPARATOR: char = '~';

/// Separates two holes. `.`, NOT `,`, is the canonical wire delimiter in every
/// normative source: `packages/protocol/spec/cursor-token.ts`, the `cursor`
/// pattern of `packages/protocol/schemas/common.schema.json`, and the SQL pack
/// (0001).
const HOLE_SEPARATOR: char = '.';

/// A decoded [`Cursor`]: a high-water mark plus the seqs still in flight below
/// it, and, on a continuation page, the start: the high-water of the checkpoint
/// the transfer started from, which the expiry gate checks. Every seq at or
/// below the mark has been delivered except those holes. The fields are private
/// so no token holds a list the grammar rejects: build one with
/// [`CursorToken::parse`], [`CursorToken::new`], or [`CursorToken::continuation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorToken {
    start: Option<u64>,
    high_water: u64,
    holes: Vec<u64>,
}

/// Why a cursor token could not be decoded.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CursorError {
    /// The token was empty.
    #[error("empty cursor token")]
    Empty,
    /// The token is outside the canonical grammar, carrying the offending text.
    #[error("invalid cursor token: {0}")]
    Invalid(String),
}

/// One canonical decimal component of a cursor token, or `None` when it is not
/// one. Signs and leading zeros are rejected: the schema pattern emits neither,
/// and `u64::from_str` alone accepts a leading `+`, so accepting them would
/// decode a token the wire cannot produce into one that re-encodes differently.
fn parse_decimal(part: &str) -> Option<u64> {
    if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if part.len() > 1 && part.starts_with('0') {
        return None;
    }
    part.parse::<u64>().ok()
}

/// The hole grammar every token satisfies: each hole is an in-flight seq below
/// the high-water mark, and the list is strictly ascending, hence duplicate-free.
fn validate_holes(high_water: u64, holes: &[u64]) -> bool {
    // Seqs start at 1, so the `0` floor doubles as the rejection of a `0` hole.
    let mut previous = 0;
    for &hole in holes {
        if hole <= previous || hole >= high_water {
            return false;
        }
        previous = hole;
    }
    true
}

/// The canonical wire form of an optional start, a high-water mark, and its holes.
fn encode_token(start: Option<u64>, high_water: u64, holes: &[u64]) -> String {
    let prefix = start.map_or_else(String::new, |start| format!("{start}{START_SEPARATOR}"));
    if holes.is_empty() {
        return format!("{prefix}{high_water}");
    }

    let holes = holes
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(&HOLE_SEPARATOR.to_string());
    format!("{prefix}{high_water}{HIGH_WATER_HOLES_SEPARATOR}{holes}")
}

impl CursorToken {
    /// The token a client sends before it has pulled anything.
    #[must_use]
    pub const fn bootstrap() -> Self {
        Self {
            start: None,
            high_water: 0,
            holes: Vec::new(),
        }
    }

    /// A token from a high-water mark and the seqs still in flight below it.
    ///
    /// # Errors
    ///
    /// [`CursorError::Invalid`], carrying the rejected text, when a hole is `0`,
    /// sits at or above `high_water`, or the list is not strictly ascending: the
    /// grammar [`Self::parse`] enforces.
    ///
    /// # Examples
    ///
    /// ```
    /// use kizunasync_protocol::CursorToken;
    ///
    /// let token = CursorToken::new(10, vec![3, 5])?;
    /// assert_eq!(token.encode(), "10~3.5");
    /// # Ok::<(), kizunasync_protocol::CursorError>(())
    /// ```
    pub fn new(high_water: u64, holes: Vec<u64>) -> Result<Self, CursorError> {
        if !validate_holes(high_water, &holes) {
            return Err(CursorError::Invalid(encode_token(None, high_water, &holes)));
        }
        Ok(Self {
            start: None,
            high_water,
            holes,
        })
    }

    /// A continuation token: the page position, a high-water mark and the seqs
    /// still in flight below it, plus the high-water of the checkpoint the
    /// transfer started from.
    ///
    /// # Errors
    ///
    /// [`CursorError::Invalid`], carrying the rejected text, under the hole rules
    /// of [`Self::new`].
    ///
    /// # Examples
    ///
    /// ```
    /// use kizunasync_protocol::CursorToken;
    ///
    /// let token = CursorToken::continuation(4, 9, vec![5, 7])?;
    /// assert_eq!(token.encode(), "4:9~5.7");
    /// # Ok::<(), kizunasync_protocol::CursorError>(())
    /// ```
    pub fn continuation(start: u64, high_water: u64, holes: Vec<u64>) -> Result<Self, CursorError> {
        if !validate_holes(high_water, &holes) {
            return Err(CursorError::Invalid(encode_token(
                Some(start),
                high_water,
                &holes,
            )));
        }
        Ok(Self {
            start: Some(start),
            high_water,
            holes,
        })
    }

    /// The high-water of the checkpoint a continuation token's transfer started
    /// from, or `None` on a checkpoint token.
    #[must_use]
    pub const fn start(&self) -> Option<u64> {
        self.start
    }

    /// The mark below which every seq has been delivered, except the holes.
    #[must_use]
    pub const fn high_water(&self) -> u64 {
        self.high_water
    }

    /// The still-in-flight seqs below the mark, strictly ascending and unique.
    #[must_use]
    pub fn holes(&self) -> &[u64] {
        &self.holes
    }

    /// Decode an opaque cursor token: an optional `<start>:` prefix (the
    /// checkpoint a continuation page's transfer started from), a decimal
    /// high-water mark, optionally `~` and a `.`-separated hole list (the
    /// still-in-flight seqs below the mark). A token without `~` has no holes.
    ///
    /// # Errors
    ///
    /// [`CursorError::Empty`] when the token is empty, [`CursorError::Invalid`]
    /// for anything outside the canonical grammar of the `cursor` pattern in
    /// `packages/protocol/schemas/common.schema.json`: surrounding whitespace, a
    /// non-decimal part, a sign, a leading zero, an empty or second start, a `0`
    /// hole, a hole at or above the high-water mark, unsorted or duplicate
    /// holes, or a `~` carrying no hole. Parse neither trims nor reorders.
    ///
    /// # Examples
    ///
    /// ```
    /// use kizunasync_protocol::CursorToken;
    ///
    /// let token = CursorToken::parse("10~3.5")?;
    /// assert_eq!(token.encode(), "10~3.5");
    /// # Ok::<(), kizunasync_protocol::CursorError>(())
    /// ```
    pub fn parse(raw: &str) -> Result<Self, CursorError> {
        if raw.is_empty() {
            return Err(CursorError::Empty);
        }

        let invalid = || CursorError::Invalid(raw.to_string());
        let (start, position) = match raw.split_once(START_SEPARATOR) {
            Some((start, position)) => (Some(parse_decimal(start).ok_or_else(invalid)?), position),
            None => (None, raw),
        };
        let Some((hw, rest)) = position.split_once(HIGH_WATER_HOLES_SEPARATOR) else {
            return Ok(Self {
                start,
                high_water: parse_decimal(position).ok_or_else(invalid)?,
                holes: Vec::new(),
            });
        };

        let high_water = parse_decimal(hw).ok_or_else(invalid)?;
        let mut holes = Vec::new();
        for part in rest.split(HOLE_SEPARATOR) {
            // An empty `rest` lands here as one empty part and is rejected:
            // `<mark>~` is not a token the wire ever emits.
            holes.push(parse_decimal(part).ok_or_else(invalid)?);
        }
        if !validate_holes(high_water, &holes) {
            return Err(invalid());
        }

        Ok(Self {
            start,
            high_water,
            holes,
        })
    }

    /// Encode this token back to its canonical wire form, the exact text
    /// [`Self::parse`] accepts.
    #[must_use]
    pub fn encode(&self) -> String {
        encode_token(self.start, self.high_water, &self.holes)
    }
}

impl PartialOrd for CursorToken {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for CursorToken {
    fn cmp(&self, other: &Self) -> Ordering {
        // The order stays on the position; the start only breaks ties, so `Ord` agrees with `Eq`.
        self.high_water
            .cmp(&other.high_water)
            .then_with(|| self.holes.cmp(&other.holes))
            .then_with(|| self.start.cmp(&other.start))
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips_flat_and_composite() {
        let flat = CursorToken::parse("42").expect("flat");
        assert_eq!(flat.high_water(), 42);
        assert!(flat.holes().is_empty());
        assert_eq!(flat.encode(), "42");

        let composite = CursorToken::parse("10~3.5").expect("composite");
        assert_eq!(composite.high_water(), 10);
        assert_eq!(composite.holes(), [3, 5]);
        assert_eq!(composite.encode(), "10~3.5");
    }

    /// The single-hole corpus case cannot tell '.' from ',': only a token with
    /// two or more holes pins the delimiter.
    #[test]
    fn cursor_round_trips_every_hole_count() {
        for raw in [
            "0",
            "6",
            "6~5",
            "9~5.7",
            "1000~1.2.3.4.5",
            "18446744073709551615~18446744073709551614",
        ] {
            let token = CursorToken::parse(raw).expect(raw);
            assert_eq!(token.encode(), raw, "round trip of {raw}");
            assert_eq!(CursorToken::parse(&token.encode()).expect(raw), token);
        }
    }

    #[test]
    fn cursor_rejects_tokens_outside_the_wire_grammar() {
        for raw in [
            "9~5,7",   // the comma is not the wire delimiter
            "9~",      // a tilde carrying no hole
            "9~0",     // seqs start at 1
            "9~05",    // leading zero
            "007",     // leading zero on the high-water mark
            "9~5.x",   // non-decimal hole
            "9~5..7",  // empty hole between separators
            "~5",      // no high-water mark
            "06",      // leading zero
            "6~6",     // hole at the high-water mark
            "10~8.3",  // holes not ascending
            "9~7.5.7", // unsorted and duplicate
            ":6",      // empty start
            ":",       // a bare start separator
            "-1:6",    // a signed start
            "+1:6",    // a signed start
            "+6",      // a signed high-water mark
            "1:2:3",   // a second start
            "4:6:",    // a trailing start separator
            "04:6",    // leading zero on the start
            "4:",      // a start with no position
            "4:06",    // leading zero on the high-water mark
        ] {
            assert_eq!(
                CursorToken::parse(raw),
                Err(CursorError::Invalid(raw.to_string())),
                "must reject {raw}"
            );
        }
        assert_eq!(CursorToken::parse(""), Err(CursorError::Empty));
    }

    /// The wire pattern is anchored, so a codec that trimmed would accept a token
    /// the TypeScript and SQL codecs reject.
    #[test]
    fn cursor_rejects_surrounding_whitespace() {
        for raw in ["  ", " 6", "6 ", "\t6", "6\n", " 0:2", "0:2 ", "6~5 "] {
            assert_eq!(
                CursorToken::parse(raw),
                Err(CursorError::Invalid(raw.to_string())),
                "must reject {raw:?}"
            );
        }
    }

    #[test]
    fn cursor_round_trips_continuation_forms() {
        for raw in [
            "0:0",
            "0:2",
            "12:3",
            "4:6~5",
            "4:9~5.7",
            "18446744073709551615:18446744073709551615~18446744073709551614",
        ] {
            let token = CursorToken::parse(raw).expect(raw);
            assert_eq!(token.encode(), raw, "round trip of {raw}");
        }

        let token = CursorToken::parse("4:9~5.7").expect("continuation");
        assert_eq!(token.start(), Some(4));
        assert_eq!(token.high_water(), 9);
        assert_eq!(token.holes(), [5, 7]);
        assert_eq!(
            CursorToken::parse("9~5.7").expect("checkpoint").start(),
            None
        );
    }

    #[test]
    fn continuation_carries_its_start_and_rejects_invalid_holes() {
        let token = CursorToken::continuation(0, 2, vec![]).expect("continuation");
        assert_eq!(token.encode(), "0:2");
        assert_eq!(token.start(), Some(0));
        assert_eq!(
            CursorToken::continuation(4, 6, vec![6]),
            Err(CursorError::Invalid("4:6~6".to_string()))
        );
    }

    #[test]
    fn ordering_stays_on_the_position_and_ties_on_the_start() {
        let continuation = CursorToken::parse("7:5").expect("continuation");
        assert!(continuation < CursorToken::parse("6").expect("checkpoint"));
        assert!(CursorToken::parse("5").expect("checkpoint") < continuation);
        assert!(CursorToken::parse("0:5").expect("continuation") < continuation);
    }

    #[test]
    fn cursor_shared_vectors_agree_with_the_typescript_codec() {
        let raw = include_str!("../../../packages/protocol/spec/cursor-token-vectors.json");
        let json: serde_json::Value = serde_json::from_str(raw).expect("vectors json");
        for token in json["accept"].as_array().expect("accept") {
            let token = token.as_str().expect("accept string");
            let parsed = CursorToken::parse(token).unwrap_or_else(|_| panic!("accept {token}"));
            assert_eq!(parsed.encode(), token, "round trip of {token}");
        }
        for token in json["reject"].as_array().expect("reject") {
            let token = token.as_str().expect("reject string");
            assert!(CursorToken::parse(token).is_err(), "must reject {token}");
        }
    }

    #[test]
    fn new_rejects_a_zero_hole() {
        assert_eq!(
            CursorToken::new(9, vec![0]),
            Err(CursorError::Invalid("9~0".to_string()))
        );
    }

    #[test]
    fn new_rejects_a_hole_at_or_above_high_water() {
        assert_eq!(
            CursorToken::new(6, vec![6]),
            Err(CursorError::Invalid("6~6".to_string()))
        );
        assert_eq!(
            CursorToken::new(6, vec![7]),
            Err(CursorError::Invalid("6~7".to_string()))
        );
    }

    #[test]
    fn new_rejects_unsorted_or_duplicate_holes() {
        assert_eq!(
            CursorToken::new(10, vec![8, 3]),
            Err(CursorError::Invalid("10~8.3".to_string()))
        );
        assert_eq!(
            CursorToken::new(10, vec![5, 5]),
            Err(CursorError::Invalid("10~5.5".to_string()))
        );
    }

    #[test]
    fn new_then_encode_then_parse_round_trips() {
        for (high_water, holes) in [(42, vec![]), (6, vec![5]), (10, vec![3, 5, 9])] {
            let token = CursorToken::new(high_water, holes).expect("canonical token");
            let encoded = token.encode();
            assert_eq!(CursorToken::parse(&encoded).expect(&encoded), token);
        }
    }

    #[test]
    fn bootstrap_is_zero() {
        assert_eq!(CursorToken::bootstrap().encode(), "0");
    }

    #[test]
    fn wire_member_from_str_accepts_renames_and_rejects_unknown() {
        assert_eq!("insert".parse::<Op>().unwrap(), Op::Insert);
        assert_eq!(
            "RESET_REQUIRED".parse::<SignalType>().unwrap(),
            SignalType::ResetRequired
        );
        assert_eq!(
            "CONSTRAINT".parse::<RejectReason>().unwrap(),
            RejectReason::Constraint
        );
        assert_eq!(
            "applied".parse::<WireVerdictKind>().unwrap(),
            WireVerdictKind::Applied
        );
        assert_eq!(
            "aborted".parse::<WireBatchOutcome>().unwrap(),
            WireBatchOutcome::Aborted
        );
        assert_eq!("hlc".parse::<ConflictMode>().unwrap(), ConflictMode::Hlc);
        assert_eq!("NOT_A_SIGNAL".parse::<SignalType>(), Err(UnknownWireMember));
        assert_eq!(parse_wire_member::<Op>("delete"), Some(Op::Delete));
        assert_eq!(parse_wire_member::<Op>("upsert"), None);
    }
}
