use super::ast::{
    CARDINALITY_MANY, CARDINALITY_MAYBE_SINGLE, CARDINALITY_SINGLE, Filter, QueryError, QueryPlan,
    Row, TEXT_SEARCH_PHRASE, TEXT_SEARCH_WEBSEARCH,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::cell::OnceCell;

const fn is_nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

const fn ordering_to_i8(ordering: std::cmp::Ordering) -> i8 {
    match ordering {
        std::cmp::Ordering::Less => -1,
        std::cmp::Ordering::Equal => 0,
        std::cmp::Ordering::Greater => 1,
    }
}

fn compare_for_range(cell: Option<&Value>, expected: &Value) -> Option<i8> {
    if is_nullish(cell) || expected.is_null() {
        return None;
    }

    let cell = cell?;
    if let (Some(a), Some(b)) = (cell.as_f64(), expected.as_f64()) {
        // Exact IEEE comparison: an epsilon window would make 0.30000000000000004
        // equal to 0.3, so a range filter would answer a question nobody asked.
        // JSON numbers are never NaN, so `partial_cmp` is total and the fallback
        // is unreachable.
        return Some(a.partial_cmp(&b).map_or(1, ordering_to_i8));
    }

    let left = value_as_search_text(Some(cell)).unwrap_or_default();
    let right = value_as_search_text(Some(expected)).unwrap_or_default();
    Some(ordering_to_i8(left.cmp(&right)))
}

#[cfg(test)]
thread_local! {
    /// The regexes and search terms this thread built, so a test can pin one
    /// build per query.
    pub(crate) static BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn count_build() {
    BUILDS.with(|builds| builds.set(builds.get() + 1));
}

/// A `LIKE` pattern as an anchored regex. `*` spans any run exactly as `%`
/// does: `PostgREST` reads it as `%` in a `like` value, so a pattern means here
/// what supabase-js would send.
fn like_to_regex(pattern: &str, case_insensitive: bool) -> Result<Regex, QueryError> {
    #[cfg(test)]
    count_build();
    let mut source = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' && i + 1 < chars.len() {
            source.push_str(&regex::escape(&chars[i + 1].to_string()));
            i += 2;
            continue;
        }
        if ch == '%' || ch == '*' {
            source.push_str(".*");
            i += 1;
            continue;
        }
        if ch == '_' {
            source.push('.');
            i += 1;
            continue;
        }
        source.push_str(&regex::escape(&ch.to_string()));
        i += 1;
    }
    source.push('$');
    let mut builder = regex::RegexBuilder::new(&source);
    builder.case_insensitive(case_insensitive);
    builder
        .build()
        .map_err(|e| QueryError::InvalidFilter(e.to_string()))
}

pub(crate) fn value_as_search_text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(number_as_text(n)),
        Some(Value::Bool(b)) => Some(b.to_string()),
        // Null, absent, arrays and objects are not searchable text.
        _ => None,
    }
}

/// Largest magnitude an `f64` still represents every integer below exactly.
const MAX_EXACT_INTEGRAL_F64: f64 = 9_007_199_254_740_992.0;

/// A number as the text surfaces address it: by value, so a float carrying no
/// fraction renders as the integer it equals and `like`, `search`, `textSearch`
/// and the mixed-type ordering fallback cannot tell `3` from `3.0`.
fn number_as_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    match number.as_f64() {
        Some(0.0) => "0".to_string(),
        Some(value) if value.fract() == 0.0 && value.abs() < MAX_EXACT_INTEGRAL_F64 => {
            format!("{value:.0}")
        }
        _ => number.to_string(),
    }
}

/// Operand identity for `eq`, `neq`, `in` and the scalar case of the containment
/// filters: two numbers are the same operand when they name the same value, so an
/// integer matches the float that equals it. Everything else compares structurally.
fn json_scalar_equal(left: &Value, right: &Value) -> bool {
    if let (Value::Number(a), Value::Number(b)) = (left, right) {
        return match (a.as_f64(), b.as_f64()) {
            (Some(x), Some(y)) => x.partial_cmp(&y) == Some(std::cmp::Ordering::Equal),
            _ => a == b,
        };
    }
    left == right
}

