//! Boundary parsing for whatever a transport hands back.
//!
//! Two transports produce rows: the direct Postgres applier (simple query
//! protocol: every value arrives as text or NULL) and the Management API
//! (native JSON: numbers and booleans arrive typed). Both are normalized to a
//! `Row` of `serde_json::Value`, so the readers below accept either encoding of
//! the same value rather than a transport-specific one.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::error::{Error, Result};

/// One result row, keyed by column name.
pub type Row = BTreeMap<String, Value>;

/// A required text column.
///
/// # Errors
/// Returns [`Error::Boundary`] when the column is absent or not a string.
pub fn require_string(row: &Row, column: &str) -> Result<String> {
    match row.get(column) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(Error::Boundary(format!(
            "row is missing a \"{column}\" string"
        ))),
    }
}

/// A nullable text column: absent and NULL both read as `None`, anything else
/// is a shape we did not ask for.
///
/// # Errors
/// Returns [`Error::Boundary`] when the column carries a non-text value.
pub fn optional_string(row: &Row, column: &str) -> Result<Option<String>> {
    match row.get(column) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(Error::Boundary(format!(
            "row carries a non-text \"{column}\""
        ))),
    }
}

/// A required count. Postgres over JSON can hand back a bigint count as a
/// string, and the simple query protocol always does: a numeric string is
/// still a count.
///
/// # Errors
/// Returns [`Error::Boundary`] when the column is absent or not numeric.
pub fn require_number(row: &Row, column: &str) -> Result<i64> {
    match row.get(column) {
        Some(Value::Number(value)) => value
            .as_i64()
            .ok_or_else(|| Error::Boundary(format!("row is missing a \"{column}\" count"))),
        Some(Value::String(value)) => value
            .trim()
            .parse::<i64>()
            .map_err(|_| Error::Boundary(format!("row is missing a \"{column}\" count"))),
        _ => Err(Error::Boundary(format!(
            "row is missing a \"{column}\" count"
        ))),
    }
}

/// A nullable count: absent and NULL both read as `None`.
///
/// # Errors
/// Returns [`Error::Boundary`] when the column carries a non-numeric value.
pub fn optional_number(row: &Row, column: &str) -> Result<Option<i64>> {
    match row.get(column) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => require_number(row, column).map(Some),
    }
}

/// A boolean column. The simple query protocol spells booleans `t`/`f`; the
/// Management API spells them as JSON booleans.
///
/// # Errors
/// Returns [`Error::Boundary`] when the value is neither spelling.
pub fn require_bool(row: &Row, column: &str) -> Result<bool> {
    match row.get(column) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(Value::String(value)) => match value.as_str() {
            "t" | "true" | "TRUE" => Ok(true),
            "f" | "false" | "FALSE" => Ok(false),
            _ => Err(boundary_bool(column, value)),
        },
        other => Err(boundary_bool(column, &format!("{other:?}"))),
    }
}

/// A nullable boolean column: absent and NULL both read as `None`, anything
/// that is not a boolean is the shape we did not ask for. The caller decides
/// what an absent value means; a value we cannot read is never one of them.
///
/// # Errors
/// Returns [`Error::Boundary`] when the column carries a non-boolean value.
pub fn optional_bool(row: &Row, column: &str) -> Result<Option<bool>> {
    match row.get(column) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => require_bool(row, column).map(Some),
    }
}

fn boundary_bool(column: &str, value: &str) -> Error {
    Error::Boundary(format!("row carries a non-boolean \"{column}\": {value}"))
}

/// A nullable `text[]` column: absent and NULL both read as `None`. The
/// Management API hands the array over as JSON; the simple query protocol as
/// Postgres's array literal (`{id}`, `{hall,seat}`, `{"a b",c}`).
///
/// # Errors
/// Returns [`Error::Boundary`] when the value is neither encoding of an array
/// of non-null strings.
pub fn optional_string_array(row: &Row, column: &str) -> Result<Option<Vec<String>>> {
    let boundary = || Error::Boundary(format!("row carries a non-text-array \"{column}\""));
    match row.get(column) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(ToOwned::to_owned))
            .collect::<Option<Vec<String>>>()
            .map(Some)
            .ok_or_else(boundary),
        Some(Value::String(literal)) => parse_text_array(literal).map(Some).ok_or_else(boundary),
        Some(_) => Err(boundary()),
    }
}

