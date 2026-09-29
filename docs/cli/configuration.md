---
title: Configuration
description: Column-by-column reference for kizunasync._config and kizunasync._settings, what kizunasync init and kizunasync sync write into them, and how the other commands read them.
status: alpha
docType: reference
audience: app-developer
---

# Configuration

`kizunasync._config` and `kizunasync._settings` are a provisioned project's own configuration record: `_config` holds one row per synced table, and `_settings` holds one row for the global push policy. The [CLI](./cli.md) reads both on every run, and writes them through the migrations [`kizunasync init`](./cli.md#kizunasync-init) and [`kizunasync sync`](./cli.md#kizunasync-sync) emit. The declaration you review is a file under `supabase/migrations/`. The live one is the database. Your app passes its own [`defineConfig`](../reference/javascript/define-config.md) object to [`createKizunaSync`](../reference/javascript/initializing.md), which is a separate client-side declaration.

## kizunasync._config

One row per synced table, keyed on the table name, always in the `public` schema. [`kizunasync init`](./cli.md#kizunasync-init) inserts the rows for the tables you kept, and [`kizunasync sync`](./cli.md#kizunasync-sync) adds and removes rows afterwards. Every write is an upsert, so re-applying the migration lands on the same row.

| Column | Meaning | Written by | Default |
|---|---|---|---|
| `table_name` | The synced table. The pack's triggers and RPCs address `public.<table>`. | The proposals `init` kept, and each `kizunasync sync --add`. | — |
| `sync_mode` | `pull-only` pulls the table down and rejects a push that targets it, in [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush). `read-write` is bidirectional, through the [outbox](../resources/glossary.md#outbox). | The wizard's sync-mode answer, `kizunasync init --sync`, or `kizunasync sync --sync`. | `pull-only` |
| `bucket_column` | The indexed column a [pull](../resources/glossary.md#pull) is scoped by. Index it, for the reason Supabase gives in [Add indexes](https://supabase.com/docs/guides/database/postgres/row-level-security#add-indexes). | The wizard's bucket answer, the owner column `init` inferred from your policies, `kizunasync init --bucket-column`, or `kizunasync sync --bucket-column`. | `null`, so every permitted row is pulled |
| `soft_delete_column` | The column that carries an app-level deletion marker. A local `delete()` against it performs the soft update instead of a hard delete, and [Soft delete](../sync/sync-rules-and-buckets.md#soft-delete) covers the client-side semantics. | The wizard's soft-delete answer, `kizunasync init --soft-delete`, or `kizunasync sync --soft-delete`. | `null`, so a hard delete is allowed |
| `conflict_mode` | [`arrival`](../sync/conflict-resolution.md#arrival-mode) orders by server arrival and trusts no client clock. [`hlc`](../sync/conflict-resolution.md#hlc-mode) orders by the origin [hybrid logical clock](../resources/glossary.md#hybrid-logical-clock-hlc). Both sit under the delete-wins invariant. | The wizard's conflict answer, `kizunasync init --conflict`, or `kizunasync sync --conflict`. | `arrival` |
| `conflict_journal` | When true, overwritten same-column values are recorded in [`kizunasync._conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal) and may come back as optional pull `conflicts`, which [Conflict history](../sync/conflict-resolution.md#conflict-history) describes. | `kizunasync init --conflict-journal`, `kizunasync sync --conflict-journal`, or the wizard's yes/no question, which defaults to off. | `false` |
| `register_clients` | Opts the table into device registration in [`_clients`](../reference/sql-pack.md#kizunasync_clients), which is what gives it per-client retention and stale-client visibility. | `--register-clients` / `--no-register-clients`, or the wizard's yes/no question. | `false` |
| `tombstone_ttl_days` | How long this table's hard-delete [tombstones](../resources/glossary.md#tombstone) enforce delete-wins before retention reaps them. `null` inherits the project default in `_settings.tombstone_ttl_days`. | `kizunasync sync --tombstone-ttl-days` (per table), or the wizard's retention answer. An empty wizard answer, or a table `init` and `sync` leave unnamed, writes SQL `null`. | `null`, the project default |
| `min_schema_version` | The lowest client schema version this table's contract is valid for. A client below it receives the `RESET_REQUIRED` [lifecycle signal](../reference/protocol.md#lifecycle-signals) and must reset and rehydrate. | `--min-schema-version`, or the wizard's answer. | `1` |
| `created_at` | When Postgres first inserted the row. | — | `now()` |

[Buckets](../resources/glossary.md#bucket) are a selection layer, never an authorization layer. Row Level Security decides what a user may read or write, which Supabase documents in [What a policy does](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does), and `bucket_column` only narrows which of those permitted rows reach this device. A row with no `bucket_column` syncs every permitted row, a public-read `using (true)` table included. [Sync rules and buckets](../sync/sync-rules-and-buckets.md#1-understand-the-two-layers) sets out the two layers side by side.

## kizunasync._settings

One row, always `id = true`, holding the global push policy [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush) enforces before it processes any mutation, and the retention knobs and job schedules the three [background jobs](../reference/sql-pack.md#scheduled-jobs) read.

| Column | Meaning | Written by | Default |
|---|---|---|---|
| `id` | The singleton key, constrained to `true` so a second row cannot exist. | The pack, then `kizunasync init`. | `true` |
| `max_batch_size` | Maximum mutations per push. A larger push is rejected, and `1` means single-mutation pushes only. `null` accepts a push of any size. | `kizunasync init --max-batch-size` or its wizard question, then `kizunasync sync --max-batch-size` to set one and `--no-max-batch-size` to lift it. | `500` |
| `require_atomic` | When true, a non-atomic push raises `KZP03`. The current client sends ordinary writes as non-atomic, so `--require-atomic` is refused and `kizunasync doctor` fails if the column is on. Turn it off with `kizunasync sync --no-require-atomic`. | `kizunasync sync --no-require-atomic`. | `false` |
| `reap_schedule` | UTC crontab for [`kizunasync.reap_tombstones()`](../reference/sql-pack.md#kizunasyncreap_tombstones), applied by `_schedule_jobs()`. | `--reap-schedule`, or the wizard's server maintenance section. | `16 3 * * *` |
| `compact_schedule` | UTC crontab for [`kizunasync.compact_changelog()`](../reference/sql-pack.md#kizunasynccompact_changelog). | `--compact-schedule`, or the wizard. | `47 3 * * *` |
| `client_prune_schedule` | UTC crontab for [`kizunasync.prune_clients()`](../reference/sql-pack.md#kizunasyncprune_clients). | `--client-prune-schedule`, or the wizard. | `31 3 * * *` |
| `client_ttl_days` | Days of silence after which a client row is pruned and stops holding the compaction floor back. | `--client-ttl-days`, or the wizard. | `90` |
| `hlc_max_skew_ms` | Forward-drift tolerance for an origin HLC on a `conflict_mode = 'hlc'` write. | `--hlc-max-skew-ms`, or the wizard. | `5000` |
| `tombstone_ttl_days` | Project-wide tombstone retention, applied to a table whose own `_config.tombstone_ttl_days` is `null`. | `kizunasync init --tombstone-ttl-days` (the project default; `sync --tombstone-ttl-days` is the per-table flag instead), or the wizard. | `30` |
| `max_pull_scan` | Candidates one [pull](../resources/glossary.md#pull) page examines at most, the rows it withholds included; a page that reaches the cap stops early and the next page continues from there. | `--max-pull-scan`, or the wizard's server maintenance section. | `5000` |

Each schedule column takes a five-field UTC crontab: minute, hour, day-of-month, month, and day-of-week. Two layers reject a bad one, the pack's check constraint and the CLI itself, and the CLI checks before it writes anything. A name (`MON`), a seconds field, an `@` macro, a step on a lone number, a step of `0`, an inverted range, and an out-of-range number all fail. The error quotes your schedule back and links `crontab.guru`. `kizunasync init` refuses to install without a way to run the three jobs. With `pg_cron` absent it exits `1` and names the Integrations page. Pass `--allow-no-cron` to accept an install with nothing scheduled: it prints the three `select` statements, and you run them by hand or on your own scheduler.

`kizunasync init` writes every knob its flags or its wizard's Customize path answered; a `Recommended` run declares nothing, so the migration carries no `_settings` statement at all and the pack's own defaults above stand. Ten further `kizunasync sync` flags change the row afterwards, one column at a time and only when what you asked for differs from what the row already holds: `--max-batch-size` / `--no-max-batch-size` for the push policy, `--require-atomic` (refused) and `--no-require-atomic` to turn atomicity off, `--reap-schedule`, `--compact-schedule`, `--client-prune-schedule`, `--client-ttl-days`, and `--hlc-max-skew-ms` for retention, and `--max-pull-scan` for the pull scan cap. [Server-side validation](../sync/server-side-validation.md#request-level-outcomes) covers what the server does with the push policy.

## How init and sync write these rows

`kizunasync init` renders one migration, `<timestamp>_kizunasync_config.sql`, from the proposals you kept: per table a `_config` upsert plus the two [change-capture triggers](./whats-installed.md#the-per-table-hooks) and the [`_provisions`](../reference/sql-pack.md#kizunasync_provisions) rows that make teardown exact, then the `_settings` update and a `select kizunasync._schedule_jobs();` call, both present only when the run declared a setting. A config migration already sitting in `supabase/migrations/` is skipped rather than emitted twice.

`kizunasync sync` reads the current rows first, decides the new set from `--add` and `--remove` or from the terminal checkbox, and renders `<timestamp>_kizunasync_sync.sql` as the delta between the two, wrapped in one `begin; ... commit;` transaction. An added table goes through the same provisioning SQL `init` uses; a removed one drops its triggers and deletes its `_config` and ledger rows. Both migrations apply with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) unless you pass `--local-only`.

Eight flags answer for every table one `kizunasync sync` invocation adds: `--sync`, `--bucket-column`, `--soft-delete`, `--conflict`, `--conflict-journal`, `--register-clients` / `--no-register-clients`, `--min-schema-version`, and `--tombstone-ttl-days`. Each falls back to the default in the table above. They apply to the whole invocation rather than to one `--add`, so a run that adds tables needing different contracts goes through the wizard or through one run per table. `kizunasync init` takes five of them with identical semantics, `--sync`, `--bucket-column`, `--soft-delete`, `--conflict`, and `--conflict-journal`, and applies each to every table that run provisions. Its own `--tombstone-ttl-days` sets the project-wide default rather than a per-table override, the one flag whose meaning differs by command. Either command accepts only `--schema public`, because the pack addresses every synced table as `public.<table>`. The wizard asks no schema question, and there is no other schema to pick.

`kizunasync init` and `kizunasync sync` share one wizard. It opens with the connection, then the table checkbox. `Recommended` accepts every inferred and default value and declares nothing. `Customize` walks each table through the questions above, in that order. A `pull-only` answer skips soft-delete, conflict mode, and the conflict journal, and leaves those three at their defaults. A server maintenance section follows: the three schedules, each with a `crontab.guru` link, then client retention, HLC skew, project tombstone retention, and the pull scan cap. The push policy comes next. On `init` alone, a final question asks what to do when `pg_cron` is absent.

`sync` walks the identical per-table ladder and the identical two server sections. What differs is what it writes, not what it asks. Every step opens on the project's current value, and only an answer that changes something is emitted. A flag you typed pre-fills the matching question, and the answer you give there wins over the flag.

`--max-batch-size` and `--tombstone-ttl-days` both refuse a value below `1` and exit `2` before anything is written: the pack's check constraint accepts one mutation per push at the least, and a retention of zero would reap a tombstone before any client could pull it. `--client-ttl-days`, `--min-schema-version`, and `--max-pull-scan` refuse below `1` the same way, and `--hlc-max-skew-ms` refuses a negative value. `kizunasync init` runs the same batch-size check, and `--no-max-batch-size` is available on both commands for "unlimited, explicitly."

## How the commands read these rows

| Command | What it reads | An unreadable record |
|---|---|---|
| [`kizunasync sync`](./cli.md#kizunasync-sync) | Every row, as the set the delta is computed against. | Exit `2`. A database it cannot reach names `supabase start` and `--db-url`. A missing column or table (`42703`, `42P01`) names `kizunasync upgrade --reapply --yes`, and, for a re-apply that fails the same way, `kizunasync deprovision --purge` followed by `kizunasync init`. |
| [`kizunasync status`](./cli.md#kizunasync-status) | All ten `_config` columns and all nine `_settings` data columns, once the pack section proves the pack is installed. Every table row reports state `synced`. | Exit `2`. |
| [`kizunasync doctor`](./cli.md#kizunasync-doctor) | The row count, reported as `kizunasync._config reachable, N synced table(s)`. | One failed check, with the other five reporting regardless. |
| [`kizunasync lint`](./cli.md#kizunasync-lint) | The table names, as the set each pending migration is classified against. | Exit `2`. |
| [`kizunasync mock`](./cli.md#kizunasync-mock-test-tooling) | The table names, when `--table` names none. | Exit `2`. |
| bare `kizunasync` | Whether any row exists, read after the provisioning ledger over the same connection. | Exit `2`, once the ledger proves the table is there to read. |

## Client configuration

You declare the object each app passes to [`createKizunaSync`](../reference/javascript/initializing.md) in the app's own source. [Define config](../reference/javascript/define-config.md) documents its fields one by one: `tables`, the `byOwner`, `byColumn`, and `attachment` helpers, `pullLimit`, `realtimeWakeups`, and `pollIntervalMs`. The client reads every field that object carries. Tombstone retention, the push policy, and the conflict journal therefore appear only in the two tables above. Editing the client object leaves an already-provisioned database as it stands. Run `kizunasync sync` when the server's synced set changes. The [compatibility matrix](../reference/javascript/fetch-data.md#local-query-compatibility-matrix) lists the local query subset you read those tables through.

## Related pages

- [JavaScript and TypeScript](../reference/javascript/introduction.md)
- [Define config](../reference/javascript/define-config.md)
- [Initializing](../reference/javascript/initializing.md)
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md)
- [Conflict resolution](../sync/conflict-resolution.md)
- [Offline writes](../sync/offline-writes.md)
- [Media and attachments](../attachments/media-and-attachments.md)
- [SQL pack](../reference/sql-pack.md)
- [CLI](./cli.md)
- [Glossary](../resources/glossary.md)
