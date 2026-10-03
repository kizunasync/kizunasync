//! Shared Supabase HTTP session and header rules for RPC and Storage/TUS.
//!
//! One decision: `apikey` is the publishable key, `Authorization` is the user
//! JWT, and a missing JWT is `AUTH_SESSION_MISSING`. Both adapters must not
//! invent a second copy of that rule.

use std::sync::Mutex;

/// Catalog code for a call that left without a user JWT.
pub(crate) const AUTH_SESSION_MISSING: &str = "AUTH_SESSION_MISSING";

/// The signed-in user's JWT, replaced in place when the host refreshes.
pub(crate) struct AccessToken(Mutex<Option<String>>);

impl AccessToken {
    pub(crate) fn new(token: Option<String>) -> Self {
        Self(Mutex::new(token.filter(|value| !value.is_empty())))
    }

    /// The current JWT, or `None` when the slot is empty.
    pub(crate) fn get(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .filter(|token| !token.is_empty())
    }

    pub(crate) fn set(&self, token: Option<String>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            token.filter(|value| !value.is_empty());
    }
}

/// `AUTH_SESSION_MISSING: …` with the adapter's "when" clause.
pub(crate) fn missing_session(when: &str) -> String {
    format!("{AUTH_SESSION_MISSING}: no authenticated session, {when}")
}

/// `Authorization: Bearer` plus `apikey` when a publishable key is present.
pub(crate) fn supabase_http_headers(
    bearer: &str,
    publishable_key: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers = vec![("Authorization".into(), format!("Bearer {bearer}"))];
    if let Some(key) = publishable_key.filter(|key| !key.is_empty()) {
        headers.push(("apikey".into(), key.to_owned()));
    }
    headers
}
