//! D-field-transforms field transforms: increment, arrayUnion, arrayRemove.

use kizunasync_protocol::ColumnValues;
use serde_json::{Map, Value};
use thiserror::Error;

const I32_ABS: i128 = 2_147_483_648;

/// Why a field transform could not apply.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum TransformError {
    /// The transform's operand does not fit the column's value shape.
    #[error("{0}")]
    Constraint(String),
}

fn int_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => Some("0".to_owned()),
        Value::Number(number) => number
            .as_i64()
            .map(|n| n.to_string())
            .or_else(|| number.as_u64().map(|n| n.to_string())),
        Value::String(text) if looks_like_int(text) => Some(text.clone()),
        _ => None,
    }
}

fn looks_like_int(text: &str) -> bool {
    let (sign, rest) = text.strip_prefix('-').map_or((false, text), |r| (true, r));

    if rest.is_empty() {
        return false;
    }
    if rest == "0" {
        return !sign;
    }

    rest.as_bytes()[0] != b'0' && rest.bytes().all(|b| b.is_ascii_digit())
}

fn encode_int(n: i128) -> Value {
    match i64::try_from(n) {
        Ok(n) if i128::from(n.unsigned_abs()) < I32_ABS => Value::Number(n.into()),
        _ => Value::String(n.to_string()),
    }
}

fn split_sign(text: &str) -> (bool, &str) {
    text.strip_prefix('-')
        .map_or((false, text), |digits| (true, digits))
}

