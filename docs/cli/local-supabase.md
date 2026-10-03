---
title: Local Supabase
description: Start, inspect, migrate, stop, and deliberately reset the Bun-managed Supabase development stack.
status: alpha
docType: how-to
audience: app-developer
---

# Local Supabase

Start the repository's local Supabase stack, apply its migrations, inspect the running services, and stop the stack without losing its data. These steps are for contributors working inside the Kizuna monorepo. The `@kizunasync/supabase-pack` workspace owns the Supabase CLI configuration and two local migrations: one installable pack plus one demo fixture.

## Before you begin

- [Install Bun](https://bun.sh/docs/installation) `1.4.2`, the version the repository pins through its `packageManager` field. When another version is already on your `PATH`, that page's [older-version instructions](https://bun.sh/docs/installation#installing-older-versions) install `bun-v1.4.2`. Then run `bun install` from the repository root.
- [Install Docker](https://docs.docker.com/get-started/get-docker/) or another Docker-compatible daemon the Supabase CLI supports.
- The prerequisites in [Troubleshooting](../operations/troubleshooting.md#before-you-begin), which lists what has to be running before a local service answers at all.

The Supabase CLI is a dev dependency of `@kizunasync/supabase-pack`, so a globally installed CLI is not required. Npm, pnpm, and Yarn are not the tested workspace managers for this repository. Supabase documents the stack itself in [Local development](https://supabase.com/docs/guides/local-development#cli) and its commands in the [CLI reference](https://supabase.com/docs/reference/cli/introduction). Every `bun run db:*` script below is a thin wrapper over one of those commands, so nothing here is a Kizuna-specific stack.

## 1. Start the stack

```sh
bun run db:start
```

This delegates to [`supabase start`](https://supabase.com/docs/reference/cli/supabase-start) in `packages/supabase-pack`. On a fresh stack the enabled migrations and `seed.sql` are applied. The endpoints come from that workspace's [`config.toml`](https://supabase.com/docs/guides/local-development/cli/config#db.port), which pins non-default ports so this stack does not collide with another project's:

| Service | Address |
|---|---|
| API ([PostgREST](https://postgrest.org/) and Auth) | `http://127.0.0.1:55321` |
| Postgres | `127.0.0.1:55322` |
| Studio | `http://127.0.0.1:55323` |

You should now see those three endpoints reported by the CLI. `bun run dev` also depends on the pack's `start` task, so it brings the stack up before the persistent app development tasks. That [Postgres](https://grokipedia.com/page/PostgreSQL) port is the one the CLI's [local connection fallback](./cli.md#database-connection) assembles a URL from.

## 2. Apply pending local migrations

```sh
bun run db:migrate
```

This runs [`supabase migration up`](https://supabase.com/docs/reference/cli/supabase-migration-up) against the local project and applies pending forward migrations. Supabase tracks them the way [How migration tracking works](https://supabase.com/docs/guides/deployment/database-migrations#how-migration-tracking-works) describes.

Applying a file is not a substitute for testing the policies, triggers, and RPCs it produced.

You should now see the applied migration names, and nothing left pending.

## 3. Inspect the running services

```sh
bun run db:status
```

The underlying [`supabase status`](https://supabase.com/docs/reference/cli/supabase-status) output lists the local endpoints and the development credentials. Treat the [service-role value](https://supabase.com/docs/guides/api/api-keys#secret-keys-and-elevated-access) as a secret even though the stack is local: do not copy it into client code and do not commit it. Kizuna never needs it, as [What Kizuna installs](./whats-installed.md#grants) sets out grant by grant.

Those endpoints are loopback addresses, so a simulator reaches them and a physical device on your network does not. [Expo or a physical device cannot reach local services](../operations/troubleshooting.md#expo-or-a-physical-device-cannot-reach-local-services) covers swapping in your machine's LAN address.

You should now see the API, Postgres, and Studio URLs from the table above, plus the publishable and secret keys for the local stack.

## 4. Stop without losing data

```sh
bun run db:stop
```

This delegates to [`supabase stop`](https://supabase.com/docs/reference/cli/supabase-stop), which preserves the local state for a later start. Stopping is the right move when you are done for the day or want to free the ports.

You should now see the containers stopped, and `bun run db:status` reporting the stack is not running.

## 5. Reset only when you mean it

```sh
bun run db:reset
```

`db:reset` runs [`supabase db reset`](https://supabase.com/docs/reference/cli/supabase-db-reset). It rebuilds the local database from the migrations and the seed configuration, which deletes every row in it, including the Kizuna [bookkeeping tables](./whats-installed.md#the-internal-tables) and any client state they hold. It is not a way to clear up a confusing state, and it is not a diagnostic step: read the failing migration, the policy, or the CLI error first, and check [Troubleshooting](../operations/troubleshooting.md). Reach for it only when you intend to discard the local data, and get explicit authorization before running it against a database anyone else is using.

You should now see `db:reset` re-apply every migration from scratch and run `seed.sql` again. Every row you had before the reset is gone.

## 6. Verify the schema

Open Studio at `http://127.0.0.1:55323` after the stack has started. You should now see the `kizunasync` schema, whose objects [What Kizuna installs](./whats-installed.md) lists, and the demo `public.todos` table.

For executable verification, run the [SQL pack](../resources/glossary.md#sql-pack) tests while the configured local database is reachable.

Without a reachable database the suite reports skips, and a skip is not evidence of live behavior. [CI and CD](../operations/ci-cd.md#live-supabase-database-job) shows the job that runs them for real.

## 7. Know which migrations are product code

`packages/supabase-pack/pack.manifest.json` is authoritative:

| File | Classification | Purpose |
|---|---|---|
| `0001_kizuna_init.sql` | pack | The installable engine schema, [RPCs](./whats-installed.md#the-public-rpcs), grants, trigger functions, the Realtime broadcast policy, and the three guarded retention jobs |
| `0002_example.sql` | demo | `todos` (with its `archived_at` soft-delete column, the column a [`softDelete`](../reference/javascript/define-config.md#parameters) table marks), shared-board RLS policies with abuse caps and cleanup, the [Storage fixture](../attachments/media-and-attachments.md#storage-policies), and the demo identities |

Only `0001_kizuna_init.sql` is selected by [`kizunasync init`](./cli.md#kizunasync-init). It is the machinery Kizuna adds to your own database, the ledgers, RPCs, and triggers, with no server of ours in the sync path. Do not copy the demo file into an application project: its [Storage policies](https://supabase.com/docs/guides/storage/security/access-control#access-policies) and public bucket are deliberately loose so the example runs unattended.

You should now see only `0001_kizuna_init.sql` in the `pack` array of `pack.manifest.json`, with `0002_example.sql` under `demo`.

## Provision another project

To provision a different application project, follow [Install Kizuna into a Supabase project](./install.md).

Copying the pack by hand generates no per-table [`_config`](../reference/sql-pack.md#kizunasync_config) rows and attaches no application-table [triggers](./whats-installed.md#the-per-table-hooks). Those come from the generated config migration.

## Next steps

- [Test offline behavior](../operations/test-offline-behavior.md)
- [What Kizuna installs](./whats-installed.md)
- [Install Kizuna into your Supabase project](./install.md)
- [SQL pack reference](../reference/sql-pack.md)
- [CLI](./cli.md)
