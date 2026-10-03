//! A row's key text, the `pk` the engine stores, queues and pushes (D-row-key).
//! The SQL pack renders the same text with `kizunasync._pk_text`, and
//! `packages/protocol/vectors/row-key-vectors.json` pins both byte for byte.

use kizunasync_protocol::ColumnValues;
use kizunasync_query::Filter;
use serde_json::Value;

/// The column a table is keyed by when its config names no key.
pub(crate) const DEFAULT_KEY_COLUMN: &str = "id";

/// Whether an insert under `key` takes a minted uuid as its pk: the table is
/// keyed by `id` alone and the row names no `id`. A present `id`, null
/// included, is the app's own key.
pub(crate) fn mints_key(key: &[String], row: &ColumnValues) -> bool {
    matches!(key, [column] if column == DEFAULT_KEY_COLUMN) && !row.contains_key(DEFAULT_KEY_COLUMN)
}

/// Lowercase every key column of `row` holding a string in the uuid grammar,
/// 8-4-4-4-12 hex digits with hyphens in any case. The server renders a uuid
/// key in lowercase and refuses a pk that spells one otherwise, so the row the
/// device stores and pushes carries the form the server keeps.
pub(crate) fn lowercase_uuid_keys(key: &[String], row: &mut ColumnValues) {
    for column in key {
        if let Some(Value::String(text)) = row.get_mut(column)
            && is_uuid_text(text)
        {
            text.make_ascii_lowercase();
        }
    }
}

/// `pk` with every uuid-shaped key component lowercased, the form the row
/// is stored and pushed under. A composite pk that reads as a JSON array of
/// as many strings as `key` has columns is spelled again in the canonical
/// text; any other composite text is kept as it came, for the key check to
/// judge.
pub(crate) fn lowercase_uuid_pk(key: &[String], pk: &str) -> String {
    if key.len() < 2 {
        return lowercase_uuid_text(pk);
    }

    match serde_json::from_str::<Vec<String>>(pk) {
        Ok(components) if components.len() == key.len() => {
            let lowered: Vec<String> = components
                .iter()
                .map(|component| lowercase_uuid_text(component))
                .collect();
            jsonb_array_text(&lowered)
        }
        Ok(_) | Err(_) => pk.to_string(),
    }
}

/// `text` lowercased when it is in the uuid grammar, else unchanged.
pub(crate) fn lowercase_uuid_text(text: &str) -> String {
    if is_uuid_text(text) {
        text.to_ascii_lowercase()
    } else {
        text.to_string()
    }
}

/// `filters` with every uuid-shaped string operand of an `eq`, `neq` or `in`
/// on a key column lowercased, at any depth, so a filter that spells a uuid
/// key in uppercase names the row stored under the lowercase form. Every other
/// filter, and every operand on a column outside the key, is kept as written.
pub(crate) fn lowercase_uuid_key_operands(key: &[String], filters: &[Filter]) -> Vec<Filter> {
    filters
        .iter()
        .map(|filter| lowercase_uuid_key_operand(key, filter))
        .collect()
}

fn lowercase_uuid_key_operand(key: &[String], filter: &Filter) -> Filter {
    let is_key = |column: &str| key.iter().any(|named| named == column);
    match filter {
        Filter::Eq { column, value } if is_key(column) => Filter::Eq {
            column: column.clone(),
            value: lowercase_uuid_value(value),
        },
        Filter::Neq { column, value } if is_key(column) => Filter::Neq {
            column: column.clone(),
            value: lowercase_uuid_value(value),
        },
        Filter::In { column, values } if is_key(column) => Filter::In {
            column: column.clone(),
            values: values.iter().map(lowercase_uuid_value).collect(),
        },
        Filter::And { filters } => Filter::And {
            filters: lowercase_uuid_key_operands(key, filters),
        },
        Filter::Or { filters } => Filter::Or {
            filters: lowercase_uuid_key_operands(key, filters),
        },
        Filter::Not { filter } => Filter::Not {
            filter: Box::new(lowercase_uuid_key_operand(key, filter)),
        },
        Filter::Eq { .. }
        | Filter::Neq { .. }
        | Filter::In { .. }
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
        | Filter::Search { .. }
        | Filter::TextSearch { .. } => filter.clone(),
    }
}

