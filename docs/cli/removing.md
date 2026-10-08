---
title: Remove
description: Preview and remove only the Kizuna objects recorded in the provision ledger while preserving application tables and data.
status: alpha
docType: how-to
audience: app-developer
---

# Remove

Remove Kizuna from a Supabase project without putting your application data at risk. [`kizunasync deprovision`](./cli.md#kizunasync-deprovision) drops only the objects [`kizunasync._provisions`](../reference/sql-pack.md#kizunasync_provisions) records and the current CLI understands, so your application tables and their data are never teardown targets. This page shows you how to read the plan, check what it leaves behind, and then apply it.

## Before you begin

- Provide a direct [database connection](./cli.md#database-connection), through `--db-url`, a connection-string environment variable such as `KSYNC_DB_URL` or `DATABASE_URL`, an environment file, or the local Supabase config fallback. For a hosted project you can pass its ref with `--project-ref` instead, as [step 5](#5-remove-kizuna-from-a-hosted-project-with---project-ref) shows. The ledger lives in the project database, so there is no offline path.
- Back up anything you may need. Applying this command is destructive even though its scope is bound to the ledger. In a project with a `supabase/config.toml`, the teardown is a migration applied with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push), so it lands in your migration history the way the install did. Anywhere else, and always over `--project-ref`, it runs as one transaction and writes no file.
- A shell sitting in the application project, since the ledger read starts from the [project root](./cli.md#project-root). Anywhere else, name it with `--workdir <path>`.

## 1. Preview the plan

:::tabs{group=pm}
```bash tab=npm
npx kizunasync deprovision --dry-run
```

```bash tab=pnpm
pnpm dlx kizunasync deprovision --dry-run
```

```bash tab=yarn
yarn dlx kizunasync deprovision --dry-run
```

```bash tab=bun
bunx kizunasync deprovision --dry-run
```
:::

Human status goes to stderr and one ledger-kind-prefixed statement per planned drop goes to stdout. Read the stdout listing as a review artifact: the prefixes mean it is not a directly executable SQL migration.

The planner orders the object kinds it knows by dependency, and warns instead of guessing when it meets an unknown or malformed ledger row. A warning-only row stays in the ledger untouched.

Before it plans anything, the command reads `pg_depend` for an object outside the `kizunasync` schema and outside the ledger that depends on a pack object, such as a view over a pack table or a column default that calls a pack function. The drops cascade, so any dependent it finds refuses the whole run, exit `2`, listing what it found and applying nothing; drop or rework the dependent, then run this again.

You should now see one line per object the command plans to drop, and no change in the database.

## 2. Apply the plan

:::tabs{group=pm}
```bash tab=npm
npx kizunasync deprovision --yes
```

```bash tab=pnpm
pnpm dlx kizunasync deprovision --yes
```

```bash tab=yarn
yarn dlx kizunasync deprovision --yes
```

```bash tab=bun
bunx kizunasync deprovision --yes
```
:::

`KSYNC_ALLOW_DEPROVISION=1` is the alternative guard. The command never prompts, including on a terminal, and it exits `2` when neither guard is present, following the shared [exit codes](./cli.md#exit-codes). `--local-only` is accepted and then refused, because the ledger it has to read lives in the database.

In a project with a `supabase/config.toml`, the command compares the migration history first, as `init` does, then writes the teardown to `supabase/migrations/` as `<timestamp>_kizunasync_deprovision.sql` and applies it with `supabase db push`. Each statement in the file first checks that the table or schema it needs exists. Keep the file with the rest of your migrations: replaying the directory onto a fresh database, as [`supabase db reset`](https://supabase.com/docs/reference/cli/supabase-db-reset) does, then reaches the same state as the database you removed Kizuna from.

You should now see the planned drops applied. [`kizunasync status`](./cli.md#kizunasync-status) reports the pack as not provisioned once every ledger row produced a drop; a row this CLI could not classify stays behind with a warning, and `status` then reports `provisioned` or `drift` instead, naming what remains.

## 3. Check what remains

The base pack records four kinds of object in the ledger: its [`SECURITY DEFINER`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker) functions, the [Realtime broadcast policy](https://supabase.com/docs/guides/realtime/authorization#broadcast-and-presence-read), the [`pg_cron`](https://supabase.com/docs/guides/cron#how-does-cron-work) jobs, and the `kizunasync_rls` role. Generated per-table migrations record their [triggers](./whats-installed.md#the-per-table-hooks) and [`_config`](../reference/sql-pack.md#kizunasync_config) rows. A plain teardown removes all of those, plus the `pack-file` accounting rows. It drops them in reverse dependency order: triggers, policies, and cron jobs first, then the functions, the role, and the config rows. A ledgered role row is dropped only when its name starts with `kizunasync`; any other name is reported as a row the command cannot drop rather than dropped anyway.

By default the base pack does not object-ledger the `kizunasync` schema, its [bookkeeping tables](./whats-installed.md#the-internal-tables), its indexes, or the `_change_seq` sequence, so all of those remain afterwards. Your application tables and their data are never inferred as targets. Judge the preview the target project's own ledger produced rather than expecting a full schema removal.

You should now see the `kizunasync` schema present, holding its bookkeeping tables with no functions, triggers, or scheduled jobs left. Re-provisioning from there is [`kizunasync init`](./cli.md#kizunasync-init) again, described in [Install](./install.md).

## 4. Remove the schema itself with `--purge`

:::tabs{group=pm}
```bash tab=npm
npx kizunasync deprovision --purge --dry-run
npx kizunasync deprovision --purge --yes --confirm local
```

```bash tab=pnpm
pnpm dlx kizunasync deprovision --purge --dry-run
pnpm dlx kizunasync deprovision --purge --yes --confirm local
```

```bash tab=yarn
yarn dlx kizunasync deprovision --purge --dry-run
yarn dlx kizunasync deprovision --purge --yes --confirm local
```

```bash tab=bun
bunx kizunasync deprovision --purge --dry-run
bunx kizunasync deprovision --purge --yes --confirm local
```
:::

`--purge` extends the plan past the ledger into the schema itself. It drops every table, sequence, index, policy, and grant `kizunasync` carries, then every role whose name starts with `kizunasync`, keeping a role another database of the same server still uses. Those drops follow the ledger's own drops, in the same migration file in a project with a `supabase/config.toml` and in the same transaction anywhere else. The migration file carries the purge even when the ledger is already empty, so a replay of the directory removes what the earlier install files created. `--yes` alone never applies a purge. `--confirm` also needs the project ref the CLI parses from the connection. A connection that names no project ref takes the literal `local` instead. You type that value yourself, so a script that already sets `--yes` for a plain teardown cannot purge by accident. A purge never drops your application tables or their data, and neither does a plain teardown.

Before the purge drops the schema, the command removes `kizunasync` from the Data API's exposed schemas, which `init` added it to, because PostgREST stops serving every schema (`PGRST002`) when a schema it lists is missing. For the local stack with a `supabase/config.toml`, the command removes the entry from `[api].schemas`, leaves the rest of the file as it was, and reminds you to restart the local stack (`supabase stop`, then `supabase start`) after the purge, since the stack reads the file at start. For a hosted project reached directly, it edits the project's Data API settings through the Management API when `SUPABASE_ACCESS_TOKEN` holds a Personal Access Token, and never edits the local file. Otherwise the plan warns you to remove `kizunasync` from the project's exposed schemas yourself first (Project Settings, Data API), or to purge with `--project-ref`. When `kizunasync` is the only exposed schema, the purge is refused before anything changes. A plain teardown keeps the schema and its exposure.

You should now see the `kizunasync` schema gone entirely, `kizunasync` gone from the exposed schemas, and `kizunasync status` reporting the pack as not provisioned with no ledger to fall back on. Running [`kizunasync init`](./cli.md#kizunasync-init) again installs Kizuna afresh: the ledger is empty, so the files the earlier install left in `supabase/migrations/` do not count as installed, and `init` writes and pushes new ones.

## 5. Remove Kizuna from a hosted project with `--project-ref`

Set `SUPABASE_ACCESS_TOKEN` in the environment first. `kizunasync` reads it there, which keeps the token out of the command line and the process list.

:::tabs{group=pm}
```bash tab=npm
npx kizunasync deprovision \
  --project-ref <project-ref> \
  --dry-run

npx kizunasync deprovision \
  --project-ref <project-ref> \
  --yes
```

```bash tab=pnpm
pnpm dlx kizunasync deprovision \
  --project-ref <project-ref> \
  --dry-run

pnpm dlx kizunasync deprovision \
  --project-ref <project-ref> \
  --yes
```

```bash tab=yarn
yarn dlx kizunasync deprovision \
  --project-ref <project-ref> \
  --dry-run

yarn dlx kizunasync deprovision \
  --project-ref <project-ref> \
  --yes
```

```bash tab=bun
bunx kizunasync deprovision \
  --project-ref <project-ref> \
  --dry-run

bunx kizunasync deprovision \
  --project-ref <project-ref> \
  --yes
```
:::

The command reads the ledger and applies the teardown through the Management API's [run a query](https://supabase.com/docs/reference/api/v1-run-a-query) endpoint. The plan, the `pg_depend` refusal, and the `--yes` guard are the ones the steps above describe. The teardown always runs as one transaction, also in a project with a `supabase/config.toml`, and it writes no migration file, the same way `init --project-ref` installs without one. To purge, add `--purge` and type the same ref after `--confirm`, as in `--purge --yes --confirm <project-ref>`. Before the purge runs, the command removes `kizunasync` from the project's exposed schemas in its Data API settings and waits up to 60 seconds for the change to apply; when `kizunasync` is the only exposed schema, the purge is refused. The credential is a Personal Access Token, never one of your project's own keys. `--project-ref` and `--db-url` are mutually exclusive, and passing both exits `2`.

You should now see the plan from the dry run, then the same summary a direct teardown prints, and [`kizunasync status --project-ref <project-ref>`](./cli.md#kizunasync-status) reporting what the matching step above leaves behind.

## Next steps

- [Install Kizuna into your Supabase project](./install.md)
- [What Kizuna installs](./whats-installed.md#the-provision-ledger)
- [Upgrade an installed pack](./upgrading.md)
- [SQL pack](../reference/sql-pack.md)
- [CLI](./cli.md#kizunasync-deprovision)
