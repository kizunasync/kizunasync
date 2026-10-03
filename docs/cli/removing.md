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

- Provide a direct [database connection](./cli.md#database-connection), through `--db-url`, a connection-string environment variable such as `KSYNC_DB_URL` or `DATABASE_URL`, an environment file, or the local Supabase config fallback. The ledger lives in the project database, so there is no offline path.
- Back up anything you may need. Applying this command is destructive even though its scope is bound to the ledger. In a project with a `supabase/config.toml`, the teardown is a migration applied with [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push), so it lands in your migration history the way the install did. Anywhere else it runs over the connection as one transaction and writes no file.
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

You should now see the `kizunasync` schema gone entirely, and `kizunasync status` reporting the pack as not provisioned with no ledger to fall back on. Running [`kizunasync init`](./cli.md#kizunasync-init) again installs Kizuna afresh: the ledger is empty, so the files the earlier install left in `supabase/migrations/` do not count as installed, and `init` writes and pushes new ones.

## Next steps

- [Install Kizuna into your Supabase project](./install.md)
- [What Kizuna installs](./whats-installed.md#the-provision-ledger)
- [Upgrade an installed pack](./upgrading.md)
- [SQL pack](../reference/sql-pack.md)
- [CLI](./cli.md#kizunasync-deprovision)