/// A string operand lowercased when it is in the uuid grammar; any other
/// operand as it is.
fn lowercase_uuid_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(lowercase_uuid_text(text)),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            value.clone()
        }
    }
}

/// Whether `text` is 8-4-4-4-12 hex digits joined by hyphens.
fn is_uuid_text(text: &str) -> bool {
    const HYPHENS: [usize; 4] = [8, 13, 18, 23];
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| {
            if HYPHENS.contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// The pk `row` spells under `key`: the component text of a lone key column,
/// or the JSON array of the component texts of several, in key order.
///
/// # Errors
///
/// The key columns that spell no component, in key order: absent, null, or
/// neither a string nor an integer. A lone key column holding the empty string
/// is one of them, since a pk is never empty on the wire. An empty `key` names
/// no column.
pub(crate) fn pk_text<'k>(key: &'k [String], row: &ColumnValues) -> Result<String, Vec<&'k str>> {
    let mut components = Vec::with_capacity(key.len());
    let mut unspelled = Vec::new();
    for column in key {
        match row.get(column).and_then(component_text) {
            Some(text) => components.push(text),
            None => unspelled.push(column.as_str()),
        }
    }
    if !unspelled.is_empty() {
        return Err(unspelled);
    }

    match components.as_slice() {
        [] => Err(unspelled),
        [only] if only.is_empty() => Err(key.iter().map(String::as_str).collect()),
        [only] => Ok(only.clone()),
        several => Ok(jsonb_array_text(several)),
    }
}

/// A key column's text as Postgres `to_jsonb(row) ->> column` renders it: a
/// string as it is, an integer as its plain decimal.
fn component_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) if number.is_i64() || number.is_u64() => Some(number.to_string()),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            None
        }
    }
}

/// The largest integer magnitude an f64 holds apart from its neighbours,
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The pks the operands of a key conjunct name on a lone key column, or `None`
/// when one of them bounds nothing and the read has to take the full scan.
///
/// A string names the row keyed by that text and an integer the row keyed by
/// its decimal. A null, a boolean, an array or an object equals no key column,
/// which holds a string or an integer, so it names no row. Any other number (a
/// float, or an integer beyond [`MAX_SAFE_INTEGER`]) can equal an integer with
/// another decimal under the evaluator's f64 comparison.
pub(crate) fn operand_pks(operands: &[&Value]) -> Option<Vec<String>> {
    let mut pks = Vec::with_capacity(operands.len());
    for operand in operands {
        match operand {
            Value::String(text) => pks.push(text.clone()),
            Value::Number(number) => {
                let magnitude = number
                    .as_i64()
                    .map(i64::unsigned_abs)
                    .or_else(|| number.as_u64())?;
                if magnitude > MAX_SAFE_INTEGER {
                    return None;
                }
                pks.push(number.to_string());
            }
            Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_) => {}
        }
    }
    Some(pks)
}

