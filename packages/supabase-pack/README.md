<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/supabase-pack</span>
</h1>

Private monorepo workspace for Kizuna's SQL pack and local Supabase project. No runtime export. Private workspace.

## What this is

`pack.manifest.json` classifies migrations:

- `0001_kizuna_init.sql`: the only installable pack file
- Object-ledger rows use `pack_version = '0.2.6-alpha.1'`, matching this workspace's private pre-release version
- `0002_example.sql`: the local demo fixture

The base pack creates the `kizunasync` schema, its bookkeeping tables and sequence, and the `kizunasync_rls` role. It also creates trigger functions, sync and attachment RPCs, least-privilege grants, Realtime policies, and guarded `pg_cron` jobs. Bookkeeping includes the opt-in server-side `_conflict_journal`. Pull may attach matching journal rows as an optional `conflicts` array (D-conflict-journal-visibility), omitted when empty. Authenticated clients have no `SELECT` on that table. The Rust `kizunasync` CLI generates per-project `_config` rows and application-table triggers separately.

Retention is driven by `kizunasync._settings`: push policy (`max_batch_size`, 500 on a fresh install, and `require_atomic`), the pull scan cap `max_pull_scan` (5000 candidates per page), three job schedules (defaults `16 3 * * *`, `47 3 * * *`, `31 3 * * *`), and retention knobs `client_ttl_days` (90), `hlc_max_skew_ms` (5000), `tombstone_ttl_days` (30). `kizunasync._schedule_jobs()` is the only writer of the three `pg_cron` jobs, so re-applying the pack reinstates the operator's schedules instead of overwriting them. `pg_cron` is shared infrastructure: not ledgered, and `kizunasync deprovision` never drops it.

Authenticated clients can execute five functions: `pull`, `push`, `attachment_confirm`, `attachment_metadata`, and `attachment_vacuum`. `pull` and `push` are postgres-owned `SECURITY DEFINER` wrappers. Application-row operations run through helpers owned by `kizunasync_rls` (`NOBYPASSRLS`, inherits `authenticated`), so application-table RLS remains the authorization boundary. Bucket parameters narrow a pull; they do not replace RLS.

`service_role` is the operator surface: execute on the retention and schedule functions and `jobs_status()`, plus read-only `select` on every bookkeeping table except the `_change_pending` queue, and on `kizunasync.attachments`. `anon` holds none of those, and `authenticated` holds only `select` on `kizunasync.attachments`, under its owner policies. The five operator functions accept a `service_role` JWT and refuse every other claim set, so an operator can call them over the Data API; `jobs_status()` exists because PostgREST does not expose the `cron` schema.

The `_provisions` object ledger is deliberately partial. Base functions, policies, cron jobs, and the owner role are ledgered; base tables, indexes, the sequence, and schema are not. `kizunasync deprovision` removes ledgered objects; `kizunasync deprovision --purge` drops the schema itself.

This package uses PolyForm Shield 1.0.0. The rest of the monorepo is Apache-2.0. See root [GOVERNANCE.md](../../GOVERNANCE.md).

## Get started

From the repository root, with the pinned Bun workspace:

```sh
bun run db:start
bun run db:migrate
bun run db:status
bun run db:stop
```

`bun run db:reset` is destructive: it deletes local rows and replays migrations. Run it only with explicit authorization.

Studio: `http://127.0.0.1:55323`. API: `http://127.0.0.1:55321`. Postgres: `127.0.0.1:55322`.

## Tests

Package tests cover SQL text audits and, when the configured local Postgres instance is reachable, live RPC/security behavior. A green run with the database absent contains skips and is not evidence that the live SQL suite ran.

`bun run --filter @kizunasync/supabase-pack scratch:rebuild` builds the disposable `kizunasync_scratch` database from nothing, applying the vendor stub and then every migration in name order, which is where pack SQL under development is verified before it reaches a stack.

## Related

- [SQL pack reference](../../docs/reference/sql-pack.md)
- [Local Supabase guide](../../docs/cli/local-supabase.md)
- [CLI](../../docs/cli/cli.md)
