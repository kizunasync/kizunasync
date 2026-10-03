//! Deterministic, reproducible server-side datasets.
//!
//! The hard requirement is determinism: same seed + same flags → byte-identical
//! SQL. There is no clock and no global randomness anywhere in this module:
//! every value (UUIDs included) is derived from a seeded splitmix64 PRNG, so a
//! run is fully reproducible and every seeded row is addressable by a caller
//! that knows the seed.
//!
//! The dataset columns are a fixed demo contract: `id`, `user_id`, `title`,
//! `done`, `image_path`. This module writes exactly that shape regardless of
//! which table it targets: if the resolved table doesn't carry it, Postgres
//! fails loudly and the caller sees the real error.
//!
//! Cleanup convention: every seeded row's title is prefixed with
//! [`MOCK_MARKER`], so the entire dataset is removed by a single predicate.

/// Synced tables live in `public.<name>` (the config contract): the schema is
/// fixed; the table name is resolved per run.
pub const SEED_SCHEMA: &str = "public";

/// Prefix stamped on every seeded title. Cleanup keys off this, so it is the
/// whole namespacing story, so it must be stable across versions.
pub const MOCK_MARKER: &str = "[kizunasync-mock]";

/// A splitmix64 generator. Two generators seeded the same produce the same
/// stream.
pub struct Rng {
    state: u64,
}

impl Rng {
    /// Seed the generator. The seed is folded into 32 bits first, so the same
    /// seed reproduces the same dataset.
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self {
            state: seed & 0xFFFF_FFFF,
        }
    }

    /// The next raw 64-bit value.
    pub const fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);

        z ^ (z >> 31)
    }

    /// The next integer in `[0, n)`; `0` when `n` is zero.
    pub fn int(&mut self, n: u64) -> u64 {
        if n == 0 {
            return 0;
        }

        self.next_u64() % n
    }
}

/// An RFC-4122 v4-*shaped* UUID synthesized from the PRNG (version and variant
/// nibbles pinned) so seeded rows look like real ids but stay reproducible.
/// These are not real `auth.users` ids.
pub fn rng_uuid(rng: &mut Rng) -> String {
    let a = rng.next_u64();
    let b = rng.next_u64();
    let s: Vec<char> = format!("{a:016x}{b:016x}").chars().collect();
    let slice = |from: usize, to: usize| {
        s.get(from..to)
            .map(|part| part.iter().collect::<String>())
            .unwrap_or_default()
    };
    let variant_nibble = s
        .get(16)
        .and_then(|c| c.to_digit(16))
        .map_or(8, |digit| (digit & 0x3) | 0x8);

    format!(
        "{}-{}-4{}-{variant_nibble:x}{}-{}",
        slice(0, 8),
        slice(8, 12),
        slice(13, 16),
        slice(17, 20),
        slice(20, 32)
    )
}

/// What a seed run should produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedSpec {
    /// Total rows to create across all users (split round-robin).
    pub rows: u64,
    /// Distinct owner ids to spread rows across.
    pub users: u64,
    /// How many of the rows get an `image_path`.
    pub images: u64,
    /// PRNG seed; the same seed reproduces the dataset byte for byte.
    pub seed: u64,
}

impl Default for SeedSpec {
    fn default() -> Self {
        Self {
            rows: 20,
            users: 3,
            images: 0,
            seed: 1,
        }
    }
}

/// One generated row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedRow {
    /// Deterministic primary key.
    pub id: String,
    /// Owner id.
    pub user_id: String,
    /// Marker-prefixed title.
    pub title: String,
    /// Completion flag.
    pub done: bool,
    /// Owner-path image, when this row got one.
    pub image_path: Option<String>,
}

/// The generated dataset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedDataset {
    /// The distinct owner ids, in generation order.
    pub users: Vec<String>,
    /// The rows, in generation order.
    pub rows: Vec<SeedRow>,
}

const WORDS: [&str; 12] = [
    "ship",
    "review",
    "sync",
    "refactor",
    "triage",
    "draft",
    "verify",
    "reconcile",
    "archive",
    "rotate",
    "audit",
    "backfill",
];

