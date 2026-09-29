//! Local query filter AST and evaluation (offline subset; never network).
//!
//! [`QueryPlan`] is the whole local read grammar and [`Filter`] the whole local
//! predicate grammar, evaluated under SQL three-valued logic. [`apply_query`] is
//! the evaluator and the oracle of every local read: the engine hands it the
//! whole table, or only the rows that can decide the answer, the ones a key
//! conjunct names ([`conjunct_keys`]) or the first matches of an unordered plan
//! ([`QueryPlan::decisive_matches`]). Filter-targeted writes select their rows
//! through [`validate_filters`] and [`matches_filters`]. A caller that evaluates
//! one filter list over many rows holds one [`Predicate`], which builds each
//! `like` regex and `textSearch` term list once for all of them. Nothing here
//! reaches the network.
//!
//! # Allocation
//!
//! Allocation-conscious, no I/O. Row maps are owned `serde_json::Map` values
//! because the evaluator filters and projects into new maps. Inputs that can
//! stay borrowed (`&QueryPlan`, `&Filter`) do. Not heapless.

#![forbid(unsafe_code)]

mod access;
mod ast;
mod eval;
mod validate;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;

pub use access::conjunct_keys;
pub use ast::{Filter, OrderBy, QueryError, QueryPlan, Row};
#[cfg(test)]
pub(crate) use eval::value_as_search_text;
pub use eval::{Predicate, QueryResult, apply_query, matches_filter, matches_filters};
pub use validate::validate_filters;
