<h1 align="center" style="display: flex; align-items: center; justify-content: center; gap: 12px;">
  <img src="../../branding/mark-dark-rounded.png" width="40"/>
  <span style="margin: 0; font-size: 1.2em;">@kizunasync/sync-inspector</span>
</h1>

Read-only window into your local Kizuna stack. Its server-side snapshot reads `public.todos`, `_clients`, `_changelog`, `_tombstones`, rejected `_verdicts`, `_config`, the provision ledger, `_settings`, the read-only `kizunasync.jobs_status()` function, `_reap_state`, `_conflict_journal`, and `attachments`. A browser-side Realtime doorbell or slow poll refreshes the page. Neither path writes application data.

Runs against the local `55xxx` Supabase stack from [`@kizunasync/supabase-pack`](../../packages/supabase-pack/README.md). Local development tooling only.

## What it shows

Panels are fetched in parallel under the configured local service role:

- **Todos**: `public.todos`, ordered by `updated_at` descending
- **Changelog**: latest ten `_changelog` upserts merged with latest `_tombstones` deletes
- **Clients**: up to 50 `_clients` rows by `last_seen`
- **Rejected verdicts**: latest ten `_verdicts` with a rejected outcome
- **Settings**: every column of the single `_settings` row; job schedules link to crontab.guru
- **Jobs**: the three pack jobs through `kizunasync.jobs_status()`. Empty when `pg_cron` is not installed
- **Retention**: `_reap_state` watermark, tombstone counts by table, total `_changelog` rows
- **Conflict journal**: latest ten `_conflict_journal` rows
- **Attachments**: latest ten `kizunasync.attachments` rows. The pack grants `service_role` `select` on `kizunasync.attachments`, so the panel reads it over the service connection without a manual grant

The status strip also summarizes `_config`, the client fleet, and the newest ledger `pack_version`. When the stack is unreachable or a query errors, the affected panel shows a message rather than failing the whole page.

## Prerequisites

- Local Supabase stack on the `55xxx` ports: `bun run db:start` from the repo root
- Demo migrations applied so `public.todos` and the `kizunasync` schema exist: `bun run db:migrate`

See [Run a local Supabase stack](../../docs/cli/local-supabase.md).

## Get started

Copy the repo-root [`.env.example`](../../.env.example) to `.env`, from the repository root:

```sh
cp .env.example .env
```

The example file holds placeholders. Run `bun run db:status` for per-stack keys, then fill the inspector block in the repo-root `.env`:

```sh
INSPECTOR_SUPABASE_URL=http://127.0.0.1:55321
INSPECTOR_SUPABASE_SERVICE_ROLE_KEY=<secret key from bun run db:status>
NEXT_PUBLIC_INSPECTOR_SUPABASE_URL=http://127.0.0.1:55321
NEXT_PUBLIC_INSPECTOR_SUPABASE_PUBLISHABLE_KEY=<publishable key from bun run db:status>
```

```sh
bun run --filter @kizunasync/sync-inspector dev
```

Open `http://127.0.0.1:3001` (port 3001 so it does not collide with the example app). `dev` and `start` pass `-H 127.0.0.1` rather than Next's default `0.0.0.0`, because the server-side snapshot holds a service-role key that bypasses RLS: nothing else on the same network should be able to reach the port. With no `INSPECTOR_SUPABASE_SERVICE_ROLE_KEY`, the page renders setup instructions instead of the panels.

## Why the service role

The inspector uses the local [service role](https://supabase.com/docs/guides/api/api-keys#secret-keys-and-elevated-access) so one server-side snapshot can read private bookkeeping tables and rows hidden by application RLS. The key has no `NEXT_PUBLIC_` prefix, and `lib/supabase-inspector.ts` reads it only from the server environment with no in-code fallback. The browser-side live-refresh component uses the publishable key and an anonymous session instead.

Keep the key in the repo-root `.env`, never commit it, and do not import that module into a Client Component.

## Related

- [Run a local Supabase stack](../../docs/cli/local-supabase.md)
- [Test offline behavior](../../docs/operations/test-offline-behavior.md)
- [Management and tooling surfaces](../../docs/resources/roadmap.md#management-and-tooling-surfaces)
