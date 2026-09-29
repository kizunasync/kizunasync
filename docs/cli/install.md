---
title: Install
description: Preview the plan and provision the SQL pack locally or through the Management API.
status: alpha
docType: how-to
audience: app-developer
---

# Install

Preview what [`kizunasync init`](./cli.md#kizunasync-init) would write, then provision Kizuna into a Supabase project. The pack lands as migration files in your repository, or straight in a hosted project over the Management API.

`init` emits the installable [SQL pack](../reference/sql-pack.md). From your existing Row Level Security policies, it proposes the synced tables. It then generates the migration that fills the [server configuration](./configuration.md). On the local-file path, `init` also exposes `kizunasync` to [PostgREST](https://postgrest.org/).

## Before you begin

- A Supabase application project to install into. The local-file path needs a `supabase/config.toml`, so run [`supabase init`](https://supabase.com/docs/reference/cli/supabase-init) and [`supabase link`](https://supabase.com/docs/reference/cli/supabase-link) first. Supabase covers both in [Local development](https://supabase.com/docs/guides/local-development#cli), and Kizuna adds no project of its own on top.
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) policies on the tables you want `init` to propose. Kizuna reads them to guess an owner column, never to write or change a policy. A flag-only or `--local-only` run cannot read them, so you edit those table entries by hand afterwards.
- Run every command from the application project, or pass `--workdir <path>`, which [Project root](./cli.md#project-root) explains.

:::tabs{group=pm}
```bash tab=npm
npx kizunasync --help
```

```bash tab=pnpm
pnpm dlx kizunasync --help
```

```bash tab=yarn
yarn dlx kizunasync --help
```

```bash tab=bun
bunx kizunasync --help
```
:::

You should now see the command list, with `init`, `sync`, `status`, `doctor`, `lint`, `upgrade`, `deprovision`, `jobs`, `mock`, and `version`. The [CLI reference](./cli.md#commands) describes each one.

## 1. Preview the local-file path

:::tabs{group=pm}
```bash tab=npm
npx kizunasync init --dry-run --db-url "$KSYNC_DB_URL"
```

```bash tab=pnpm
pnpm dlx kizunasync init --dry-run --db-url "$KSYNC_DB_URL"
```

```bash tab=yarn
yarn dlx kizunasync init --dry-run --db-url "$KSYNC_DB_URL"
```

```bash tab=bun
bunx kizunasync init --dry-run --db-url "$KSYNC_DB_URL"
```
:::

The dry run reads your policies, prints the pack and config plan, and writes nothing at all. You should now see the SQL pack and the generated project-config SQL on stdout, with no new file in `supabase/migrations/`.

Any host that is not loopback connects over TLS, with the certificate and the hostname verified, so the connection strings the Supabase dashboard's Connect panel shows work as they are. Kizuna decides TLS before the connection opens and refuses `sslmode=disable` or `sslmode=allow` on such a host. Supabase covers the parameter in [Connecting with SSL](https://supabase.com/docs/guides/database/connecting-to-postgres#connecting-with-ssl). Take the string from your project's Supabase settings rather than assembling one, since pooler endpoints are project-specific. [Database connection](./cli.md#database-connection) lists every place the CLI looks for it.

## 2. Apply the local-file path

:::tabs{group=pm}
```bash tab=npm
npx kizunasync init --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=pnpm
pnpm dlx kizunasync init --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=yarn
yarn dlx kizunasync init --yes --db-url "$KSYNC_DB_URL"
```

```bash tab=bun
bunx kizunasync init --yes --db-url "$KSYNC_DB_URL"
```
:::

This writes timestamped migrations, one of which upserts your synced tables into `kizunasync._config`. It patches [`[api].schemas`](https://supabase.com/docs/guides/local-development/cli/config#api.schemas) in `supabase/config.toml` and runs [`supabase db push`](https://supabase.com/docs/reference/cli/supabase-db-push). To write the files without connecting or applying, run `init --local-only --yes` instead.

You should now see the new migrations in `supabase/migrations/` and `kizunasync` in the `[api].schemas` list. [What Kizuna installs](./whats-installed.md) is the inventory those migrations create.

A config migration already in the folder is skipped rather than emitted twice. Kizuna's SQL becomes ordinary migration files, so Supabase's [migration tracking](https://supabase.com/docs/guides/deployment/database-migrations#how-migration-tracking-works) records them like your own. `--local-only --yes` skips policy introspection, so that mode cannot propose tables from the database.

## 3. Use the wizard instead

:::tabs{group=pm}
```bash tab=npm
npx kizunasync init
```

```bash tab=pnpm
pnpm dlx kizunasync init
```

```bash tab=yarn
yarn dlx kizunasync init
```

```bash tab=bun
bunx kizunasync init
```
:::

On a real terminal, with no `--yes`, `--local-only`, or `--dry-run`, `init` asks instead of assuming. It settles a connection, asks which tables to sync, offers **Recommended** or **Customize**, and ends on one write confirmation that defaults to no. Customize walks the per-table contract, the server maintenance schedules, the push policy, and what to do when `pg_cron` is absent.

The connection question appears only when no `--db-url` and no connection-string variable in the process environment already picked one. It then offers what it found: the linked project, named by `SUPABASE_PROJECT_ID` or by the ref [`supabase link`](https://supabase.com/docs/reference/cli/supabase-link) recorded, connection strings declared in the project's `.env` files, the [local Supabase stack](./local-supabase.md), and a project from your Supabase account, always offered last. Once you pick one, Kizuna tests it and reports what it found; a failed test explains why and offers the list again. [Interactive mode](./cli.md#interactive-mode-colors-and-output-streams) documents each prompt.

When you choose an account project, Kizuna resolves a [Personal Access Token](https://supabase.com/docs/reference/api/introduction#authentication) in a fixed order. It reads the `--access-token` flag first, then `SUPABASE_ACCESS_TOKEN`, then the same key in the project's `.env` files. It reads the operating system keyring the Supabase CLI writes next, under the current profile's account and then the legacy `access-token` account, and the `access-token` file in the Supabase home directory (`SUPABASE_HOME`, else `~/.supabase`) last. Kizuna only reads a token you already have. When no source resolves, the wizard runs [`supabase login`](https://supabase.com/docs/reference/cli/supabase-login). A missing CLI or a cancelled login falls back to a masked paste that Kizuna keeps in memory only. A run that never selects an account project never reads the keyring.

The wizard's step titles may render as clickable links in terminals that support OSC 8. That presentation changes neither the scripted contract nor what gets written.

You should now see the plan, and then either the same files step 2 produces or a clean cancellation that wrote nothing.

## 4. Provision a hosted project through the Management API

:::tabs{group=pm}
```bash tab=npm
npx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --dry-run

npx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --yes
```

```bash tab=pnpm
pnpm dlx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --dry-run

pnpm dlx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --yes
```

```bash tab=yarn
yarn dlx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --dry-run

yarn dlx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --yes
```

```bash tab=bun
bunx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --dry-run

bunx kizunasync init \
  --project-ref <project-ref> \
  --access-token "$SUPABASE_ACCESS_TOKEN" \
  --yes
```
:::

This path [reads](https://supabase.com/docs/reference/api/v1-get-postgrest-service-config) and [updates](https://supabase.com/docs/reference/api/v1-update-postgrest-service-config) the hosted PostgREST schema configuration. It runs the same table proposal and the same wizard the local path runs. It introspects your tables through the Management API rather than a direct Postgres connection. The command then applies each pack file and the config SQL through the Management API's [run a query](https://supabase.com/docs/reference/api/v1-run-a-query) endpoint. It never calls `db push`, so the SQL leaves no trace in your migration history. You accept that in exchange for provisioning a project with no local `supabase/` directory. The credential is a Personal Access Token, never one of your project's own keys. It is not a [publishable key](https://supabase.com/docs/guides/api/api-keys#publishable-keys-and-public-components), and it is not a [secret key](https://supabase.com/docs/guides/api/api-keys#secret-keys-and-elevated-access). The token travels only in the `Authorization` header. `--project-ref` conflicts with `--local-only` and `--db-url`, and exits `2` against either.

You should now see the exposure outcome and the pack plan from the dry run, then a report of what the [`kizunasync._provisions`](../reference/sql-pack.md#kizunasync_provisions) ledger holds after the apply. [Remote provisioning](./cli.md#remote-provisioning---project-ref) lists the four outcomes that ledger can produce.

## 5. Verify

:::tabs{group=pm}
```bash tab=npm
npx kizunasync doctor
npx kizunasync status --db-url "$KSYNC_DB_URL"
```

```bash tab=pnpm
pnpm dlx kizunasync doctor
pnpm dlx kizunasync status --db-url "$KSYNC_DB_URL"
```

```bash tab=yarn
yarn dlx kizunasync doctor
yarn dlx kizunasync status --db-url "$KSYNC_DB_URL"
```

```bash tab=bun
bunx kizunasync doctor
bunx kizunasync status --db-url "$KSYNC_DB_URL"
```
:::

[`doctor`](./cli.md#kizunasync-doctor) reads `kizunasync._config` over the same connection ladder `status` uses, checks the local project files, and adds one live Data API probe when it finds a project URL and a publishable key, from the flags, the environment, your `.env` files, or the linked project. [`status`](./cli.md#kizunasync-status) reads provisioned state through [Postgres](https://grokipedia.com/page/PostgreSQL), or through the Management API with `--project-ref`.

You should now see every `doctor` check passing, including `config-tables`, which names how many synced tables the database declares, and `api-schemas`, which catches a schema missing from [the exposed list](https://supabase.com/docs/guides/api/using-custom-schemas#exposing-custom-schemas). The `status` report should show a `pack` line that is up to date and a `tables` section listing the tables you provisioned.

Neither command proves that your application tables' policies are correct. Test authorization separately, against the policies Supabase documents in [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does), and read [Server-side validation](../sync/server-side-validation.md) for what the server decides after a write is queued.

## Next steps

- [What Kizuna installs](./whats-installed.md)
- [Configuration](./configuration.md)
- [Manage synced tables](./manage-synced-tables.md)
- [Upgrade](./upgrading.md)
- [Local Supabase](./local-supabase.md)
- [CLI](./cli.md#kizunasync-init)
