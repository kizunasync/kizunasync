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
- [Install Docker](https://docs.docker.com/get-started/get-docker/) or another Docker-compatible daemon the Supabase CLI supports. Without one, the stack runs on its [native runtime](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes) on Linux (amd64 and arm64) and on macOS 14 or later on Apple silicon.
- The prerequisites in [Troubleshooting](../operations/troubleshooting.md#before-you-begin), which lists what has to be running before a local service answers at all.

The Supabase CLI is a dev dependency of `@kizunasync/supabase-pack`, so a globally installed CLI is not required. Npm, pnpm, and Yarn are not the tested workspace managers for this repository. Supabase documents the stack itself in [Local development](https://supabase.com/docs/guides/local-development#cli) and its commands in the [CLI reference](https://supabase.com/docs/reference/cli/introduction). Every `bun run db:*` script below is a thin wrapper over one of those commands, so nothing here is a Kizuna-specific stack.

`packages/supabase-pack/supabase/config.toml` sets `[experimental] stack = true`, which turns on Supabase's [`supabase stack`](https://supabase.com/docs/guides/local-development/running-multiple-local-projects) commands. With that setting, `supabase start`, `supabase status`, and `supabase stop` run the stack commands, and so do the local targets of the `db`, `migration`, `test`, `gen`, `inspect`, `pull`, `storage`, `seed`, and `services` commands. The stack commands run a local project in Docker or as native processes, and they can run several local projects on one machine. They are an alpha feature, off by default, and need Supabase CLI 2.119.0 or later. Their flags and output can change between releases, because the CLI's compatibility promise does not cover them. The [CLI configuration reference](https://supabase.com/docs/guides/local-development/cli/config) documents the setting.

## 1. Start the stack

```sh
bun run db:start
```

This delegates to [`supabase start`](https://supabase.com/docs/reference/cli/supabase-start) in `packages/supabase-pack`, which runs the stack commands under the pack's configuration. On a fresh stack the enabled migrations and `seed.sql` are applied. The endpoints come from that workspace's [`config.toml`](https://supabase.com/docs/guides/local-development/cli/config#db.port), which pins non-default ports so this stack does not collide with another project's, and the stack commands use those ports as written:

| Service | Address |
|---|---|
| API ([PostgREST](https://postgrest.org/) and Auth) | `http://127.0.0.1:55321` |
| Postgres | `127.0.0.1:55322` |
| Studio | `http://127.0.0.1:55323` |

You should now see those three endpoints reported by the CLI. `bun run dev` also depends on the pack's `start` task, so it brings the stack up before the persistent app development tasks. That [Postgres](https://grokipedia.com/page/PostgreSQL) port is the one the CLI's [local connection fallback](./cli.md#database-connection) assembles a URL from.

Under the stack commands, Postgres starts at once. Every other service starts on its first request and stops after 60 seconds without one, and Studio stops after five idle minutes. The `--eager` flag starts every service and turns the idle stops off:

```sh
bun run db:start -- -- --eager
```

Bun consumes the first `--`, and Turbo forwards the arguments after the second one to `supabase start`.

The first start creates the local project and picks its runtime: Docker when the Docker daemon answers, then Podman, then the native runtime on Linux (amd64 and arm64) and on macOS 14 or later on Apple silicon. Supabase recommends Docker where a container engine is available and the native runtime where none is, as [Docker and native runtimes](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes) explains. To ask for the native runtime on that first start, pass `--runtime native`:

```sh
bun run db:start -- -- --runtime native
```

On Linux arm64 that start takes about 13 seconds, runs no container, and applies `0001_kizuna_init.sql`, `0002_example.sql`, and the seed. The local project keeps the runtime it was created with. Moving it to another runtime takes `supabase stack destroy`, which deletes that local project's data with no undo, followed by a new start.

`SUPABASE_EXPERIMENTAL_STACK` overrides the file for the command it is set on: `1` turns the stack commands on, and `0` turns them off. Turbo passes the variable through to the CLI, so this starts the classic local stack:

```sh
SUPABASE_EXPERIMENTAL_STACK=0 bun run db:start
```

Set the variable on `db:status`, `db:migrate`, `db:reset`, and `db:stop` as well while you work on the classic stack, because a command without it reads the file again. A local project the stack commands started keeps its data apart from one started without the setting, so the two never share rows. The `db-tests` job in [CI and CD](../operations/ci-cd.md#live-supabase-database-job) sets the variable to `0` and runs the classic stack.

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

The underlying [`supabase status`](https://supabase.com/docs/reference/cli/supabase-status) output lists the local endpoints and the development credentials. Treat the [service-role value](https://supabase.com/docs/guides/getting-started/api-keys#secret-keys-and-elevated-access) as a secret even though the stack is local: do not copy it into client code and do not commit it. Kizuna never needs it, as [What Kizuna installs](./whats-installed.md#grants) sets out grant by grant. The stack commands do not accept `-o` or `--output`; ask for `--output-format json` or `--env` when a script needs the values.

Those endpoints are loopback addresses, so a simulator reaches them and a physical device on your network does not. [Expo or a physical device cannot reach local services](../operations/troubleshooting.md#expo-or-a-physical-device-cannot-reach-local-services) covers swapping in your machine's LAN address.

You should now see the API, Postgres, and Studio URLs from the table above, plus the publishable and secret keys for the local stack.

## 4. Stop without losing data

```sh
bun run db:stop
```

This delegates to [`supabase stop`](https://supabase.com/docs/reference/cli/supabase-stop), which preserves the local state for a later start. Stopping is the right move when you are done for the day or want to free the ports. The stack commands do not accept `--no-backup`. Deleting a local project the stack commands created, data included, takes `supabase stack destroy`, which has no undo, so give it the same care as the reset below.

You should now see the stack's services stopped, whether they ran as containers or as native processes, and `bun run db:status` reporting the stack is not running.

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

Some pack tests and the `scratch:rebuild` script run a Postgres client or read memory inside the database container. They find that container through `KSYNC_DB_CONTAINER` when you set it, else the classic stack's `supabase_db_kizunasync`, else the single running container labelled `com.supabase.service=database`, since the stack commands name the database container per instance.

The native runtime runs no container. On it, `reapply-convergence` runs the `pg_dump` on your `PATH`, which has to match Postgres 17, and skips when there is none. `stamp-scale` reports its memory sample as unavailable. `scratch:rebuild` uses the `psql` on your `PATH`, the first thing it tries on every runtime.

Run the pack's `test:scale` script on the classic stack. The Postgres image the stack commands use, `ghcr.io/supabase/cli/postgres:17.11.0.002-r0`, runs that script's 1,000,000-row write far slower: its commit is still running after 19 minutes, where the classic stack finishes in about 47 seconds, even when it gets the classic stack's memory settings. Stop the running stack first, because both bind the ports `config.toml` pins:

```sh
bun run db:stop
SUPABASE_EXPERIMENTAL_STACK=0 bun run db:start
bun run --filter @kizunasync/supabase-pack test:scale
SUPABASE_EXPERIMENTAL_STACK=0 bun run db:stop
```

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
