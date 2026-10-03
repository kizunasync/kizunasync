---
title: Upgrade
description: Reconcile an installed project's file ledger with the current pack, applying additive pending files and re-applying the pack when a recorded hash differs.
status: alpha
docType: how-to
audience: app-developer
---

# Upgrade

Compare an already-provisioned project's ledger against the pack the CLI ships, read what the comparison found, and apply it when it is safe. [`kizunasync upgrade`](./cli.md#kizunasync-upgrade) reads the `pack-file` rows in [`kizunasync._provisions`](../reference/sql-pack.md#kizunasync_provisions). It never installs a project from scratch, which is [`kizunasync init`](./cli.md#kizunasync-init)'s job.

## Before you begin

- The CLI has to resolve your application project, so run it from there or name the root with `--workdir <path>` ([Project root](./cli.md#project-root)).
- Resolve either a direct [database connection](./cli.md#database-connection) or a Supabase project ref plus a [Personal Access Token](https://supabase.com/docs/reference/api/introduction#authentication).
- A committed or otherwise preserved application project. `kizunasync upgrade` changes the database without writing a migration file, so your repository does not record the change the way [migration tracking](https://supabase.com/docs/guides/deployment/database-migrations#how-migration-tracking-works) records a pushed file.

## 1. Preview over a direct connection

:::tabs{group=pm}
```bash tab=npm
npx kizunasync upgrade --dry-run --db-url "$KSYNC_DB_URL"
```

```bash tab=pnpm
pnpm dlx kizunasync upgrade --dry-run --db-url "$KSYNC_DB_URL"
```

```bash tab=yarn
yarn dlx kizunasync upgrade --dry-run --db-url "$KSYNC_DB_URL"
```

```bash tab=bun
bunx kizunasync upgrade --dry-run --db-url "$KSYNC_DB_URL"
```
:::

You should now see either the pending files with their findings, or the refusal naming how many objects the ledger records with no per-file row, and nothing changed.

## 2. Preview over the Management API

:::tabs{group=pm}
```bash tab=npm
npx kizunasync upgrade --dry-run \
  --project-ref <project-ref>
```

```bash tab=pnpm
pnpm dlx kizunasync upgrade --dry-run \
  --project-ref <project-ref>
```

```bash tab=yarn
yarn dlx kizunasync upgrade --dry-run \
  --project-ref <project-ref>
```

```bash tab=bun
bunx kizunasync upgrade --dry-run \
  --project-ref <project-ref>
```
:::

`--project-ref` and `--db-url` are mutually exclusive, and passing both exits `2`. `kizunasync` reads the token from `SUPABASE_ACCESS_TOKEN`; the `--access-token` flag also takes it, but then the token shows in the process list. It is a Personal Access Token, never a publishable, secret, or legacy anon/service-role key. On this transport each pack file is applied through the Management API's [run a query](https://supabase.com/docs/reference/api/v1-run-a-query) endpoint rather than as a migration.

## 3. Interpret the result

Four outcomes are possible, and the plan names the one you got.

- Up to date means every current pack file has a matching full-file hash in the ledger. No SQL runs.
- Provisioned, unversioned means the ledger records objects but carries no `pack-file` row, so there is no hash to reconcile against. [`kizunasync init`](./cli.md#kizunasync-init) writes that row on every install it makes, so this project was provisioned some other way, and `upgrade` refuses rather than guessing at a hash.
- Pending files means current pack files are absent from the file ledger. The CLI classifies their SQL with the same rules as [`kizunasync lint`](./cli.md#kizunasync-lint), against the synced-table set it reads live from [`kizunasync._config`](../reference/sql-pack.md#kizunasync_config), and applies the batch only when nothing in it is breaking.
- Drift means a recorded hash differs, or the ledger names a file the current pack cannot reconcile. For a differing hash, preview lists the offending files with the ledger's hash and the pack's, and `kizunasync upgrade --reapply --yes` re-applies every pack file and records the pack's hash, in one transaction that rolls back whole on a failure and leaves the ledger unchanged. Without `--reapply` the CLI lists those same offenders and refuses (exit `1`), naming that command. The other kind of drift, a file the pack cannot reconcile at all, has no path forward and stops the same way.

`init`, `sync`, and the control panel items that write compare the same ledger before they change anything. On a terminal they offer this re-apply first; under `--yes` or without a terminal they exit `2` and print the `kizunasync upgrade --reapply --yes` command for the same connection.

The current manifest contains one installable pack file, so the states you can reach in this checkout are up to date, the provisioned-unversioned refusal, and drift. The pending-files branch is implemented for the additive pack files that come later. [What Kizuna installs](./whats-installed.md#the-provision-ledger) describes what the ledger records and what it deliberately leaves out.

## 4. Apply

:::tabs{group=pm}
```bash tab=npm
npx kizunasync upgrade --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=pnpm
pnpm dlx kizunasync upgrade --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=yarn
yarn dlx kizunasync upgrade --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=bun
bunx kizunasync upgrade --yes --db-url "$KSYNC_DB_URL"
```
:::

A pending-files apply requires `--yes`. `upgrade` never prompts, including on a terminal you are typing into, and it exits `2` when that authorization is absent. A breaking pending file, genuine drift, or a provisioned-unversioned ledger exits `1` rather than applying part of a change, following the [exit codes](./cli.md#exit-codes) every command shares.

The apply sends every pending file, and the ledger row for each, inside one transaction: a failure anywhere in it rolls the whole batch back, so nothing is applied and no ledger row is written. It never calls [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push), so no migration file appears in your repository for this step; the ledger row is the record instead. `--dry-run` prints the exact transaction script an apply would send. Once the transaction commits, `upgrade` re-applies [`kizunasync._schedule_jobs()`](../reference/sql-pack.md#kizunasync_schedule_jobs) and prints the schedules it applied, so a pending file that changed a retention default reaches `pg_cron` without overwriting a schedule the project already customized. A schedule that fails to apply there ends the run on exit `1`, naming `kizunasync jobs schedule` as the fix, unless `--allow-no-cron` accepts running retention by hand; the pack itself has already applied either way.

You should now see the ledger reported as up to date, and [`kizunasync status`](./cli.md#kizunasync-status) should report the same.

## 5. Re-apply the pack

:::tabs{group=pm}
```bash tab=npm
npx kizunasync upgrade --reapply --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=pnpm
pnpm dlx kizunasync upgrade --reapply --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=yarn
yarn dlx kizunasync upgrade --reapply --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=bun
bunx kizunasync upgrade --reapply --yes --db-url "$KSYNC_DB_URL"
```
:::

A drifted ledger, one whose recorded hash for a pack file differs from the file's own, needs `--reapply` rather than a plain apply. Run `--reapply --dry-run` first to print the script, then `--reapply --yes` to apply it. Every pack file runs again, each one followed by the upsert that records the file's hash, inside one transaction: a failure anywhere in it rolls the whole batch back and leaves the ledger unchanged, the same guarantee a pending-files apply gives. Once the transaction commits, `upgrade` re-applies the job schedules the same way a pending-files apply does. `--reapply` also runs against an up-to-date ledger, to restore a pack object someone dropped or altered outside the CLI; there it writes no ledger row, because the ledger already records the right hash. Either way it resets the `kizunasync` schema's grants for `public`, `anon`, and `authenticated` to the pack's own and recreates the pack's policies and its two change-stamp triggers, `kizunasync_arm_stamp` and `kizunasync_stamp_transaction`, so a hand-applied grant or policy change does not survive a re-apply; your synced tables, their data, and `kizunasync._settings` are untouched.

A re-apply does not reshape a `kizunasync` table that an earlier build of the pack created. The pack creates its tables with `create table if not exists`, so a column that build did not create stays missing, and the first statement that names it fails with `42703` (`42P01` for a missing table). The transaction rolls back, the ledger keeps its hash, and the run names the way out over the same connection: remove Kizuna with `kizunasync deprovision --purge`, then install it again with `kizunasync init`. The Management API path cannot run `deprovision`, so after a `--project-ref` run both commands take `--db-url` with the project's direct connection string, its password in `PGPASSWORD`. The purge drops the whole `kizunasync` schema, its configuration and bookkeeping rows included, and leaves your application tables and their data in place; [Deprovision ledgered objects](./removing.md) walks through it. `init`, `sync`, and the control panel print the same step when the re-apply they offer fails this way, and over a direct connection the panel then opens its menu on Remove Kizuna.

You should now see the ledger reported as up to date, with the offending files' hashes matching the pack.

## Next steps

- [What Kizuna installs](./whats-installed.md)
- [Manage synced tables](./manage-synced-tables.md)
- [Deprovision ledgered objects](./removing.md)
- [SQL pack](../reference/sql-pack.md)
- [CLI](./cli.md#kizunasync-upgrade)
