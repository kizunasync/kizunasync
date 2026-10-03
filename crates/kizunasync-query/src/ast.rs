use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

/// One local row as the query grammar addresses it: the stored column map with
/// the primary key folded in under `id`.
pub type Row = Map<String, Value>;

/// One node of the local predicate grammar, tagged on the wire by `kind`.
///
/// A node is true, false, or unknown on a row, as in SQL: a comparison with a
/// null or absent cell, or with a null operand, is unknown; `not` of unknown is
/// unknown; `and` and `or` follow the SQL truth tables. A row matches only when
/// the whole predicate is true, so an unknown answer rejects it like a false one.
///
/// An unknown `kind` or an unknown key inside a node is a deserialization failure,
/// never a node the evaluator quietly ignores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Filter {
    /// The cell equals `value`. A null or absent cell, or a null `value`, is
    /// unknown, so `eq` with null matches no row, as `= NULL` does;
    /// [`Filter::Is`] tests for null.
    Eq {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// The cell does not equal `value`. A null or absent cell, or a null
    /// `value`, is unknown, so neither `neq` nor its negation matches that row.
    Neq {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// The cell sorts after `value`. A null or absent cell, or a null `value`,
    /// is unknown.
    Gt {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// The cell sorts at or after `value`. A null or absent cell, or a null
    /// `value`, is unknown.
    Gte {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// The cell sorts before `value`. A null or absent cell, or a null `value`,
    /// is unknown.
    Lt {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// The cell sorts at or before `value`. A null or absent cell, or a null
    /// `value`, is unknown.
    Lte {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// Case-sensitive `LIKE`: `%` and `*` span any run, `_` one character, `\\`
    /// escapes. `*` is `PostgREST`'s alias for `%` in a `like` value. A null or
    /// absent cell is unknown; an array or object cell is false.
    Like {
        /// Column the predicate reads.
        column: String,
        /// The `LIKE` pattern, anchored at both ends.
        pattern: String,
    },
    /// Case-insensitive [`Filter::Like`].
    Ilike {
        /// Column the predicate reads.
        column: String,
        /// The `LIKE` pattern, anchored at both ends.
        pattern: String,
    },
    /// Postgres `~`: the regular expression matches somewhere in the cell's
    /// text unless it anchors itself. A null or absent cell is unknown; an array
    /// or object cell is false. A pattern the `regex` crate cannot compile
    /// (backreferences, lookaround, invalid syntax) is refused.
    RegexMatch {
        /// Column the predicate reads.
        column: String,
        /// The regular expression, unanchored.
        pattern: String,
    },
    /// Case-insensitive [`Filter::RegexMatch`], Postgres `~*`.
    RegexIMatch {
        /// Column the predicate reads.
        column: String,
        /// The regular expression, unanchored.
        pattern: String,
    },
    /// Identity against `null`, `true` or `false`; an absent column reads as null.
    /// Never unknown, so it is the node that finds nulls.
    Is {
        /// Column the predicate reads.
        column: String,
        /// The operand, restricted to JSON null, `true` and `false`.
        value: Value,
    },
    /// `IS DISTINCT FROM`: true when exactly one of the cell and `value` is null
    /// or both are present and unequal. An absent column reads as null. Never
    /// unknown, so it is the inequality that keeps the null rows `neq` drops.
    IsDistinct {
        /// Column the predicate reads.
        column: String,
        /// Operand the cell is compared against.
        value: Value,
    },
    /// The cell equals one member of `values`, as SQL `IN`: an empty list is
    /// false; otherwise a null or absent cell is unknown, and so is a cell that
    /// equals no member when a member is null.
    In {
        /// Column the predicate reads.
        column: String,
        /// The candidate operands.
        values: Vec<Value>,
    },
    /// The cell contains `value`: array superset, object subset-of-values, or
    /// scalar identity. A JSON-looking text cell is decoded first. A null or
    /// absent cell, or a null `value`, is unknown.
    Contains {
        /// Column the predicate reads.
        column: String,
        /// The operand the cell must contain.
        value: Value,
    },
    /// The mirror of [`Filter::Contains`]: `value` contains the cell. A null or
    /// absent cell, or a null `value`, is unknown.
    ContainedBy {
        /// Column the predicate reads.
        column: String,
        /// The operand that must contain the cell.
        value: Value,
    },
    /// Postgres `&&`: the cell array shares at least one element with `value`.
    /// The cell is decoded as [`Filter::Contains`] decodes it, and a cell that is
    /// no array is false. `value` is a JSON array, or text that parses as one; a
    /// Postgres range literal or any other operand is refused. A null or absent
    /// cell, or a null `value`, is unknown.
    Overlaps {
        /// Column the predicate reads.
        column: String,
        /// The array the cell must share an element with.
        value: Value,
    },
    /// Every child is true. False when a child is false, otherwise unknown when
    /// a child is unknown. An empty list is true on every row.
    And {
        /// The children, all of which must match.
        filters: Vec<Self>,
    },
    /// Some child is true. True when a child is true, otherwise unknown when a
    /// child is unknown. An empty list is false on every row.
    Or {
        /// The children, one of which must match.
        filters: Vec<Self>,
    },
    /// The child is false. The negation of unknown is unknown.
    Not {
        /// The negated child.
        filter: Box<Self>,
    },
    /// Case-insensitive substring over `columns`, or over every string and number
    /// cell when `columns` is absent. A blank query matches every row. Each named
    /// column is one comparison, OR-ed with the others, so a null or absent cell
    /// among them is unknown unless another column matches.
    Search {
        /// The needle; blank matches every row.
        query: String,
        /// The columns to scan, or `None` for every string and number cell.
        #[serde(default)]
        columns: Option<Vec<String>>,
    },
    /// Token, phrase or web search over one text cell. A blank query matches every
    /// text cell; a null or absent cell is unknown, and an array or object cell
    /// is false.
    TextSearch {
        /// Column the predicate reads.
        column: String,
        /// The needle; blank matches every row.
        query: String,
        /// One of `plain`, `phrase` and `websearch`.
        #[serde(default = "default_plain")]
        r#type: String,
    },
}

/// The `textSearch` mode a plan carries when it names none.
fn default_plain() -> String {
    TEXT_SEARCH_PLAIN.to_string()
}

/// Token search: every token of the query appears somewhere in the cell.
pub(crate) const TEXT_SEARCH_PLAIN: &str = "plain";
/// Phrase search: the whole query appears contiguously in the cell.
pub(crate) const TEXT_SEARCH_PHRASE: &str = "phrase";
/// Web search: every quoted phrase and every bare token appears in the cell.
pub(crate) const TEXT_SEARCH_WEBSEARCH: &str = "websearch";

/// The cardinality that answers every matching row.
pub(crate) const CARDINALITY_MANY: &str = "many";
/// The cardinality that demands exactly one matching row.
pub(crate) const CARDINALITY_SINGLE: &str = "single";
/// The cardinality that allows zero or one matching row.
pub(crate) const CARDINALITY_MAYBE_SINGLE: &str = "maybeSingle";

/// One sort key. Keys are applied in declaration order and the sort is stable, so
/// a later key never disturbs the order an earlier one established.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrderBy {
    /// Column the rows are sorted by.
    pub column: String,
    /// Ascending by default.
    #[serde(default = "default_true")]
    pub ascending: bool,
    /// Where nulls land. Absent means nulls first on a descending key and last on
    /// an ascending one. The wire key is `nullsFirst`.
    #[serde(default)]
    pub nulls_first: Option<bool>,
}

/// The `ascending` an order carries when it names none.
const fn default_true() -> bool {
    true
}

/// One local read: the predicates, the sort keys, the rows to skip, the row cap,
/// the columns to keep, how many rows the caller expects back, whether
/// soft-deleted rows count as rows, and whether the answer carries a count.
///
/// Evaluation order is fixed: filter, then count, then sort, then skip the
/// offset, then limit, then project, then enforce the cardinality.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryPlan {
    /// Root predicates, combined with AND.
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// Sort keys, applied in declaration order.
    #[serde(default)]
    pub orders: Vec<OrderBy>,
    /// Row cap applied after sorting. Signed on the wire so a negative limit is a
    /// refusal with a code rather than a deserialization failure.
    #[serde(default)]
    pub limit: Option<i64>,
    /// Rows skipped after sorting, before `limit` counts the rest. Absent skips
    /// none; signed on the wire for the same reason as `limit`.
    #[serde(default)]
    pub offset: Option<i64>,
    /// Columns to keep. A name the row lacks projects as null; entries are trimmed
    /// and an empty entry is dropped.
    #[serde(default)]
    pub projection: Option<Vec<String>>,
    /// One of `many`, `single` and `maybeSingle`.
    #[serde(default = "default_many")]
    pub cardinality: String,
    /// Whether rows a soft-delete column marks as deleted are part of the answer.
    /// The column is the table's, not the plan's, so the exclusion happens in the
    /// engine (which holds the config) before these rows reach the evaluator. The
    /// wire key is `includeDeleted`.
    #[serde(default)]
    pub include_deleted: bool,
    /// Whether the answer also carries how many rows the filters match before
    /// the offset and the limit, a `PostgREST` exact count. The answer is then
    /// [`crate::QueryResult::Counted`].
    #[serde(default)]
    pub count: bool,
}

/// The cardinality a plan carries when it names none.
fn default_many() -> String {
    CARDINALITY_MANY.to_string()
}

/// Hand-written so a plan has ONE default whatever built it: the derived
/// implementation would leave `cardinality` an empty string, which the serde
/// default never produces and `apply_query` rejects.
impl Default for QueryPlan {
    fn default() -> Self {
        Self {
            filters: Vec::new(),
            orders: Vec::new(),
            limit: None,
            offset: None,
            projection: None,
            cardinality: default_many(),
            include_deleted: false,
            count: false,
        }
    }
}

/// Every way a local read or a filter-targeted write is refused.
///
/// The two cardinality variants are constraint faults (the plan is answerable, the
/// row count is wrong); the other three name a construct the local subset cannot
/// answer at all.
#[derive(Debug, Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum QueryError {
    /// `single()` matched a row count other than one.
    #[error("single() requires exactly one row; got {0}")]
    SingleCardinality(usize),
    /// `maybeSingle()` matched more than one row.
    #[error("maybeSingle() requires at most one row; got {0}")]
    MaybeSingleCardinality(usize),
    /// A filter the evaluator cannot compile, such as an unusable `like` pattern.
    #[error("invalid filter: {0}")]
    InvalidFilter(String),
    /// A cardinality outside `many`, `single` and `maybeSingle`.
    #[error("unknown cardinality \"{0}\" (known: many, single, maybeSingle)")]
    InvalidCardinality(String),
    /// A construct outside the local subset, named in the message.
    #[error("unsupported: {0}")]
    Unsupported(String),
}
