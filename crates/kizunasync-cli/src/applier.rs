//! The one capability every DB-backed command needs.
//!
//! `status`, `upgrade`, and the provisioning core all talk to this port, so the
//! direct-Postgres transport and the Management API transport drive identical
//! logic, and tests drive it with a scripted fake instead of either.

use crate::error::Result;
use crate::row::Row;

/// Run a fully-composed SQL statement (or multi-statement script) and hand back
/// whatever rows it produced.
pub trait Applier {
    /// Execute `sql`.
    ///
    /// # Errors
    /// Returns the transport's own failure; a failed call never degrades into
    /// an empty row set, because "nothing is provisioned" and "we could not
    /// ask" must not look alike.
    fn run_query(&self, sql: &str) -> Result<Vec<Row>>;

    /// Execute `sql` for effect, discarding rows.
    ///
    /// # Errors
    /// Same contract as [`Applier::run_query`].
    fn run_script(&self, sql: &str) -> Result<()> {
        self.run_query(sql).map(|_| ())
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
pub(crate) mod fake {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;

    use serde_json::Value;

    use super::{Applier, Result, Row};
    use crate::error::Error;

    /// An applier that answers from a scripted table of `query prefix → rows`
    /// and records everything it was asked to run.
    pub(crate) struct FakeApplier {
        answers: Vec<(String, Result<Vec<Row>>)>,
        /// The statement that changes the database, and the table that
        /// answers once it ran.
        after: Option<(String, Box<FakeApplier>)>,
        changed: Cell<bool>,
        pub(crate) executed: RefCell<Vec<String>>,
    }

    impl FakeApplier {
        pub(crate) fn new() -> Self {
            Self {
                answers: Vec::new(),
                after: None,
                changed: Cell::new(false),
                executed: RefCell::new(Vec::new()),
            }
        }

        /// Answer from `after` once a statement containing `needle` ran, the
        /// way a database reads after a script changed it.
        pub(crate) fn then(mut self, needle: &str, after: Self) -> Self {
            self.after = Some((needle.to_owned(), Box::new(after)));
            self
        }

        fn answer_for(&self, sql: &str) -> Result<Vec<Row>> {
            for (needle, answer) in &self.answers {
                if sql.contains(needle.as_str()) {
                    return match answer {
                        Ok(rows) => Ok(rows.clone()),
                        Err(Error::Sql { sqlstate, text }) => Err(Error::Sql {
                            sqlstate: sqlstate.clone(),
                            text: text.clone(),
                        }),
                        Err(error) => Err(Error::Db(error.to_string())),
                    };
                }
            }

            Ok(Vec::new())
        }

        /// Answer any statement containing `needle` with `rows`.
        pub(crate) fn answer(mut self, needle: &str, rows: Vec<Row>) -> Self {
            self.answers.push((needle.to_owned(), Ok(rows)));
            self
        }

        /// Fail any statement containing `needle`.
        pub(crate) fn fail(mut self, needle: &str, message: &str) -> Self {
            self.answers
                .push((needle.to_owned(), Err(Error::Db(message.to_owned()))));
            self
        }

        /// Fail any statement containing `needle` the way a server answers
        /// one: with `sqlstate`, which `text` starts with.
        pub(crate) fn fail_sql(mut self, needle: &str, sqlstate: &str, text: &str) -> Self {
            self.answers.push((
                needle.to_owned(),
                Err(Error::Sql {
                    sqlstate: sqlstate.to_owned(),
                    text: text.to_owned(),
                }),
            ));
            self
        }
    }

    impl Applier for FakeApplier {
        fn run_query(&self, sql: &str) -> Result<Vec<Row>> {
            self.executed.borrow_mut().push(sql.to_owned());
            let Some((needle, after)) = &self.after else {
                return self.answer_for(sql);
            };
            if self.changed.get() {
                return after.answer_for(sql);
            }

            self.changed.set(sql.contains(needle.as_str()));
            self.answer_for(sql)
        }
    }

    /// Build a row from `(column, value)` pairs.
    pub(crate) fn row(pairs: &[(&str, Value)]) -> Row {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect::<BTreeMap<_, _>>()
    }

    /// Build a row whose every value is text, as the simple query protocol
    /// delivers it.
    pub(crate) fn text_row(pairs: &[(&str, &str)]) -> Row {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
            .collect::<BTreeMap<_, _>>()
    }
}
