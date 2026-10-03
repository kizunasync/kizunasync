//! Deterministic, marker-scoped write churn.
//!
//! `kizunasync mock churn` feeds a steady stream of writes against already-seeded
//! rows so fencing and load-testing harnesses have something to converge
//! against. Determinism is the same hard requirement as [`crate::mock_seed`]:
//! the same spec always produces the byte-identical statement list, so a plan
//! is fully reproducible and reviewable before it ever touches a database.
//!
//! Every statement addresses exactly one row, selected by a subquery scoped to
//! [`crate::mock_seed::MOCK_MARKER`]: churn can only ever touch
//! rows `mock seed` created, never real data. Cleanup stays
//! `mock seed --clean`: churn edits marker rows in place and the marker prefix
//! (which leads every title) always survives a retitle.

use crate::mock_seed::{MOCK_MARKER, Rng};

/// What a churn run should produce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChurnSpec {
    /// Number of write statements to generate.
    pub iterations: u64,
    /// PRNG seed; the same seed reproduces the same plan byte for byte.
    pub seed: u64,
    /// Target table (unqualified name); always resolved to `public.<table>`.
    pub table: String,
}

/// What one statement does to its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChurnKind {
    /// Flip `done`.
    Toggle,
    /// Append a revision marker to the title.
    Retitle,
}

impl ChurnKind {
    /// The label printed in the plan.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Toggle => "toggle",
            Self::Retitle => "retitle",
        }
    }
}

/// One statement in a churn plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChurnStep {
    /// 1-based position in the plan: also the step number the apply loop
    /// reports.
    pub index: u64,
    /// Toggle or retitle.
    pub kind: ChurnKind,
    /// The statement itself.
    pub sql: String,
}

/// Upper bound (exclusive) on how far into the marker-scoped row set a step may
/// reach.
const MAX_ROW_OFFSET: u64 = 64;

fn lit(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Build the deterministic churn plan. Pure: no clock, no global randomness.
/// Each step addresses one marker row via a deterministic offset into the
/// marker-scoped row set, so re-running the same spec against the same seeded
/// data always edits rows in the same order.
#[must_use]
pub fn build_churn_plan(spec: &ChurnSpec) -> Vec<ChurnStep> {
    let mut rng = Rng::new(spec.seed);
    let qualified = format!("public.{}", quote_ident(&spec.table));
    let row_selector = |offset: u64| {
        format!(
            "select id from {qualified} where title like {} order by id offset {offset} limit 1",
            lit(&format!("{MOCK_MARKER}%"))
        )
    };

    (0..spec.iterations)
        .map(|i| {
            let index = i + 1;
            let kind = if rng.int(2) == 0 {
                ChurnKind::Toggle
            } else {
                ChurnKind::Retitle
            };
            let where_clause = format!("where id = ({})", row_selector(rng.int(MAX_ROW_OFFSET)));
            let sql = match kind {
                ChurnKind::Toggle => format!("update {qualified} set done = not done {where_clause};"),
                ChurnKind::Retitle => {
                    format!("update {qualified} set title = left(title, 120) || ' r{index}' {where_clause};")
                }
            };

            ChurnStep { index, kind, sql }
        })
        .collect()
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn spec(iterations: u64, seed: u64) -> ChurnSpec {
        ChurnSpec {
            iterations,
            seed,
            table: "todos".to_owned(),
        }
    }

    #[test]
    fn the_same_spec_reproduces_the_same_plan() {
        assert_eq!(
            build_churn_plan(&spec(12, 7)),
            build_churn_plan(&spec(12, 7))
        );
    }

    #[test]
    fn different_seeds_diverge() {
        assert_ne!(
            build_churn_plan(&spec(12, 7)),
            build_churn_plan(&spec(12, 8))
        );
    }

    #[test]
    fn zero_iterations_is_an_empty_plan() {
        assert!(build_churn_plan(&spec(0, 1)).is_empty());
    }

    #[test]
    fn steps_are_numbered_from_one_in_order() {
        let plan = build_churn_plan(&spec(5, 3));

        assert_eq!(
            plan.iter().map(|step| step.index).collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
    }

    #[test]
    fn every_statement_is_scoped_to_the_marker_and_hits_exactly_one_row() {
        for step in build_churn_plan(&spec(32, 5)) {
            assert!(step.sql.starts_with("update public.\"todos\" set "));
            assert!(step.sql.contains("where title like '[kizunasync-mock]%'"));
            assert!(step.sql.contains("order by id offset "));
            assert!(step.sql.contains(" limit 1)"));
            assert!(step.sql.ends_with(");"));
        }
    }

    #[test]
    fn both_kinds_are_generated_and_match_their_sql() {
        let plan = build_churn_plan(&spec(64, 11));

        assert!(plan.iter().any(|step| step.kind == ChurnKind::Toggle));
        assert!(plan.iter().any(|step| step.kind == ChurnKind::Retitle));
        for step in plan {
            match step.kind {
                ChurnKind::Toggle => assert!(step.sql.contains("set done = not done ")),
                ChurnKind::Retitle => {
                    assert!(step.sql.contains(&format!("|| ' r{}' ", step.index)));
                }
            }
        }
    }

    #[test]
    fn the_row_offset_stays_inside_the_bound() {
        for step in build_churn_plan(&spec(64, 2)) {
            let offset: u64 = step
                .sql
                .split("offset ")
                .nth(1)
                .and_then(|tail| tail.split(' ').next())
                .and_then(|value| value.parse().ok())
                .unwrap();

            assert!(offset < MAX_ROW_OFFSET);
        }
    }

    #[test]
    fn an_odd_table_name_is_quoted_not_interpolated_bare() {
        let plan = build_churn_plan(&ChurnSpec {
            iterations: 1,
            seed: 1,
            table: "we\"ird".to_owned(),
        });

        assert!(plan[0].sql.contains("public.\"we\"\"ird\""));
    }
}