/// Build the deterministic dataset. Pure: no clock, no global randomness. The
/// generation ORDER is fixed (users first, then rows round-robin) so the byte
/// output never depends on iteration nondeterminism.
#[must_use]
pub fn build_dataset(spec: &SeedSpec) -> SeedDataset {
    let mut rng = Rng::new(spec.seed);
    let user_count = spec.users.max(1);
    let row_count = spec.rows;
    let image_count = spec.images.min(row_count);

    let users: Vec<String> = (0..user_count).map(|_| rng_uuid(&mut rng)).collect();
    let mut rows = Vec::new();
    for index in 0..row_count {
        let id = rng_uuid(&mut rng);
        let user_id = users
            .get(usize::try_from(index % user_count).unwrap_or(0))
            .cloned()
            .unwrap_or_default();
        let pick = rng.int(u64::try_from(WORDS.len()).unwrap_or(1));
        let word = WORDS
            .get(usize::try_from(pick).unwrap_or(0))
            .copied()
            .unwrap_or("ship");
        let done = rng.int(2) == 1;
        let image_path = (index < image_count).then(|| format!("{user_id}/{id}.jpg"));
        rows.push(SeedRow {
            title: format!("{MOCK_MARKER} {word} #{}", index + 1),
            id,
            user_id,
            done,
            image_path,
        });
    }

    SeedDataset { users, rows }
}

