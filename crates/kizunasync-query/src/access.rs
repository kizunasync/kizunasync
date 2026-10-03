//! Which rows can decide a plan: the keys a conjunct names, and how many
//! matches decide an unordered plan. A caller that reads only those rows and
//! hands them to [`crate::apply_query`] gets the answer the whole table gives.

use super::ast::{CARDINALITY_MAYBE_SINGLE, CARDINALITY_SINGLE, Filter, QueryPlan};
use serde_json::Value;

/// The matches a one-row cardinality needs at most: a second match already
/// breaks it.
const ONE_ROW_DECIDED_BY: usize = 2;

/// The operands an `eq` or `in` on `column` restricts `filters` to, when one is
/// a conjunct of them: a filter of the list itself, or a child of an `and` in
/// the list at any depth. The first such conjunct wins.
///
/// Every operand comes back as the filter wrote it. A row whose `column` equals
/// none of them is never true on that conjunct, and so never true on the whole
/// list, but "equals" is the evaluator's: numbers compare by value, so the
/// caller that turns operands into keys decides which of them name a row. An
/// empty answer means no row can match. `None` when no conjunct names `column`.
#[must_use]
pub fn conjunct_keys<'a>(filters: &'a [Filter], column: &str) -> Option<Vec<&'a Value>> {
    filters.iter().find_map(|filter| match filter {
        Filter::Eq {
            column: named,
            value,
        } if named == column => Some(vec![value]),
        Filter::In {
            column: named,
            values,
        } if named == column => Some(values.iter().collect()),
        Filter::And { filters } => conjunct_keys(filters, column),
        Filter::Eq { .. }
        | Filter::In { .. }
        | Filter::Neq { .. }
        | Filter::Gt { .. }
        | Filter::Gte { .. }
        | Filter::Lt { .. }
        | Filter::Lte { .. }
        | Filter::Like { .. }
        | Filter::Ilike { .. }
        | Filter::RegexMatch { .. }
        | Filter::RegexIMatch { .. }
        | Filter::Is { .. }
        | Filter::IsDistinct { .. }
        | Filter::Contains { .. }
        | Filter::ContainedBy { .. }
        | Filter::Overlaps { .. }
        | Filter::Or { .. }
        | Filter::Not { .. }
        | Filter::Search { .. }
        | Filter::TextSearch { .. } => None,
    })
}

impl QueryPlan {
    /// How many matches, taken in input order, decide this plan, or `None` when
    /// the answer needs every match: a plan with `orders` sorts them all, a
    /// `count` plan counts them all, and one with neither a `limit` nor a
    /// one-row cardinality returns them all.
    ///
    /// Otherwise the first `limit` matches decide it, and a `single` or
    /// `maybeSingle` plan is decided by its first two; with both, the smaller
    /// count. An `offset` adds the matches it skips to that count. A limit below
    /// zero, which [`QueryPlan::validate`] refuses, names no count, and an
    /// offset below zero, refused the same way, leaves the plan to every match.
    #[must_use]
    pub fn decisive_matches(&self) -> Option<usize> {
        if !self.orders.is_empty() || self.count {
            return None;
        }

        let skipped = usize::try_from(self.offset.unwrap_or(0)).ok()?;
        let by_limit = self.limit.and_then(|limit| usize::try_from(limit).ok());
        let by_cardinality = matches!(
            self.cardinality.as_str(),
            CARDINALITY_SINGLE | CARDINALITY_MAYBE_SINGLE
        )
        .then_some(ONE_ROW_DECIDED_BY);
        let kept = match (by_limit, by_cardinality) {
            (Some(limit), Some(one_row)) => Some(limit.min(one_row)),
            (by_limit, by_cardinality) => by_limit.or(by_cardinality),
        };
        kept.map(|kept| skipped.saturating_add(kept))
    }
}
