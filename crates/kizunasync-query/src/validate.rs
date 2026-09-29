use super::ast::{
    Filter, QueryError, QueryPlan, TEXT_SEARCH_PHRASE, TEXT_SEARCH_PLAIN, TEXT_SEARCH_WEBSEARCH,
};

/// Refuse every construct outside the local subset in `filters`, including the
/// children of `and`, `or` and `not`.
///
/// Read before any row is: the engine's filter-targeted writes run this on the
/// request they were handed, so a write refuses every construct a read refuses,
/// with the same code. A write refuses more: the engine also turns down a node
/// that names no rows (an empty `and` or `or`, a blank search pattern), which a
/// read evaluates as [`Filter`] documents.
///
/// # Errors
/// [`QueryError::Unsupported`] naming the construct: a `textSearch` type outside
/// `plain`, `phrase` and `websearch`, or an `is` operand that is not JSON null,
/// `true` or `false`.
pub fn validate_filters(filters: &[Filter]) -> Result<(), QueryError> {
    for filter in filters {
        validate_filter(filter)?;
    }
    Ok(())
}

fn validate_filter(filter: &Filter) -> Result<(), QueryError> {
    match filter {
        Filter::TextSearch { column, r#type, .. } => {
            let mode = r#type.as_str();
            if matches!(
                mode,
                TEXT_SEARCH_PLAIN | TEXT_SEARCH_PHRASE | TEXT_SEARCH_WEBSEARCH
            ) {
                return Ok(());
            }
            Err(QueryError::Unsupported(format!(
                "textSearch(\"{column}\", type: \"{mode}\"): type must be plain, phrase, or websearch"
            )))
        }
        Filter::Is { value, .. } => {
            if value.is_null() || value.is_boolean() {
                return Ok(());
            }
            Err(QueryError::Unsupported(
                "is(): operand must be null, true, or false".to_string(),
            ))
        }
        Filter::And { filters } | Filter::Or { filters } => validate_filters(filters),
        Filter::Not { filter } => validate_filter(filter),
        Filter::Eq { .. }
        | Filter::Neq { .. }
        | Filter::Gt { .. }
        | Filter::Gte { .. }
        | Filter::Lt { .. }
        | Filter::Lte { .. }
        | Filter::Like { .. }
        | Filter::Ilike { .. }
        | Filter::In { .. }
        | Filter::Contains { .. }
        | Filter::ContainedBy { .. }
        | Filter::Search { .. } => Ok(()),
    }
}

impl QueryPlan {
    /// Refuse every construct outside the local subset before a single row is read.
    ///
    /// [`crate::eval::apply_query`] runs this itself; a caller that evaluates a plan piecemeal
    /// runs it first, so an unsupported plan never half-answers.
    ///
    /// # Errors
    /// [`QueryError::Unsupported`] naming the construct: a projection entry that
    /// carries `(` or `:` (a relational embed or a rename), a limit below zero, or
    /// whatever [`validate_filters`] refuses.
    pub fn validate(&self) -> Result<(), QueryError> {
        validate_filters(&self.filters)?;
        if let Some(limit) = self.limit
            && limit < 0
        {
            return Err(QueryError::Unsupported(format!(
                "limit({limit}): a limit below zero is not supported locally"
            )));
        }
        if let Some(projection) = &self.projection {
            for entry in projection {
                let entry = entry.trim();
                if entry.contains('(') || entry.contains(':') {
                    return Err(QueryError::Unsupported(format!(
                        "select(\"{entry}\"): relational embeds and renames are not supported locally"
                    )));
                }
            }
        }
        Ok(())
    }
}