/// Single-quote-escape a SQL string literal.
fn lit(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Double-quote a table identifier, escaping embedded quotes, so a reserved
/// word or odd name survives.
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn row_values(row: &SeedRow) -> String {
    let image = row
        .image_path
        .as_deref()
        .map_or_else(|| "null".to_owned(), lit);

    format!(
        "({}, {}, {}, {}, {image})",
        lit(&row.id),
        lit(&row.user_id),
        lit(&row.title),
        row.done
    )
}

/// Render the INSERT as one transactional statement. `ON CONFLICT (id) DO
/// NOTHING` makes a re-seed with the same seed idempotent (the ids are
/// deterministic).
#[must_use]
pub fn build_seed_sql(dataset: &SeedDataset, table: &str) -> String {
    if dataset.rows.is_empty() {
        return "-- kizunasync mock seed: 0 rows requested, nothing to insert.\n".to_owned();
    }
    let qualified = format!("{SEED_SCHEMA}.{}", quote_ident(table));
    let values = dataset
        .rows
        .iter()
        .map(|row| format!("  {}", row_values(row)))
        .collect::<Vec<_>>()
        .join(",\n");

    format!(
        "-- Generated by `kizunasync mock seed`. Deterministic dataset (marker {MOCK_MARKER}).\n\
         -- Re-runnable: ids are seed-derived, ON CONFLICT keeps it idempotent.\n\
         begin;\n\
         insert into {qualified} (id, user_id, title, done, image_path) values\n\
         {values}\n\
         on conflict (id) do nothing;\n\
         commit;\n"
    )
}

/// The whole-dataset cleanup: a single marker predicate removes every seeded
/// row and nothing else.
#[must_use]
pub fn build_cleanup_sql(table: &str) -> String {
    let qualified = format!("{SEED_SCHEMA}.{}", quote_ident(table));

    format!(
        "-- Generated by `kizunasync mock seed --clean`. Removes ONLY rows this tool created.\n\
         delete from {qualified} where title like {};\n",
        lit(&format!("{MOCK_MARKER}%"))
    )
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_reproduces_the_same_stream() {
        let mut left = Rng::new(42);
        let mut right = Rng::new(42);

        assert_eq!(
            (0..8).map(|_| left.next_u64()).collect::<Vec<_>>(),
            (0..8).map(|_| right.next_u64()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn different_seeds_diverge() {
        assert_ne!(Rng::new(1).next_u64(), Rng::new(2).next_u64());
    }

    #[test]
    fn int_stays_in_range_and_answers_zero_for_an_empty_range() {
        let mut rng = Rng::new(7);

        assert_eq!(rng.int(0), 0);
        for _ in 0..64 {
            assert!(rng.int(12) < 12);
        }
    }

    #[test]
    fn synthesized_uuids_are_v4_shaped() {
        let mut rng = Rng::new(1);
        for _ in 0..32 {
            let uuid = rng_uuid(&mut rng);
            let parts: Vec<&str> = uuid.split('-').collect();

            assert_eq!(parts.len(), 5);
            assert_eq!(
                parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
                [8, 4, 4, 4, 12]
            );
            assert!(parts[2].starts_with('4'));
            assert!(matches!(
                parts[3].chars().next(),
                Some('8' | '9' | 'a' | 'b')
            ));
            assert!(uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        }
    }

    #[test]
    fn the_dataset_is_byte_identical_across_runs() {
        let spec = SeedSpec {
            rows: 10,
            users: 3,
            images: 4,
            seed: 99,
        };

        assert_eq!(build_dataset(&spec), build_dataset(&spec));
        assert_eq!(
            build_seed_sql(&build_dataset(&spec), "todos"),
            build_seed_sql(&build_dataset(&spec), "todos")
        );
    }

    #[test]
    fn rows_are_spread_round_robin_and_every_title_carries_the_marker() {
        let dataset = build_dataset(&SeedSpec {
            rows: 6,
            users: 3,
            images: 0,
            seed: 1,
        });

        assert_eq!(dataset.users.len(), 3);
        assert_eq!(dataset.rows.len(), 6);
        for (index, row) in dataset.rows.iter().enumerate() {
            assert_eq!(row.user_id, dataset.users[index % 3]);
            assert!(row.title.starts_with(MOCK_MARKER));
            assert!(row.title.ends_with(&format!("#{}", index + 1)));
        }
    }

    #[test]
    fn images_are_capped_at_the_row_count_and_use_the_owner_path() {
        let dataset = build_dataset(&SeedSpec {
            rows: 2,
            users: 1,
            images: 99,
            seed: 1,
        });

        for row in &dataset.rows {
            assert_eq!(
                row.image_path,
                Some(format!("{}/{}.jpg", row.user_id, row.id))
            );
        }
    }

    #[test]
    fn zero_users_still_produces_one_owner() {
        let dataset = build_dataset(&SeedSpec {
            rows: 2,
            users: 0,
            images: 0,
            seed: 1,
        });

        assert_eq!(dataset.users.len(), 1);
    }

    #[test]
    fn zero_rows_renders_a_comment_and_no_insert() {
        let dataset = build_dataset(&SeedSpec {
            rows: 0,
            users: 3,
            images: 0,
            seed: 1,
        });

        assert_eq!(dataset.rows, Vec::<SeedRow>::new());
        assert_eq!(
            build_seed_sql(&dataset, "todos"),
            "-- kizunasync mock seed: 0 rows requested, nothing to insert.\n"
        );
    }

    #[test]
    fn the_insert_is_transactional_idempotent_and_writes_the_demo_column_shape() {
        let sql = build_seed_sql(
            &build_dataset(&SeedSpec {
                rows: 1,
                users: 1,
                images: 0,
                seed: 1,
            }),
            "todos",
        );

        assert!(sql.contains("begin;\n"));
        assert!(sql.contains(
            "insert into public.\"todos\" (id, user_id, title, done, image_path) values"
        ));
        assert!(sql.contains("on conflict (id) do nothing;"));
        assert!(sql.trim_end().ends_with("commit;"));
    }

    #[test]
    fn an_odd_table_name_is_quoted_not_interpolated_bare() {
        assert!(build_cleanup_sql("we\"ird").contains("public.\"we\"\"ird\""));
    }

    #[test]
    fn the_cleanup_sql_deletes_only_the_rows_carrying_the_mock_marker() {
        assert_eq!(
            build_cleanup_sql("todos"),
            "-- Generated by `kizunasync mock seed --clean`. Removes ONLY rows this tool created.\n\
             delete from public.\"todos\" where title like '[kizunasync-mock]%';\n"
        );
    }
}