/// A JSON-looking text cell decoded for containment; any other cell as stored.
fn decode_json_cell(cell: &Value) -> Value {
    if let Value::String(s) = cell {
        let t = s.trim();
        if (t.starts_with('{') && t.ends_with('}')) || (t.starts_with('[') && t.ends_with(']')) {
            // A brace/bracket-shaped cell that still fails to parse is not malformed
            // JSON to report: it is genuinely the literal string the row stores, so
            // containment compares it as text instead of erroring.
            return serde_json::from_str(t).unwrap_or_else(|_| cell.clone());
        }
    }
    cell.clone()
}

fn json_deep_equal(left: &Value, right: &Value) -> bool {
    left == right
}

fn json_contains(haystack: &Value, needle: &Value) -> bool {
    if !needle.is_object() && !needle.is_array() {
        return json_scalar_equal(haystack, needle);
    }
    if let Some(needle_arr) = needle.as_array() {
        let Some(hay_arr) = haystack.as_array() else {
            return false;
        };
        return needle_arr
            .iter()
            .all(|item| hay_arr.iter().any(|c| json_deep_equal(c, item)));
    }
    if let Some(needle_obj) = needle.as_object() {
        let Some(hay_obj) = haystack.as_object() else {
            return false;
        };
        return needle_obj.iter().all(|(k, v)| {
            if !hay_obj.contains_key(k) {
                return false;
            }
            let left = &hay_obj[k];
            if v.is_object() || v.is_array() {
                json_contains(left, v)
            } else {
                json_deep_equal(left, v)
            }
        });
    }
    false
}

/// A predicate's SQL truth value: `Some(true)`, `Some(false)`, or `None` for
/// unknown, the answer a comparison with a null or absent cell gives.
type Truth = Option<bool>;

/// The cell a comparison reads, or `None` when it is null or absent.
fn known(cell: Option<&Value>) -> Option<&Value> {
    cell.filter(|value| !value.is_null())
}

/// `test` over the cell, or unknown when the cell or the operand is null or
/// absent: SQL compares nothing with NULL.
fn compare_known(
    cell: Option<&Value>,
    operand: &Value,
    test: impl FnOnce(&Value) -> bool,
) -> Truth {
    let cell = known(cell)?;
    if operand.is_null() {
        return None;
    }
    Some(test(cell))
}

/// SQL `IN`: true on a member, false on an empty list whatever the cell holds
/// (as `= ANY('{}')`), and otherwise unknown for a null or absent cell or when a
/// member is null.
fn membership(cell: Option<&Value>, values: &[Value]) -> Truth {
    if values.is_empty() {
        return Some(false);
    }

    let cell = known(cell)?;
    if values.iter().any(|value| json_scalar_equal(cell, value)) {
        return Some(true);
    }
    if values.iter().any(Value::is_null) {
        None
    } else {
        Some(false)
    }
}

/// A `LIKE` pattern over the cell's text; unknown for a null or absent cell,
/// false for a cell that has no text form (an array or an object). The regex
/// is asked for only when there is text to match.
fn like_truth<'r>(
    cell: Option<&Value>,
    regex: impl FnOnce() -> Result<&'r Regex, QueryError>,
) -> Result<Truth, QueryError> {
    let Some(cell) = known(cell) else {
        return Ok(None);
    };

    Ok(Some(match value_as_search_text(Some(cell)) {
        None => false,
        Some(text) => regex()?.is_match(&text),
    }))
}

/// Case-insensitive substring over the named columns, or over every string and
/// number cell. Each named column is one comparison, OR-ed together: a null or
/// absent cell among them is unknown unless another column matches.
fn search_truth(row: &Row, query: &str, columns: Option<&[String]>) -> Truth {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Some(true);
    }

    let has_needle = |cell: &Value| {
        value_as_search_text(Some(cell)).is_some_and(|text| text.to_lowercase().contains(&needle))
    };
    let Some(columns) = columns else {
        return Some(
            row.values()
                .filter(|cell| cell.is_string() || cell.is_number())
                .any(has_needle),
        );
    };

    let mut answer = Some(false);
    for column in columns {
        match known(row.get(column)) {
            None => answer = None,
            Some(cell) if has_needle(cell) => return Some(true),
            Some(_) => {}
        }
    }
    answer
}

