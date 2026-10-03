<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">kizunasync-cli</span>
</h1>

Canonical Rust implementation of the `kizunasync` command. Private workspace member (`publish = false`); no crates.io package.

`.github/workflows/release-npm.yml` builds this binary once per target (`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-arm64-gnu`, `win32-x64-msvc`) and packs each build into the one platform package `@kizunasync/<triple>`, which carries both native binaries: this CLI under `bin/` and the N-API engine library at the package root.

The npm `kizunasync` package under `packages/kizunasync` is a thin Node shim. It resolves this binary; it does not implement the CLI.

## Get started

```sh
cargo build -p kizunasync-cli
target/debug/kizunasync --help
```

For product docs and package-manager invocation (`npx kizunasync`, `pnpm dlx kizunasync`, `yarn dlx kizunasync`, `bunx kizunasync`), see [CLI](../../docs/cli/cli.md). Prefer those entry points over `target/debug/kizunasync` outside this crate's own development loop.

`src/cli.rs` is the flag source of truth. `tests/golden/` pins the rendered surface byte for byte. Rerun tests with `KSYNC_BLESS_GOLDEN=1` to record a deliberate change.

Current subcommands: `init`, `sync`, `status`, `doctor`, `lint`, `upgrade`, `deprovision`, `jobs list`, `jobs run`, `jobs schedule`, `mock seed`, `mock churn`, and `version`.

## Interaction contract

- Bare `kizunasync` opens the setup flow on an interactive terminal, or the control panel once Kizuna is installed, which runs `sync`, `upgrade`, `doctor`, `status`, `jobs`, `lint`, and `deprovision` from one menu and prints each item's one-shot equivalent; off a terminal it prints help and exits `0`
- `init` and `sync` have TTY wizards. Scripted write paths require `--yes`
- `status` may render a formatted TTY report but never prompts
- `upgrade`, `deprovision`, `jobs`, `mock seed`, and `mock churn` never prompt. Applied operations require `--yes` or the documented environment guard. `deprovision --purge` also wants the connection target typed with `--confirm`
- Cancelling a prompt writes nothing and exits `0`; usage and refusal states exit `2`. `Ctrl+C` outside a prompt, while a write or a network call runs, cancels the running statement on a direct Postgres connection and exits `130` after saying the transaction in progress was not applied, or that it may have committed when the server does not confirm that the statement stopped. During `supabase db push` it stops the push, removes each migration file it wrote that the migration history does not record, and exits `130`. The npm shim reports `130` when the binary it spawned was killed by `SIGINT`

Human status goes to stderr. JSON, JSONL, quiet status, version, dry-run SQL, and statement listings use stdout.

## Project and configuration

Project root precedence: global `--workdir`, `SUPABASE_WORKDIR`, nearest ancestor with `supabase/config.toml`, then the current directory.

The synced-table contract lives in the project's database: `kizunasync._config` (one row per synced table) and single-row `kizunasync._settings` (push policy, job schedules, client TTL, HLC skew ceiling, project-wide tombstone retention). No configuration file is read or written. An unreadable `_config` is an error naming the cause; the loader does not substitute an empty table set.

A generated migration writes only the `_settings` columns the run declared. Declaring any of the three schedules appends `select kizunasync._schedule_jobs();`.

`init`, `sync`, `upgrade`, and `deprovision` read `pack_version` from the ledger's `pack-file` rows before writing anything, and refuse (exit `2`, `update kizunasync`) when a row names a pack newer than this binary ships, or one it does not recognize at all. `status` and `doctor` report that same row instead of refusing.

`init`, `sync`, and the control panel items that write `kizunasync._config`, `kizunasync._settings`, or table triggers then compare the ledger with this binary's pack. A changed hash, or a pack file the ledger does not record, is offered the `upgrade --reapply` re-apply on a terminal; under `--yes` or off a terminal the run exits `2` before writing anything and names `kizunasync upgrade --reapply --yes` with the same connection flags.

## SQL pack lookup

`init`, `upgrade`, and `status` need the installable SQL pack (`pack.manifest.json` plus its migration files). Order: `KSYNC_PACK_DIR`, then a `pack/` directory beside the running executable (the bundled layout a packaged install ships), then `packages/supabase-pack` beside the nearest `target/` directory above the executable, where a `cargo build`/`cargo run` dev binary of this checkout lives. That last rung weighs only the nearest `target/`: when the pack manifest is not beside it, nothing matches. Nothing here walks up from the working directory: an app project the CLI was installed into is never searched for a pack that happens to live somewhere above it.

## Transports

Database-backed commands use direct Postgres resolution from `--db-url`, `KSYNC_DB_URL`, `DATABASE_URL`, root environment files, or the local Supabase port.