/// The elements of a one-dimensional Postgres array literal, `None` for
/// anything else, a NULL element included. A quoted element keeps every
/// character its backslashes escape.
fn parse_text_array(literal: &str) -> Option<Vec<String>> {
    let inner = literal.strip_prefix('{')?.strip_suffix('}')?;
    let mut elements = Vec::new();
    if inner.is_empty() {
        return Some(elements);
    }

    let mut chars = inner.chars().peekable();
    loop {
        let element = if chars.peek() == Some(&'"') {
            chars.next();
            let mut quoted = String::new();
            loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => quoted.push(chars.next()?),
                    other => quoted.push(other),
                }
            }
            quoted
        } else {
            let mut bare = String::new();
            while let Some(&next) = chars.peek() {
                if next == ',' {
                    break;
                }
                if matches!(next, '"' | '{' | '}' | '\\') {
                    return None;
                }
                bare.push(next);
                chars.next();
            }
            if bare.is_empty() || bare.eq_ignore_ascii_case("null") {
                return None;
            }
            bare
        };
        elements.push(element);
        match chars.next() {
            None => return Some(elements),
            Some(',') => {}
            Some(_) => return None,
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, Value)]) -> Row {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect()
    }

    #[test]
    fn require_string_rejects_a_missing_or_mistyped_column() {
        let value = row(&[("a", Value::String("x".into())), ("b", Value::from(1))]);

        assert_eq!(require_string(&value, "a").unwrap(), "x");
        assert!(require_string(&value, "b").is_err());
        assert!(require_string(&value, "missing").is_err());
    }

    #[test]
    fn optional_string_reads_absent_and_null_alike() {
        let value = row(&[("a", Value::Null)]);

        assert_eq!(optional_string(&value, "a").unwrap(), None);
        assert_eq!(optional_string(&value, "missing").unwrap(), None);
    }

    #[test]
    fn require_number_accepts_both_transport_encodings() {
        let json = row(&[("n", Value::from(7))]);
        let text = row(&[("n", Value::String(" 7 ".into()))]);

        assert_eq!(require_number(&json, "n").unwrap(), 7);
        assert_eq!(require_number(&text, "n").unwrap(), 7);
        assert!(require_number(&row(&[("n", Value::String("x".into()))]), "n").is_err());
    }

    #[test]
    fn require_bool_accepts_postgres_text_and_json_booleans() {
        assert!(require_bool(&row(&[("b", Value::Bool(true))]), "b").unwrap());
        assert!(require_bool(&row(&[("b", Value::String("t".into()))]), "b").unwrap());
        assert!(!require_bool(&row(&[("b", Value::String("f".into()))]), "b").unwrap());
        assert!(require_bool(&row(&[("b", Value::String("maybe".into()))]), "b").is_err());
    }

    #[test]
    fn a_text_array_reads_from_either_transport() {
        let json = row(&[("k", serde_json::json!(["hall", "seat"]))]);
        let literal = row(&[("k", Value::String("{hall,seat}".into()))]);
        let single = row(&[("k", Value::String("{id}".into()))]);

        assert_eq!(
            optional_string_array(&json, "k").unwrap(),
            Some(vec!["hall".to_owned(), "seat".to_owned()])
        );
        assert_eq!(
            optional_string_array(&literal, "k").unwrap(),
            Some(vec!["hall".to_owned(), "seat".to_owned()])
        );
        assert_eq!(
            optional_string_array(&single, "k").unwrap(),
            Some(vec!["id".to_owned()])
        );
        assert_eq!(optional_string_array(&row(&[]), "k").unwrap(), None);
        assert_eq!(
            optional_string_array(&row(&[("k", Value::Null)]), "k").unwrap(),
            None
        );
    }

    /// Postgres quotes an element holding a separator, a quote, a backslash,
    /// or white space, and escapes the quote and the backslash inside it.
    #[test]
    fn a_quoted_array_element_keeps_what_its_escapes_carry() {
        let literal = row(&[(
            "k",
            Value::String(r#"{"a b","c,d","say \"hi\"","back\\slash",plain,""}"#.into()),
        )]);

        assert_eq!(
            optional_string_array(&literal, "k").unwrap(),
            Some(vec![
                "a b".to_owned(),
                "c,d".to_owned(),
                "say \"hi\"".to_owned(),
                "back\\slash".to_owned(),
                "plain".to_owned(),
                String::new(),
            ])
        );
    }

    #[test]
    fn anything_but_an_array_of_strings_is_a_boundary_failure() {
        for value in [
            Value::String("id".into()),
            Value::String("{a,NULL}".into()),
            Value::String("{a,,b}".into()),
            Value::String("{\"open}".into()),
            Value::String("{{a},{b}}".into()),
            serde_json::json!([1, 2]),
            serde_json::json!([null]),
            Value::from(1),
        ] {
            let error = optional_string_array(&row(&[("k", value.clone())]), "k").unwrap_err();

            assert!(matches!(error, Error::Boundary(_)), "{value:?}");
        }
    }

    #[test]
    fn optional_bool_reads_absent_and_null_alike_and_refuses_a_non_boolean() {
        assert_eq!(optional_bool(&row(&[]), "b").unwrap(), None);
        assert_eq!(
            optional_bool(&row(&[("b", Value::Null)]), "b").unwrap(),
            None
        );
        assert_eq!(
            optional_bool(&row(&[("b", Value::Bool(true))]), "b").unwrap(),
            Some(true)
        );
        assert!(optional_bool(&row(&[("b", Value::String("maybe".into()))]), "b").is_err());
    }
}
