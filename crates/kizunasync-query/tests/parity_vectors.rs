//! The shared local-query parity vectors (Rust side).
//!
//! Loads the single fixture file `packages/core/src/query/parity-vectors.json`
//! and replays every vector through [`apply_query`]. The vectors are the
//! regression fixture of the one evaluator: they record the behaviour this
//! evaluator is expected to keep, and every runner that reads them asserts the
//! same rows and the same refusal codes.

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_query::{QueryError, QueryPlan, QueryResult, Row, apply_query};
use serde::Deserialize;
use std::path::PathBuf;

/// Same floor every runner asserts, so none of them can silently shrink.
const MINIMUM_VECTORS: usize = 60;

/// A local write or a single-row read that violates a constraint.
const LOCAL_CONSTRAINT: &str = "LOCAL_CONSTRAINT";
/// A query or write construct the local subset cannot answer.
const LOCAL_UNSUPPORTED: &str = "LOCAL_UNSUPPORTED";

#[derive(Deserialize)]
struct Vector {
    name: String,
    rows: Vec<Row>,
    plan: QueryPlan,
    expected: Vec<String>,
    #[serde(default, rename = "expectError")]
    expect_error: bool,
    #[serde(default, rename = "expectCode")]
    expect_code: Option<String>,
}

#[derive(Deserialize)]
struct VectorFile {
    vectors: Vec<Vector>,
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/src/query/parity-vectors.json")
}

/// The engine error code one query fault carries, by the same rule
/// `kizunasync_engine::EngineError::code` applies: a cardinality miss is a constraint
/// fault, every other refusal names a construct the local subset cannot answer.
/// This crate does not depend on the engine, so the rule is restated here and the
/// vectors pin the two sides to the same answer.
fn code_of(error: &QueryError) -> &'static str {
    match error {
        QueryError::SingleCardinality(_) | QueryError::MaybeSingleCardinality(_) => {
            LOCAL_CONSTRAINT
        }
        _ => LOCAL_UNSUPPORTED,
    }
}

fn result_ids(result: &QueryResult) -> Vec<String> {
    let rows: Vec<&Row> = match result {
        QueryResult::Many(rows) => rows.iter().collect(),
        QueryResult::One(row) => vec![row],
        QueryResult::Maybe(row) => row.iter().collect(),
        QueryResult::Counted { rows, .. } => return result_ids(rows),
    };
    rows.iter()
        .map(|row| {
            row.get("id")
                .and_then(|id| id.as_str())
                .unwrap_or("<missing id>")
                .to_string()
        })
        .collect()
}

#[test]
fn the_evaluator_answers_every_parity_vector() {
    let path = vectors_path();
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let file: VectorFile =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    assert!(
        file.vectors.len() >= MINIMUM_VECTORS,
        "the parity fixture shrank below {MINIMUM_VECTORS} vectors (got {})",
        file.vectors.len()
    );

    let mut failures: Vec<String> = Vec::new();
    for vector in &file.vectors {
        if vector.expect_error && vector.expect_code.is_none() {
            failures.push(format!("{}: expectError without expectCode", vector.name));
        }

        match apply_query(vector.rows.clone(), &vector.plan) {
            Ok(result) => {
                if vector.expect_error {
                    failures.push(format!(
                        "{}: expected a refusal, got {:?}",
                        vector.name,
                        result_ids(&result)
                    ));
                    continue;
                }

                let ids = result_ids(&result);
                if ids != vector.expected {
                    failures.push(format!(
                        "{}: expected {:?}, got {ids:?}",
                        vector.name, vector.expected
                    ));
                }
            }
            Err(error) => {
                if !vector.expect_error {
                    failures.push(format!("{}: unexpected error {error}", vector.name));
                    continue;
                }
                let code = code_of(&error);
                if let Some(expected) = &vector.expect_code
                    && expected != code
                {
                    failures.push(format!(
                        "{}: expected code {expected}, got {code} ({error})",
                        vector.name
                    ));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity vector(s) diverged from the recorded behaviour:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