/// Postgres prints a jsonb array as its elements joined by a comma and a
/// space, and escapes a string exactly where `serde_json` does: `"`, `\`, and
/// U+0000 to U+001F, with the short escapes where they exist and lowercase
/// `\u00XX` otherwise.
fn jsonb_array_text(components: &[String]) -> String {
    let quoted: Vec<String> = components
        .iter()
        .map(|component| Value::String(component.clone()).to_string())
        .collect();
    format!("[{}]", quoted.join(", "))
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::{
        lowercase_uuid_key_operands, lowercase_uuid_keys, lowercase_uuid_pk, mints_key,
        operand_pks, pk_text,
    };
    use kizunasync_query::Filter;
    use serde::Deserialize;
    use serde_json::{Map, Value, json};
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct Fixture {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        key_columns: Vec<String>,
        row: Map<String, Value>,
        pk: String,
    }

    fn fixture() -> Fixture {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/vectors/row-key-vectors.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
    }

    fn key(columns: &[&str]) -> Vec<String> {
        columns.iter().map(|column| (*column).to_string()).collect()
    }

    fn row(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    /// The SQL pack replays the same file against `_pk_text`, so a pk the
    /// device and the server spell differently fails one of the two suites.
    #[test]
    fn every_shared_vector_renders_byte_for_byte() {
        let vectors = fixture().vectors;
        assert!(!vectors.is_empty());

        for vector in vectors {
            assert_eq!(
                pk_text(&vector.key_columns, &vector.row).as_deref(),
                Ok(vector.pk.as_str()),
                "{}",
                vector.name
            );
        }
    }

    /// The vectors the design names stay in the shared file: the pair of
    /// integers, and a component carrying a quote, a backslash, a newline,
    /// U+0001 and non-ASCII text.
    #[test]
    fn the_shared_vectors_keep_the_cases_the_design_names() {
        let vectors = fixture().vectors;
        let pks: Vec<&str> = vectors.iter().map(|vector| vector.pk.as_str()).collect();
        assert!(pks.contains(&r#"["1", "3456"]"#), "{pks:?}");

        let components: Vec<&str> = vectors
            .iter()
            .filter(|vector| vector.key_columns.len() > 1)
            .flat_map(|vector| vector.row.values().filter_map(Value::as_str))
            .collect();
        for needle in ["\"", "\\", "\n", "\u{1}", "絆"] {
            assert!(
                components
                    .iter()
                    .any(|component| component.contains(needle)),
                "no composite component carries {needle:?}"
            );
        }
    }

    /// The literal texts, so a regression reads as the bytes that changed
    /// rather than as a vector name.
    #[test]
    fn a_composite_key_is_the_postgres_jsonb_array_text() {
        assert_eq!(
            pk_text(
                &key(&["hall", "seat"]),
                &row(&json!({"hall": 1, "seat": 3456}))
            )
            .as_deref(),
            Ok(r#"["1", "3456"]"#)
        );
        assert_eq!(
            pk_text(
                &key(&["label", "n"]),
                &row(&json!({"label": "\"q\" \\ \n \u{1} café 絆", "n": -2}))
            )
            .as_deref(),
            Ok(r#"["\"q\" \\ \n \u0001 café 絆", "-2"]"#)
        );
        assert_eq!(
            pk_text(&key(&["a", "b"]), &row(&json!({"a": "", "b": u64::MAX}))).as_deref(),
            Ok(r#"["", "18446744073709551615"]"#)
        );
    }

    /// A pk the engine is handed gets the same lowercasing, component by
    /// component. A composite pk is read as its JSON array of strings and
    /// spelled again in the canonical text; a pk that is not such an array, or
    /// names another number of columns, is kept as it came.
    #[test]
    fn a_uuid_shaped_pk_component_is_lowercased() {
        let upper = "5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F";
        let lower = "5f0c1c2e-8f3a-4b6d-9c1e-2a7b3c4d5e6f";
        assert_eq!(lowercase_uuid_pk(&key(&["id"]), upper), lower);
        assert_eq!(
            lowercase_uuid_pk(&key(&["slug"]), "Mixed-Case"),
            "Mixed-Case"
        );
        assert_eq!(
            lowercase_uuid_pk(
                &key(&["tenant", "slug"]),
                &format!(r#"["{upper}", "Mixed-Case"]"#)
            ),
            format!(r#"["{lower}", "Mixed-Case"]"#)
        );
        assert_eq!(
            lowercase_uuid_pk(&key(&["a", "b"]), r#"[ "1","2" ]"#),
            r#"["1", "2"]"#
        );
        for kept in [r#"["1", "2", "3"]"#, "not json", "[1, 2]", upper] {
            assert_eq!(lowercase_uuid_pk(&key(&["a", "b"]), kept), kept, "{kept}");
        }
    }

    /// Only an `eq`, `neq` or `in` operand on a key column is lowercased, at
    /// any depth; a range, a pattern, and a column outside the key compare
    /// what the caller wrote.
    #[test]
    fn only_an_equality_operand_on_a_key_column_is_lowercased() {
        let upper = "5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F";
        let lower = "5f0c1c2e-8f3a-4b6d-9c1e-2a7b3c4d5e6f";
        let filters: Vec<Filter> = serde_json::from_value(json!([
            {"kind": "eq", "column": "id", "value": upper},
            {"kind": "neq", "column": "note", "value": upper},
            {"kind": "gt", "column": "id", "value": upper},
            {"kind": "like", "column": "id", "pattern": upper},
            {"kind": "and", "filters": [{"kind": "in", "column": "id", "values": [upper, 7, null]}]},
        ]))
        .unwrap();
        let expected: Vec<Filter> = serde_json::from_value(json!([
            {"kind": "eq", "column": "id", "value": lower},
            {"kind": "neq", "column": "note", "value": upper},
            {"kind": "gt", "column": "id", "value": upper},
            {"kind": "like", "column": "id", "pattern": upper},
            {"kind": "and", "filters": [{"kind": "in", "column": "id", "values": [lower, 7, null]}]},
        ]))
        .unwrap();
        assert_eq!(
            lowercase_uuid_key_operands(&key(&["id"]), &filters),
            expected
        );
    }

    /// The server keeps a uuid in its lowercase form, so a key column holding
    /// a string in the uuid grammar, in any case, is lowercased before the pk
    /// is derived from it. Every other value, and every non-key column, stays
    /// as written.
    #[test]
    fn a_uuid_shaped_key_value_is_lowercased() {
        let mut written = row(&json!({
            "tenant": "5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F",
            "slug": "Mixed-Case",
            "owner": "ABCDEF01-2345-6789-ABCD-EF0123456789",
            "n": 7,
        }));
        lowercase_uuid_keys(&key(&["tenant", "slug", "n"]), &mut written);
        assert_eq!(
            Value::Object(written.clone()),
            json!({
                "tenant": "5f0c1c2e-8f3a-4b6d-9c1e-2a7b3c4d5e6f",
                "slug": "Mixed-Case",
                "owner": "ABCDEF01-2345-6789-ABCD-EF0123456789",
                "n": 7,
            })
        );
        assert_eq!(
            pk_text(&key(&["tenant", "slug"]), &written).as_deref(),
            Ok(r#"["5f0c1c2e-8f3a-4b6d-9c1e-2a7b3c4d5e6f", "Mixed-Case"]"#)
        );

        for off_grammar in [
            "5F0C1C2E8F3A4B6D9C1E2A7B3C4D5E6F",
            "{5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F}",
            "5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6",
            "5F0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6G",
            "5F0C1C2E-8F3A4-B6D-9C1E-2A7B3C4D5E6F",
            "ÉF0C1C2E-8F3A-4B6D-9C1E-2A7B3C4D5E6F",
        ] {
            let mut kept = row(&json!({ "id": off_grammar }));
            lowercase_uuid_keys(&key(&["id"]), &mut kept);
            assert_eq!(kept["id"], json!(off_grammar), "{off_grammar}");
        }
    }

    /// One key column is its component text, never quoted or escaped.
    #[test]
    fn a_single_key_is_its_component_text() {
        assert_eq!(
            pk_text(&key(&["id"]), &row(&json!({"id": "p1", "title": "x"}))).as_deref(),
            Ok("p1")
        );
        assert_eq!(
            pk_text(&key(&["n"]), &row(&json!({"n": i64::MIN}))).as_deref(),
            Ok("-9223372036854775808")
        );
        assert_eq!(
            pk_text(&key(&["slug"]), &row(&json!({"slug": "a \"b\"\n"}))).as_deref(),
            Ok("a \"b\"\n")
        );
    }

    /// Every key column that spells no component is named, in key order: an
    /// absent one, a null, a fraction, and every other JSON type. A lone key
    /// column holding the empty string spells no pk either, since a pk is never
    /// empty on the wire.
    #[test]
    fn a_key_column_that_spells_no_component_is_named() {
        let columns = key(&["a", "b", "c", "d", "e", "f", "g"]);
        let written = row(&json!({
            "b": null,
            "c": 1.5,
            "d": true,
            "e": [1],
            "f": {"x": 1},
            "g": "fine",
        }));
        assert_eq!(
            pk_text(&columns, &written),
            Err(vec!["a", "b", "c", "d", "e", "f"])
        );

        assert_eq!(
            pk_text(&key(&["id"]), &row(&json!({"id": ""}))),
            Err(vec!["id"])
        );
        assert_eq!(pk_text(&[], &Map::new()), Err(Vec::<&str>::new()));
    }

    /// Only a table keyed by `id` alone mints, and only for a row that names no
    /// `id`: a present `id`, null included, is the app's key.
    #[test]
    fn only_an_id_key_without_an_id_mints() {
        assert!(mints_key(&key(&["id"]), &row(&json!({"title": "x"}))));
        assert!(!mints_key(&key(&["id"]), &row(&json!({"id": "p1"}))));
        assert!(!mints_key(&key(&["id"]), &row(&json!({"id": null}))));
        assert!(!mints_key(&key(&["slug"]), &row(&json!({"title": "x"}))));
        assert!(!mints_key(&key(&["id", "n"]), &row(&json!({"title": "x"}))));
    }

    /// A string names the row keyed by that text and an integer the row keyed
    /// by its decimal, up to JavaScript's safe-integer bound, where the
    /// evaluator's f64 comparison still tells two integers apart.
    #[test]
    fn a_string_or_a_safe_integer_operand_names_its_pk() {
        let operands = [
            json!("p1"),
            json!("7"),
            json!(7),
            json!(-7),
            json!(9_007_199_254_740_991_i64),
            json!(-9_007_199_254_740_991_i64),
        ];
        assert_eq!(
            operand_pks(&operands.iter().collect::<Vec<_>>()),
            Some(vec![
                "p1".to_string(),
                "7".to_string(),
                "7".to_string(),
                "-7".to_string(),
                "9007199254740991".to_string(),
                "-9007199254740991".to_string(),
            ])
        );
        assert_eq!(operand_pks(&[]), Some(Vec::new()));
    }

    /// A key column holds a string or an integer, so a null, a boolean, an
    /// array or an object equals no key and names no row.
    #[test]
    fn an_operand_no_key_equals_names_no_row() {
        let operands = [
            Value::Null,
            json!(true),
            json!([1]),
            json!({"a": 1}),
            json!("p2"),
        ];
        assert_eq!(
            operand_pks(&operands.iter().collect::<Vec<_>>()),
            Some(vec!["p2".to_string()])
        );
    }

    /// The evaluator compares numbers as f64, so a fraction-free float, or an
    /// integer at 2^53 or beyond, can equal an integer with another decimal.
    /// Such an operand bounds nothing, and the read takes the full scan.
    #[test]
    fn any_other_number_leaves_the_read_unbounded() {
        for number in [
            json!(7.0),
            json!(1.5),
            json!(9_007_199_254_740_992_i64),
            json!(-9_007_199_254_740_992_i64),
            json!(u64::MAX),
        ] {
            assert_eq!(operand_pks(&[&json!("p1"), &number]), None, "{number}");
        }
    }
}