/// The terms a `textSearch` query needs in a cell, lowercased: none for a
/// blank query, the whole query for `phrase`, every quoted phrase and bare
/// token for `websearch`, and every token for `plain`.
fn search_terms(query: &str, mode: &str) -> Result<Vec<String>, QueryError> {
    let raw = query.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    if mode == TEXT_SEARCH_PHRASE {
        return Ok(vec![raw.to_lowercase()]);
    }

    if mode == TEXT_SEARCH_WEBSEARCH {
        #[cfg(test)]
        count_build();
        let mut terms = Vec::new();
        let quoted =
            Regex::new("\"([^\"]+)\"").map_err(|e| QueryError::InvalidFilter(e.to_string()))?;
        let without = quoted.replace_all(raw, |caps: &regex::Captures| {
            terms.push(caps[1].to_lowercase());
            " "
        });
        terms.extend(tokens(&without));
        return Ok(terms);
    }

    Ok(tokens(raw))
}

/// The lowercased whitespace-separated tokens of `text`.
fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// Token, phrase or web search over one text cell: unknown for a null or
/// absent cell, false for a cell with no text form, and otherwise whether the
/// cell holds every term of the query ([`search_terms`]). The terms are asked
/// for only when there is text to search.
fn text_search_truth<'t>(
    cell: Option<&Value>,
    terms: impl FnOnce() -> Result<&'t [String], QueryError>,
) -> Result<Truth, QueryError> {
    let Some(cell) = known(cell) else {
        return Ok(None);
    };
    let Some(text) = value_as_search_text(Some(cell)) else {
        return Ok(Some(false));
    };

    let haystack = text.to_lowercase();
    Ok(Some(
        terms()?.iter().all(|term| haystack.contains(term.as_str())),
    ))
}

/// The value `cell` holds, built by `build` on the first call and handed back
/// as is on every later one.
fn built<T>(
    cell: &OnceCell<T>,
    build: impl FnOnce() -> Result<T, QueryError>,
) -> Result<&T, QueryError> {
    if let Some(value) = cell.get() {
        return Ok(value);
    }

    let value = build()?;
    Ok(cell.get_or_init(|| value))
}

/// One filter node as a [`Predicate`] evaluates it: a `like`, `ilike` or
/// `textSearch` node keeps what it builds, and `and`, `or` and `not` hold their
/// children as nodes.
#[derive(Debug)]
enum Node<'a> {
    /// A node evaluated from its filter alone.
    Leaf(&'a Filter),
    /// A `like` or `ilike` pattern and its regex, built when a row first
    /// reaches it.
    Like {
        column: &'a str,
        pattern: &'a str,
        case_insensitive: bool,
        regex: OnceCell<Regex>,
    },
    /// A `textSearch` query and its terms, built when a row first reaches it.
    TextSearch {
        column: &'a str,
        query: &'a str,
        mode: &'a str,
        terms: OnceCell<Vec<String>>,
    },
    And(Vec<Self>),
    Or(Vec<Self>),
    Not(Box<Self>),
}

impl<'a> Node<'a> {
    fn new(filter: &'a Filter) -> Self {
        match filter {
            Filter::Like { column, pattern } => Self::like(column, pattern, false),
            Filter::Ilike { column, pattern } => Self::like(column, pattern, true),
            Filter::TextSearch {
                column,
                query,
                r#type,
            } => Self::TextSearch {
                column: column.as_str(),
                query: query.as_str(),
                mode: r#type.as_str(),
                terms: OnceCell::new(),
            },
            Filter::And { filters } => Self::And(filters.iter().map(Self::new).collect()),
            Filter::Or { filters } => Self::Or(filters.iter().map(Self::new).collect()),
            Filter::Not { filter } => Self::Not(Box::new(Self::new(filter))),
            Filter::Eq { .. }
            | Filter::Neq { .. }
            | Filter::Gt { .. }
            | Filter::Gte { .. }
            | Filter::Lt { .. }
            | Filter::Lte { .. }
            | Filter::Is { .. }
            | Filter::In { .. }
            | Filter::Contains { .. }
            | Filter::ContainedBy { .. }
            | Filter::Search { .. } => Self::Leaf(filter),
        }
    }