fn cmp_digits(left: &str, right: &str) -> std::cmp::Ordering {
    let left = left.trim_start_matches('0');
    let right = right.trim_start_matches('0');
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn add_digits(left: &str, right: &str) -> String {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut i = left.len();
    let mut j = right.len();
    let mut carry = 0u8;
    let mut digits = Vec::with_capacity(left.len().max(right.len()) + 1);
    while i > 0 || j > 0 || carry > 0 {
        let mut sum = carry;
        if i > 0 {
            i -= 1;
            sum += left[i] - b'0';
        }
        if j > 0 {
            j -= 1;
            sum += right[j] - b'0';
        }
        digits.push(sum % 10);
        carry = sum / 10;
    }
    let mut out = String::with_capacity(digits.len());
    for digit in digits.into_iter().rev() {
        out.push(char::from(b'0' + digit));
    }
    out
}

fn sub_digits(left: &str, right: &str) -> String {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut i = left.len();
    let mut j = right.len();
    let mut borrow = 0i16;
    let mut digits = Vec::with_capacity(left.len());
    while i > 0 {
        i -= 1;
        let mut digit = i16::from(left[i] - b'0') - borrow;
        if j > 0 {
            j -= 1;
            digit -= i16::from(right[j] - b'0');
        }
        if digit < 0 {
            digit += 10;
            borrow = 1;
        } else {
            borrow = 0;
        }
        digits.push(u8::try_from(digit).unwrap_or(0));
    }
    while digits.last() == Some(&0) {
        digits.pop();
    }
    if digits.is_empty() {
        return "0".to_owned();
    }
    let mut out = String::with_capacity(digits.len());
    for digit in digits.into_iter().rev() {
        out.push(char::from(b'0' + digit));
    }
    out
}

fn add_int_texts(left: &str, right: &str) -> String {
    let (neg_left, left_digits) = split_sign(left);
    let (neg_right, right_digits) = split_sign(right);
    if neg_left == neg_right {
        let sum = add_digits(left_digits, right_digits);
        if neg_left && sum != "0" {
            format!("-{sum}")
        } else {
            sum
        }
    } else {
        match cmp_digits(left_digits, right_digits) {
            std::cmp::Ordering::Equal => "0".to_owned(),
            std::cmp::Ordering::Greater => {
                let diff = sub_digits(left_digits, right_digits);
                if neg_left && diff != "0" {
                    format!("-{diff}")
                } else {
                    diff
                }
            }
            std::cmp::Ordering::Less => {
                let diff = sub_digits(right_digits, left_digits);
                if neg_right && diff != "0" {
                    format!("-{diff}")
                } else {
                    diff
                }
            }
        }
    }
}

fn cell_key(value: &Value) -> String {
    value.to_string()
}

/// Apply `transforms` onto `row` (optimistic apply + D-outbox-rebase replay).
///
/// An increment against a cell that is not an integer leaves that cell
/// unchanged: the write still queues, and the server answers `CONSTRAINT`
/// (`increment/006-non-numeric-constraint`). A malformed operand (`by` missing
/// or not a signed integer, a non-object spec, an unknown op) is still
/// [`TransformError::Constraint`].
///
/// # Errors
///
/// [`TransformError::Constraint`] when a transform's operand does not fit the
/// column's current value, except increment-on-non-integer which skips the
/// cell.
pub fn apply_transforms(
    row: &ColumnValues,
    transforms: &Option<Map<String, Value>>,
) -> Result<ColumnValues, TransformError> {
    let Some(transforms) = transforms else {
        return Ok(row.clone());
    };
    if transforms.is_empty() {
        return Ok(row.clone());
    }

    let mut next = row.clone();
    for (column, spec) in transforms {
        let obj = spec.as_object().ok_or_else(|| {
            TransformError::Constraint(format!("transform on \"{column}\" is not an object"))
        })?;
        let op = obj.get("op").and_then(Value::as_str).ok_or_else(|| {
            TransformError::Constraint(format!("transform on \"{column}\" is missing op"))
        })?;
        match op {
            "increment" => apply_increment(&mut next, column, obj)?,
            "arrayUnion" => apply_array_union(&mut next, column, obj)?,
            "arrayRemove" => apply_array_remove(&mut next, column, obj)?,
            other => {
                return Err(TransformError::Constraint(format!(
                    "unknown transform op \"{other}\" on \"{column}\""
                )));
            }
        }
    }
    Ok(next)
}

fn apply_increment(
    next: &mut ColumnValues,
    column: &str,
    obj: &Map<String, Value>,
) -> Result<(), TransformError> {
    let by = obj.get("by").ok_or_else(|| {
        TransformError::Constraint(format!("increment() on \"{column}\" is missing by"))
    })?;
    let Some(delta_text) = int_text(by) else {
        return Err(TransformError::Constraint(format!(
            "increment() on \"{column}\" requires a signed integer"
        )));
    };
    let base_text = match next.get(column) {
        None | Some(Value::Null) => "0".to_owned(),
        Some(current) => match int_text(current) {
            Some(text) => text,
            // A non-integer cell is left alone and the write still queues, because
            // the server is what answers `CONSTRAINT` (`increment/006`).
            None => return Ok(()),
        },
    };
    let sum = match (base_text.parse::<i128>(), delta_text.parse::<i128>()) {
        (Ok(base), Ok(delta)) => match base.checked_add(delta) {
            Some(n) => encode_int(n),
            None => Value::String(add_int_texts(&base_text, &delta_text)),
        },
        _ => Value::String(add_int_texts(&base_text, &delta_text)),
    };
    next.insert(column.to_string(), sum);
    Ok(())
}

fn apply_array_union(
    next: &mut ColumnValues,
    column: &str,
    obj: &Map<String, Value>,
) -> Result<(), TransformError> {
    let values = obj.get("values").and_then(Value::as_array).ok_or_else(|| {
        TransformError::Constraint(format!(
            "arrayUnion() on \"{column}\" requires a values array"
        ))
    })?;
    let mut current = match next.get(column) {
        Some(Value::Array(items)) => items.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => {
            return Err(TransformError::Constraint(format!(
                "arrayUnion() on \"{column}\" requires an array column"
            )));
        }
    };
    let mut seen: std::collections::BTreeSet<String> = current.iter().map(cell_key).collect();
    for member in values {
        let key = cell_key(member);
        if seen.insert(key) {
            current.push(member.clone());
        }
    }
    next.insert(column.to_string(), Value::Array(current));
    Ok(())
}

fn apply_array_remove(
    next: &mut ColumnValues,
    column: &str,
    obj: &Map<String, Value>,
) -> Result<(), TransformError> {
    let values = obj.get("values").and_then(Value::as_array).ok_or_else(|| {
        TransformError::Constraint(format!(
            "arrayRemove() on \"{column}\" requires a values array"
        ))
    })?;
    let remove: std::collections::BTreeSet<String> = values.iter().map(cell_key).collect();
    let current = match next.get(column) {
        Some(Value::Array(items)) => items.clone(),
        None | Some(Value::Null) => Vec::new(),
        Some(_) => {
            return Err(TransformError::Constraint(format!(
                "arrayRemove() on \"{column}\" requires an array column"
            )));
        }
    };
    let kept: Vec<Value> = current
        .into_iter()
        .filter(|member| !remove.contains(&cell_key(member)))
        .collect();
    next.insert(column.to_string(), Value::Array(kept));
    Ok(())
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{TransformError, apply_transforms};
    use serde_json::{Map, json};

    #[test]
    fn increment_adds_to_missing_and_existing() {
        let mut row = Map::new();
        row.insert("likes".to_string(), json!(1));
        let mut transforms = Map::new();
        transforms.insert("likes".to_string(), json!({ "op": "increment", "by": 2 }));
        let next = apply_transforms(&row, &Some(transforms)).unwrap();
        assert_eq!(next.get("likes"), Some(&json!(3)));
    }

    #[test]
    fn an_array_remove_after_a_union_drops_only_the_named_value() {
        let row = Map::new();
        let mut union = Map::new();
        union.insert(
            "labels".to_string(),
            json!({ "op": "arrayUnion", "values": ["urgent", "home"] }),
        );
        let with_union = apply_transforms(&row, &Some(union)).unwrap();
        let mut remove = Map::new();
        remove.insert(
            "labels".to_string(),
            json!({ "op": "arrayRemove", "values": ["urgent"] }),
        );
        let next = apply_transforms(&with_union, &Some(remove)).unwrap();
        assert_eq!(next.get("labels"), Some(&json!(["home"])));
    }

    #[test]
    fn increment_on_a_non_integer_cell_is_left_untouched() {
        let mut row = Map::new();
        row.insert("title".to_string(), json!("start"));
        let mut transforms = Map::new();
        transforms.insert("title".to_string(), json!({ "op": "increment", "by": 1 }));
        let next = apply_transforms(&row, &Some(transforms)).unwrap();
        assert_eq!(next.get("title"), Some(&json!("start")));
    }

    #[test]
    fn increment_past_i64_max_encodes_the_decimal_string() {
        let mut row = Map::new();
        row.insert("likes".to_string(), json!("9223372036854775807"));
        let mut transforms = Map::new();
        transforms.insert("likes".to_string(), json!({ "op": "increment", "by": 1 }));
        let next = apply_transforms(&row, &Some(transforms)).unwrap();
        assert_eq!(next.get("likes"), Some(&json!("9223372036854775808")));
    }

    #[test]
    fn increment_past_i128_still_applies_as_a_decimal_string() {
        let mut row = Map::new();
        row.insert(
            "likes".to_string(),
            json!("1000000000000000000000000000000000000000"),
        );
        let mut transforms = Map::new();
        transforms.insert("likes".to_string(), json!({ "op": "increment", "by": 1 }));
        let next = apply_transforms(&row, &Some(transforms)).unwrap();
        assert_eq!(
            next.get("likes"),
            Some(&json!("1000000000000000000000000000000000000001"))
        );
    }

    #[test]
    fn array_union_on_a_non_array_cell_is_constraint() {
        let mut row = Map::new();
        row.insert("labels".to_string(), json!("urgent"));
        let mut transforms = Map::new();
        transforms.insert(
            "labels".to_string(),
            json!({ "op": "arrayUnion", "values": ["home"] }),
        );
        let error = apply_transforms(&row, &Some(transforms)).unwrap_err();
        assert!(matches!(error, TransformError::Constraint(_)), "{error}");
    }
}
