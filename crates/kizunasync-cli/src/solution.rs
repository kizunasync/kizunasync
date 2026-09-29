//! The backend a wizard run provisions against.
//!
//! [`Solution::ALL`] is the list the picker offers.

/// A backend Kizuna can provision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Solution {
    /// Supabase: Postgres, Auth, and the local stack.
    Supabase,
}

impl Solution {
    /// What the picker offers, in display order.
    pub const ALL: [Solution; 1] = [Solution::Supabase];

    /// The row label.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Supabase => "Supabase",
        }
    }

    /// The muted note beside the label.
    #[must_use]
    pub const fn hint(self) -> &'static str {
        match self {
            Self::Supabase => "Postgres and Auth",
        }
    }
}
