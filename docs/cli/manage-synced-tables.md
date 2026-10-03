---
title: Manage synced tables
description: Use kizunasync sync to change the synchronized table set, generate one delta migration, and optionally apply it.
status: alpha
docType: how-to
audience: app-developer
---

# Manage synced tables

Add a table to the synced set, drop another, and review the single migration that carries both changes.

[`kizunasync sync`](./cli.md#kizunasync-sync) reads the synced set from [`kizunasync._config`](./configuration.md). It emits one timestamped delta migration that moves the database to the set you chose. It then runs [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) unless you tell it not to.

## Before you begin

- Provision Kizuna first. See [Install Kizuna into your Supabase project](./install.md).
- Keep the application project under version control, so you can read the migration diff before applying it. Supabase's [migration tracking](https://supabase.com/docs/guides/deployment/database-migrations#how-migration-tracking-works) records the file once it runs, and Kizuna adds nothing to that mechanism.
- A reachable database on every run, because the current synced set is read from it. A run that resolves no connection exits `2` naming the local stack command and `--db-url`.
- The application project as your working directory, because the migration lands under the [project root](./cli.md#project-root). Use `--workdir <path>` to point at it from elsewhere.
- A primary key on every table you add, one column or several, each `uuid`, `text`, `character varying`, `smallint`, `integer`, or `bigint`. The command records it as the table's key, and it refuses a table without one, a key column of another type, and a `read-write` table keyed by a `generated always as identity` column. [Row keys](../sync/sync-rules-and-buckets.md#row-keys) explains the rule, and why a table devices insert into while offline suits a uuid key.

## 1. Choose tables interactively

:::tabs{group=pm}
```bash tab=npm
npx kizunasync sync
```

```bash tab=pnpm
pnpm dlx kizunasync sync
```

```bash tab=yarn
yarn dlx kizunasync sync
```

```bash tab=bun
bunx kizunasync sync
```
:::

On a terminal, the command resolves a direct [database connection](./cli.md#database-connection) or asks for one. It then shows `public`'s tables with the declared set pre-checked. Accept the proposals as Recommended, or walk through them with Customize, which also covers the server maintenance schedules and the push policy. One confirmation asks before anything is written.

The pack addresses every synced table as `public.<table>`, so there is no schema question to ask. Any table `kizunasync._config` declares that `public` does not have is pre-checked too, so dropping it is always your decision. A table the pack cannot key is listed as unavailable, with the reason beside it: no primary key, or a key column of a type [Before you begin](#before-you-begin) does not list. A table already synced stays on offer whatever its key, so you can still uncheck it. Newly checked tables take proposals inferred from the catalog and from your [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) policies, which Kizuna reads without changing. Customize opens every question on whatever the project already has. A per-table flag typed on the command line pre-fills the matching Customize question, and the answer you give there wins over the flag. [Interactive mode](./cli.md#interactive-mode-colors-and-output-streams) covers each prompt.

Off a terminal, a run with neither `--add` nor `--remove` exits `2` and names the usage. That is a refusal rather than a silent no-op, so a misconfigured CI job fails instead of quietly changing nothing.

You should now see the checkbox reflecting your current synced set. The confirmation then produces the two artifacts step 3 describes, a `<timestamp>_kizunasync_sync.sql` migration and the [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) that applies it, or it exits having touched nothing.

## 2. Use repeatable flags

:::tabs{group=pm}
```bash tab=npm
npx kizunasync sync \
  --add comments \
  --remove drafts \
  --dry-run
```

```bash tab=pnpm
pnpm dlx kizunasync sync \
  --add comments \
  --remove drafts \
  --dry-run
```

```bash tab=yarn
yarn dlx kizunasync sync \
  --add comments \
  --remove drafts \
  --dry-run
```

```bash tab=bun
bunx kizunasync sync \
  --add comments \
  --remove drafts \
  --dry-run
```
:::

Both flags repeat, and both accept `--add comments` or `--add=comments`. This path reads `kizunasync._config` and the primary key of each table you add, but no policy. A table the pack cannot key stops the run with exit `2` before anything is written, and the refusal names each key column with its type. A `read-write` addition keyed by a `generated always as identity` column stops it the same way, and a `read-write` addition whose key has another database default prints a note that offline inserts must provide those columns. An added table therefore gets the conservative default: `pull-only`, no [bucket](../resources/glossary.md#bucket), [`arrival`](../sync/conflict-resolution.md#arrival-mode) conflict mode, no conflict journal, no client registration, schema version `1`, and the project's own tombstone retention. The command refuses an invalid [Postgres](https://grokipedia.com/page/PostgreSQL) identifier, and it refuses the same table named in both sets, before it writes anything.

Eight per-table options answer for every table this invocation adds: `--sync <pull-only|read-write>`, `--bucket-column <column>`, `--soft-delete <column>`, `--conflict <arrival|hlc>`, `--conflict-journal`, `--register-clients` / `--no-register-clients`, `--min-schema-version <n>`, and `--tombstone-ttl-days <days>`. Each option answers for the whole invocation rather than for one name, so tables that need different contracts go through the wizard or through one run per table. Passing all eight leaves the wizard nothing to ask about an added table, and passing fewer pre-fills the questions it asks.

Name a table `sync` already has in `--add`, together with at least one of those eight flags, and the run is not an error. It updates that table's `_config` row to the columns the named flags cover, and leaves both its change-capture triggers and its ledger rows untouched. The run says so on stderr before the plan: `<table> is already synced: updating the options this run named.` Naming an already-synced table with no per-table flag stays the earlier no-op, and prints `<table> is already synced, nothing to add.`

### Record a changed primary key

When a migration of your own changes the primary key of a synced table, `kizunasync._config.key_columns` still names the old key, and [`kizunasync doctor`](./cli.md#kizunasync-doctor)'s `sync-key` check fails. Name the table in `--add` together with a `--min-schema-version` above its recorded one, here for a `todo_tags` table at version `1`:

:::tabs{group=pm}
```bash tab=npm
npx kizunasync sync --add todo_tags --min-schema-version 2 --yes
```

```bash tab=pnpm
pnpm dlx kizunasync sync --add todo_tags --min-schema-version 2 --yes
```

```bash tab=yarn
yarn dlx kizunasync sync --add todo_tags --min-schema-version 2 --yes
```

```bash tab=bun
bunx kizunasync sync --add todo_tags --min-schema-version 2 --yes
```
:::

The delta updates `key_columns` and calls `kizunasync._rekey_changelog('todo_tags')`, which deletes the change history, tombstones, and bucket grants the table recorded under the old key and records every current row again under the new one. A run that names the table without raising the version refuses, exit `2`, and prints this command, and the interactive checkbox always refuses, because it raises no version. Ship an app build whose schema version reaches the new minimum: a client below it receives `RESET_REQUIRED`, and after its reset it pulls the table again under the new key.

You should now see `sync-key` pass in `kizunasync doctor`.

Ten more flags are global rather than per table, and they rewrite `kizunasync._settings` one column at a time. `--max-batch-size <n>` and `--no-max-batch-size` set the batch limit. `--require-atomic` is refused, and `--no-require-atomic` is how you turn atomicity off explicitly. `--reap-schedule`, `--compact-schedule`, `--client-prune-schedule`, `--client-ttl-days`, and `--hlc-max-skew-ms` set retention, and `--max-pull-scan` sets how many candidates one pull page examines at most. A column whose flag you did not name keeps the value the project already has. The command emits SQL only when the result differs from the live row, so a run that restates the current settings writes nothing for it. `--max-batch-size`, `--client-ttl-days`, `--max-pull-scan`, and `--tombstone-ttl-days` refuse a value below `1`. `--hlc-max-skew-ms` refuses a negative value, and each schedule flag refuses anything that is not a valid five-field UTC crontab. A run that declares a schedule and finds `pg_cron` absent refuses unless `--allow-no-cron` accepts the gap.

:::tabs{group=pm}
```bash tab=npm
npx kizunasync sync --add comments --sync read-write --bucket-column post_id --yes
```

```bash tab=pnpm
pnpm dlx kizunasync sync --add comments --sync read-write --bucket-column post_id --yes
```

```bash tab=yarn
yarn dlx kizunasync sync --add comments --sync read-write --bucket-column post_id --yes
```

```bash tab=bun
bunx kizunasync sync --add comments --sync read-write --bucket-column post_id --yes
```
:::

You should now see the plan and the delta SQL on stdout, with no file changed under `--dry-run`.

## 3. Review what changes

The delta is an ordinary [schema migration](https://supabase.com/docs/guides/deployment/database-migrations#schema-migrations), so it is reviewed, committed, and applied the way Supabase describes for any other file. Kizuna only decides what goes inside it. For a non-empty delta the command prepares two things:

1. `<timestamp>_kizunasync_sync.sql` under `supabase/migrations/`.
2. A [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push) that carries the delta into your migration history. `--local-only` skips it.

An added table receives one [`_config`](../reference/sql-pack.md#kizunasync_config) row and the two [change-capture triggers](./whats-installed.md#the-per-table-hooks). Name an already-synced table in `--add` alongside a per-table flag, and the delta updates it instead. That update is one `update kizunasync._config set …` statement naming only the columns those flags cover. A recorded key change adds `key_columns` to that statement and follows it with `select kizunasync._rekey_changelog('<table>');`. It leaves that table's triggers and ledger rows alone. A run that changes a global setting also carries the [`_settings`](../reference/sql-pack.md#kizunasync_settings) update. It adds a `select kizunasync._schedule_jobs();` call when you declare a schedule column. Removing a table drops those triggers, and it deletes that table's config row and its object-ledger rows. The whole delta, tables and settings together, runs inside one `begin; ... commit;` transaction. The run keeps the [`_changelog`](../reference/sql-pack.md#kizunasync_changelog) and [`_tombstones`](../reference/sql-pack.md#kizunasync_tombstones) rows the table already produced. Retention reaps those rows on its own schedule, and rewriting them here would rewrite history other clients may be reading. Every run says so.

`--dry-run` prints the plan and the SQL without writing. `--local-only --yes` writes the migration without applying it. The scripted write path requires `--yes`, and the terminal flow asks once instead.

You should now see one new migration file and, unless you passed `--local-only`, the table appearing as `synced` in [`kizunasync status`](./cli.md#kizunasync-status).

## Next steps

- [Install Kizuna into your Supabase project](./install.md)
- [Configuration](./configuration.md#kizunasync_config)
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md)
- [What Kizuna installs](./whats-installed.md)
- [CLI](./cli.md#kizunasync-sync)