    const fn like(column: &'a str, pattern: &'a str, case_insensitive: bool) -> Self {
        Self::Like {
            column,
            pattern,
            case_insensitive,
            regex: OnceCell::new(),
        }
    }
}

/// SQL `AND` over `nodes`: false as soon as one child is false, otherwise
/// unknown when a child is unknown, and true for an empty list.
fn all_of(row: &Row, nodes: &[Node<'_>]) -> Result<Truth, QueryError> {
    let mut answer = Some(true);
    for node in nodes {
        match truth_of(row, node)? {
            Some(false) => return Ok(Some(false)),
            None => answer = None,
            Some(true) => {}
        }
    }
    Ok(answer)
}

/// SQL `OR` over `nodes`: true as soon as one child is true, otherwise
/// unknown when a child is unknown, and false for an empty list.
fn any_of(row: &Row, nodes: &[Node<'_>]) -> Result<Truth, QueryError> {
    let mut answer = Some(false);
    for node in nodes {
        match truth_of(row, node)? {
            Some(true) => return Ok(Some(true)),
            None => answer = None,
            Some(false) => {}
        }
    }
    Ok(answer)
}

/// The SQL truth value of one node on one row.
fn truth_of(row: &Row, node: &Node<'_>) -> Result<Truth, QueryError> {
    match node {
        Node::Leaf(filter) => leaf_truth(row, filter),
        Node::Like {
            column,
            pattern,
            case_insensitive,
            regex,
        } => like_truth(row.get(*column), || {
            built(regex, || like_to_regex(pattern, *case_insensitive))
        }),
        Node::TextSearch {
            column,
            query,
            mode,
            terms,
        } => text_search_truth(row.get(*column), || {
            built(terms, || search_terms(query, mode)).map(Vec::as_slice)
        }),
        Node::And(nodes) => all_of(row, nodes),
        Node::Or(nodes) => any_of(row, nodes),
        Node::Not(node) => Ok(truth_of(row, node)?.map(|holds| !holds)),
    }
}

/// The SQL truth value of a filter that builds nothing to evaluate.
fn leaf_truth(row: &Row, filter: &Filter) -> Result<Truth, QueryError> {
    Ok(match filter {
        Filter::Eq { column, value } => compare_known(row.get(column), value, |cell| {
            json_scalar_equal(cell, value)
        }),
        Filter::Neq { column, value } => compare_known(row.get(column), value, |cell| {
            !json_scalar_equal(cell, value)
        }),
        Filter::Gt { column, value } => compare_for_range(row.get(column), value).map(|o| o == 1),
        Filter::Gte { column, value } => compare_for_range(row.get(column), value).map(|o| o >= 0),
        Filter::Lt { column, value } => compare_for_range(row.get(column), value).map(|o| o == -1),
        Filter::Lte { column, value } => compare_for_range(row.get(column), value).map(|o| o <= 0),
        // Never unknown: it folds an absent column into null and answers true
        // or false on every row.
        Filter::Is { column, value } => {
            let cell = row.get(column).unwrap_or(&Value::Null);
            Some(if value.is_null() {
                cell.is_null()
            } else {
                cell == value
            })
        }
        Filter::In { column, values } => membership(row.get(column), values),
        Filter::Contains { column, value } => compare_known(row.get(column), value, |cell| {
            json_contains(&decode_json_cell(cell), value)
        }),
        Filter::ContainedBy { column, value } => compare_known(row.get(column), value, |cell| {
            json_contains(value, &decode_json_cell(cell))
        }),
        Filter::Search { query, columns } => search_truth(row, query, columns.as_deref()),
        // `Node::new` never makes a leaf of these kinds; a fresh node still
        // answers one correctly.
        Filter::Like { .. }
        | Filter::Ilike { .. }
        | Filter::TextSearch { .. }
        | Filter::And { .. }
        | Filter::Or { .. }
        | Filter::Not { .. } => truth_of(row, &Node::new(filter))?,
    })
}

/// A filter list ready to evaluate over many rows, combined with AND under
/// the same three-valued logic as [`matches_filter`].
///
/// A `like` or `ilike` pattern compiles to its regex, and a `textSearch` query
/// splits into its terms, the first time a row reaches that node; every later
/// row reuses them. A node no row reaches builds nothing, so a pattern that
/// cannot compile fails only an evaluation that needs it. Hold one per query.
///
/// `Send` but not `Sync`: it fills in what it builds in place.
#[derive(Debug)]
pub struct Predicate<'a> {
    nodes: Vec<Node<'a>>,
}

impl<'a> Predicate<'a> {
    /// Prepare `filters` for evaluation; nothing is built until a row needs it.
    #[must_use]
    pub fn new(filters: &'a [Filter]) -> Self {
        Self {
            nodes: filters.iter().map(Node::new).collect(),
        }
    }

    /// Whether `row` satisfies every filter, the answer [`matches_filters`]
    /// gives. The caller validates the filters first
    /// ([`crate::validate::validate_filters`]).
    ///
    /// # Errors
    /// [`QueryError::InvalidFilter`] when a `like`/`ilike` pattern does not compile.
    pub fn matches(&self, row: &Row) -> Result<bool, QueryError> {
        Ok(all_of(row, &self.nodes)? == Some(true))
    }
}

/// Whether one row satisfies one predicate: whether the predicate is true on
/// it, under SQL three-valued logic.
///
/// A comparison with a null or absent cell, or with a null operand, is unknown;
/// `not` of unknown is unknown; `and` and `or` follow the SQL truth tables; and
/// only a true predicate selects the row, so an unknown one rejects it exactly
/// like a false one. [`Filter::Is`] is never unknown, so it is how a caller
/// finds nulls.
///
/// The caller validates the tree first ([`crate::validate::validate_filters`]); this evaluates it.
/// It builds the predicate's patterns for this one row: a caller that
/// evaluates many rows holds one [`Predicate`] instead.
///
/// # Errors
/// [`QueryError::InvalidFilter`] when a `like`/`ilike` pattern does not compile.
pub fn matches_filter(row: &Row, filter: &Filter) -> Result<bool, QueryError> {
    Predicate::new(std::slice::from_ref(filter)).matches(row)
}

/// Whether one row satisfies every predicate of `filters`, combined with AND
/// under the same three-valued logic as [`matches_filter`]. An empty list
/// selects every row. It builds the patterns for this one row: a caller that
/// evaluates many rows holds one [`Predicate`] instead.
///
/// # Errors
/// [`QueryError::InvalidFilter`] when a `like`/`ilike` pattern does not compile.
pub fn matches_filters(row: &Row, filters: &[Filter]) -> Result<bool, QueryError> {
    Predicate::new(filters).matches(row)
}

fn compare_values(a: Option<&Value>, b: Option<&Value>, nulls_first: bool) -> std::cmp::Ordering {
    let a_null = is_nullish(a);
    let b_null = is_nullish(b);

    if a_null && b_null {
        return std::cmp::Ordering::Equal;
    }
    if a_null {
        return if nulls_first {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    if b_null {
        return if nulls_first {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }

    // Both sides are present and non-nullish after the guards above.
    let (Some(a), Some(b)) = (a, b) else {
        return std::cmp::Ordering::Equal;
    };

    if let (Some(x), Some(y)) = (a.as_f64(), b.as_f64()) {
        return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
    }

    let left = value_as_search_text(Some(a)).unwrap_or_default();
    let right = value_as_search_text(Some(b)).unwrap_or_default();
    left.cmp(&right)
}

/// Evaluate one plan over `rows`: validate, filter, sort, limit, project, then
/// enforce the cardinality.
///
/// Rows keep their input order until a sort key reorders them. This is the
/// oracle of every local read: a caller that hands it only the rows able to
/// decide the answer ([`crate::conjunct_keys`], [`QueryPlan::decisive_matches`])
/// gets the answer the whole table would give, except that a cardinality refusal
/// counts only the matches it was handed.
///
/// # Errors
/// [`QueryError::Unsupported`] for a construct outside the local subset,
/// [`QueryError::InvalidFilter`] for a pattern that does not compile,
/// [`QueryError::InvalidCardinality`] for a cardinality outside the three known
/// ones, and [`QueryError::SingleCardinality`] / [`QueryError::MaybeSingleCardinality`]
/// when the row count contradicts the cardinality the caller asked for.
///
/// # Examples
///
/// ```
/// use kizunasync_query::{QueryPlan, apply_query};
/// use serde_json::{Map, json};
///
/// let mut row = Map::new();
/// row.insert("id".into(), json!("p1"));
/// let result = apply_query(vec![row], &QueryPlan::default())?;
/// assert!(matches!(result, kizunasync_query::QueryResult::Many(rows) if rows.len() == 1));
/// # Ok::<(), kizunasync_query::QueryError>(())
/// ```
pub fn apply_query(mut rows: Vec<Row>, plan: &QueryPlan) -> Result<QueryResult, QueryError> {
    plan.validate()?;
    if !plan.filters.is_empty() {
        let predicate = Predicate::new(&plan.filters);
        let mut filtered = Vec::new();
        for row in rows {
            if predicate.matches(&row)? {
                filtered.push(row);
            }
        }
        rows = filtered;
    }

    for order in plan.orders.iter().rev() {
        let nulls_first = order.nulls_first.unwrap_or(!order.ascending);
        rows.sort_by(|l, r| {
            let mut ord = compare_values(l.get(&order.column), r.get(&order.column), nulls_first);
            if !order.ascending {
                ord = ord.reverse();
            }
            ord
        });
    }

    if let Some(limit) = plan.limit {
        // Validated at or above zero above; the saturating fallback is for a
        // 32-bit target whose `usize` cannot hold the limit, where truncating to
        // the whole result set is the same answer.
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    }

    if let Some(proj) = &plan.projection {
        rows = rows
            .into_iter()
            .map(|row| {
                let mut out = Map::new();
                for col in proj {
                    let col = col.trim();
                    if col.is_empty() {
                        continue;
                    }
                    out.insert(
                        col.to_string(),
                        row.get(col).cloned().unwrap_or(Value::Null),
                    );
                }
                out
            })
            .collect();
    }

    match plan.cardinality.as_str() {
        CARDINALITY_MANY => Ok(QueryResult::Many(rows)),
        CARDINALITY_SINGLE => {
            if rows.len() != 1 {
                return Err(QueryError::SingleCardinality(rows.len()));
            }
            Ok(QueryResult::One(rows.remove(0)))
        }
        CARDINALITY_MAYBE_SINGLE => {
            if rows.len() > 1 {
                return Err(QueryError::MaybeSingleCardinality(rows.len()));
            }
            Ok(QueryResult::Maybe(rows.pop()))
        }
        // A typo'd cardinality silently answering `many` would hand a caller that
        // asked for one row a whole table (no silent fallback).
        other => Err(QueryError::InvalidCardinality(other.to_string())),
    }
}

/// What one plan answers, shaped by its cardinality: an array for `many`, an
/// object for `single`, an object or null for `maybeSingle`. Untagged on the wire,
/// so the JSON is the bare value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QueryResult {
    /// Every matching row, in plan order.
    Many(Vec<Row>),
    /// The single matching row `single()` demanded.
    One(Row),
    /// The at-most-one matching row `maybeSingle()` allowed.
    Maybe(Option<Row>),
}