`init`, `sync`, `status`, `upgrade`, `doctor`, and `lint` take `--project-ref` for the Supabase Management API with a PAT from `--access-token` or `SUPABASE_ACCESS_TOKEN`. It is refused alongside `--db-url` on writing commands. `deprovision`, `jobs`, and mock commands accept `--db-url` only.

The CLI never uses a publishable, secret, or service-role key as a database transport credential. `doctor --url --publishable-key` is a separate read-only Data API exposure probe.

## Sync contract flags

`kizunasync sync --add` / `--remove` are repeatable and skip introspection, so they provision per-table defaults. Override with `--sync`, `--bucket-column`, `--soft-delete`, `--conflict`, `--min-schema-version`, `--tombstone-ttl-days`, plus `--conflict-journal` and `--register-clients` / `--no-register-clients`.

`init` carries the same per-table flags. Its `--tombstone-ttl-days` is the project-wide default rather than a per-table override, the one flag whose meaning differs by command.

`sync --add <table>` on an already-synced table updates that table's `_config` row when the run named at least one per-table flag. Triggers and ledger rows stay as they are.

`--schema` accepts `public` and nothing else. The pack addresses `public.<table>` in every trigger and RPC.

Project settings have one flag per column; an unnamed column is left alone: `--max-batch-size` / `--no-max-batch-size`, `--no-require-atomic`, the three schedule flags, `--client-ttl-days`, `--hlc-max-skew-ms`, `--max-pull-scan`, and on `init` only `--tombstone-ttl-days`. `--require-atomic` is refused: ordinary writes are non-atomic, and turning the bit on would dead-letter them. `kizunasync doctor` fails if `_settings.require_atomic` is already on.

## Wizard

Both commands ask one question on a terminal once tables are picked: `Recommended` keeps the inferred contract and every server knob the project already carries; `Customize` walks each table, then server maintenance and push policy. `init` follows with the pg_cron policy.

`init` writes every knob its Customize path answered. `sync` writes only columns whose answer differs from what the project already carries. `--yes` and `--dry-run` skip the wizard and use the flags.

After the pack is applied, `init` checks `pg_extension` and fails with exit `1` unless `pg_cron` is enabled, naming the Integrations page. `--allow-no-cron` installs anyway and prints the three retention functions to run by hand. After an apply, `upgrade` re-applies the job schedules and exits `1` when `_schedule_jobs()` fails, unless its own `--allow-no-cron` accepts running retention by hand.

## Migration classifier

`lint` and `upgrade` share one rule set. Breaking (needs a schema-version bump): `drop-table`, `drop-column`, `rename`, `type-change`, `set-not-null`, `drop-default`, `add-constraint`, `add-column-not-null-no-default`. Additive: `add-column` (nullable or defaulted) and `drop-constraint`.

## Background jobs

`jobs list` reports the three jobs against `_settings` schedules and names drift. `jobs run` calls retention functions by hand. `jobs schedule` re-applies the settings schedules. All three take `--db-url` only.

## Teardown

`deprovision` translates understood `_provisions` rows into reverse-dependency drops. In a project with `supabase/config.toml` it writes them as `<ts>_kizunasync_deprovision.sql`, each statement guarded on the table or schema it needs, and applies the file with `supabase db push`, so the migration history records the teardown and a replay of the directory reproduces it. Anywhere else it runs them over the connection as one transaction. It drops nothing it discovers on its own. The current base pack leaves its schema, bookkeeping tables, indexes, and sequence unledgered.

The drops cascade, so before planning `deprovision` reads `pg_depend` and refuses with exit `2` when an object outside the `kizunasync` schema that the ledger does not record depends on a pack object, such as a view over a pack table or a column default that calls a pack function. It lists each one and applies nothing. A `role` row is dropped only when its name starts with `kizunasync`; any other is reported as a row it cannot drop.

`--purge` continues past the ledger into `drop schema kizunasync cascade`, then drops every `kizunasync*` role no other database of the server still uses. The migration file carries the purge even over an empty ledger. It needs the connection target typed with `--confirm` on top of `--yes`.

## Tests

```sh
cargo test -p kizunasync-cli
cargo fmt -p kizunasync-cli -- --check
cargo clippy -p kizunasync-cli --all-targets -- -D warnings
```

Postgres-gated tests use `SUPABASE_DB_URL` (or the configured local default) and report a skip when no database answers. A green unit run with that skip is not proof of live SQL behavior.

## Related

- [CLI](../../docs/cli/cli.md)
- [`kizunasync` npm package](../../packages/kizunasync/README.md)
- [Install](../../docs/cli/install.md)
