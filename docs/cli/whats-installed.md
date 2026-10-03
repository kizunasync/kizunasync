---
title: What Kizuna installs
description: The kizunasync schema, internal tables, public RPCs, per-table triggers, provision ledger, and grants created by the current pack.
status: alpha
docType: reference
audience: app-developer
---

# What Kizuna installs

[`kizunasync init`](./cli.md#kizunasync-init) applies one installable pack file, `0001_kizuna_init.sql`, into a `kizunasync` schema in your Supabase project. It then emits a separate generated migration for your own tables. This page is the object inventory, and [What is installed in Supabase](../getting-started/how-kizuna-works.md#what-is-installed-in-supabase) gives the shorter picture of the same thing. [SQL pack](../reference/sql-pack.md) documents each object's columns, signature, and behavior, and [Local Supabase](./local-supabase.md#7-know-which-migrations-are-product-code) separates the pack file from the demo fixtures beside it.

![An insert into todos fires track_change, the change waits in _change_pending until _stamp_transaction numbers it at commit and moves it into _changelog, Realtime rings on kizunasync:todos, and then deprovision --purge removes the kizunasync schema and its triggers while your public tables stay.](/docs/images/pack-annex.svg)

## The kizunasync schema

Kizuna keeps its engine state in the `kizunasync` schema, which [`kizunasync init`](./cli.md#kizunasync-init) also adds to the project's [exposed schemas](https://supabase.com/docs/guides/api/using-custom-schemas#exposing-custom-schemas) so [PostgREST](https://postgrest.org/) will serve its RPCs. The pack does not alter application tables. The generated config migration attaches two triggers to each synced table. Those triggers queue each change for the changelog and [tombstone](../resources/glossary.md#tombstone) ledgers and emit [wake hints](../resources/glossary.md#wake-up). The pack writes the queued changes into those ledgers as the writing transaction commits. The triggers add no columns, constraints, indexes, or policies to your tables.

Alongside the schema the pack creates one role, `kizunasync_rls`, which is `nologin` and `NOBYPASSRLS`. The pack grants `authenticated` to that role, gives it `create` on the `kizunasync` schema, and grants the role itself to `postgres`. The role owns the helpers that touch application rows, so those helpers cannot [bypass Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security) the way a table owner normally would. That is what keeps your own policies authoritative while Kizuna's bookkeeping stays private.

## The internal tables

| Table | Purpose |
|---|---|
| [`_provisions`](../reference/sql-pack.md#kizunasync_provisions) | A partial lifecycle ledger. It records removable object rows for selected base objects and for generated per-table objects. A versioned installation may also carry `pack-file` rows with content hashes. The base SQL seeds object rows but no `pack-file` row, so [`kizunasync upgrade`](./cli.md#kizunasync-upgrade) refuses that state rather than reconciling it until a later provisioning run records file-level hashes. |
| [`_config`](../reference/sql-pack.md#kizunasync_config) | One row per synced table, holding its [sync mode, bucket column, key columns, conflict mode, and tombstone retention](./configuration.md). Written by `kizunasync init` and `kizunasync sync`, and read back by both. |
| [`_clients`](../reference/sql-pack.md#kizunasync_clients) | An optional device and session progress registry, populated only for tables with `register_clients` enabled and holding at most 100 registrations per user. |
| [`_settings`](../reference/sql-pack.md#kizunasync_settings) | The single global row: the [push policy](./configuration.md) (maximum batch size, whether atomic batches are required), the pull scan cap, the three job schedules, and the client, skew, and tombstone retention knobs. |
| [`_changelog`](../reference/sql-pack.md#kizunasync_changelog) | The append-only log of committed changes, each numbered as its transaction commits and labeled with the bucket value of the row it wrote. [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull) reads new rows from it, only the requested bucket values' rows on a bucketed table. |
| [`_tombstones`](../reference/sql-pack.md#kizunasync_tombstones) | One row per deleted record on a synced table, and per bucket value an update moved a record out of, kept until retention reaps it, which is what makes [deletes win](../sync/conflict-resolution.md#deletes) and tells a device that received a moved record from its old bucket to drop it. |
| [`_bucket_grants`](../reference/sql-pack.md#kizunasync_bucket_grants) | One row per user, table, and bucket value that user's pulls received a live row from. A tombstone reaches only a user who holds its pair, and a deleted row answers `DELETE_WINS` only to such a user. Grants are removed with their user, never by age. |
| [`_change_pending`](../reference/sql-pack.md#kizunasync_change_pending) | The queue the change-capture triggers write to inside a transaction. As the transaction commits, the pack numbers each queued change, writes it to `_changelog` or `_tombstones`, and removes it, so the table is empty outside an open transaction. |
| [`_stamp_marker`](../reference/sql-pack.md#kizunasync_stamp_marker) | One row per open transaction that has queued a change. Its deferred trigger numbers all of the transaction's queued changes once, at commit, and removes the row, so the table is empty outside an open transaction. |
| [`_verdicts`](../reference/sql-pack.md#kizunasync_verdicts) | The per-mutation replay ledger that stops a duplicate mutation id from being applied twice. It answers a replay only for the user who pushed the mutation, keeps no row copy, and loses entries older than `client_ttl_days` to `prune_clients`. Delivery itself stays at-least-once, as [Consistency model](../sync/consistency-model.md#retry-and-exactly-once-effect) explains. |
| [`_row_hlc`](../reference/sql-pack.md#kizunasync_row_hlc) | Per-row, per-column [last-writer-wins](../resources/glossary.md#column-last-writer-wins-column-lww) state, read only by tables whose `conflict_mode` is [`hlc`](../sync/conflict-resolution.md#hlc-mode). |
| [`_conflict_journal`](../reference/sql-pack.md#kizunasync_conflict_journal) | An optional server-side audit of overwritten column values, enabled per table by the [`conflict_journal`](./configuration.md#kizunasync_config) column. Pull may attach matching rows as optional `conflicts`, and authenticated clients have no `SELECT` on it. |
| [`_reap_state`](../reference/sql-pack.md#kizunasync_reap_state) | A one-row watermark recording how far the tombstone retention job has reaped, which is the floor a stale [cursor](../resources/glossary.md#cursor) falls below. |
| [`attachments`](../reference/sql-pack.md#kizunasyncattachments) | Metadata for uploaded files. The bytes live in Supabase Storage, and this table carries the reference, digest, size, media type, and the synced table whose row references the object. See [Media and attachments](../attachments/media-and-attachments.md). |

One sequence, [`_change_seq`](../reference/sql-pack.md#kizunasync_change_seq), supplies the changelog and tombstone ordering, and the pack draws from it only as a writing transaction commits.

The pack creates twelve indexes on those tables: `_clients_user_id_idx` and `_clients_last_seen_idx` on `_clients`, `_changelog_seq_idx` and `_changelog_bucket_idx` on `_changelog`, `_tombstones_seq_idx` and `_tombstones_bucket_idx` on `_tombstones`, `_change_pending_row_idx` on `_change_pending`, `_conflict_journal_row_idx`, `_conflict_journal_winner_seq_idx`, and `_conflict_journal_pending_idx` on `_conflict_journal`, `_verdicts_recorded_at_idx` on `_verdicts`, and the unique `attachments_object_uidx` on `attachments`, which is the [idempotency](https://grokipedia.com/page/Idempotence) key for the confirm call.

`attachments` is the one pack table with Row Level Security enabled, under three owner-scoped policies: rows are visible to their owner, insertable by their owner, and updatable by their owner. Supabase documents the mechanism in [What a policy does](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does), and these three are the only policies Kizuna writes on its own tables. The other bookkeeping tables need no policies, because `authenticated` holds no table privileges on them at all. Policies on the Storage objects themselves stay yours, under [Storage access control](https://supabase.com/docs/guides/storage/security/access-control#access-policies).

## The public RPCs

Authenticated clients may execute exactly five functions: [`kizunasync.pull`](../reference/sql-pack.md#kizunasyncpull), [`kizunasync.push`](../reference/sql-pack.md#kizunasyncpush), [`kizunasync.attachment_confirm`](../reference/sql-pack.md#kizunasyncattachment_confirm), [`kizunasync.attachment_metadata`](../reference/sql-pack.md#kizunasyncattachment_metadata), and [`kizunasync.attachment_vacuum`](../reference/sql-pack.md#kizunasyncattachment_vacuum). They are [Postgres](https://grokipedia.com/page/PostgreSQL) functions reached through supabase-js [`rpc`](https://supabase.com/docs/reference/javascript/rpc), and the five together are the whole [public RPC surface](../resources/glossary.md#public-rpc-surface). [`createRpcRemote`](../reference/javascript/create-rpc-remote.md) wraps the sync pair, and [`createSupabaseTransfer`](../reference/javascript/create-supabase-transfer.md) uses the three attachment calls.

All five are [`SECURITY DEFINER`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker), and they run with elevated rights only to manage Kizuna's own bookkeeping. For `pull` and `push`, application-row reads and writes are delegated to helpers owned by the `NOBYPASSRLS` role `kizunasync_rls`, so the caller's own policies decide what that caller can see or change. Supabase describes the same containment pattern in [Use security definer functions](https://supabase.com/docs/guides/database/postgres/row-level-security#use-security-definer-functions), and [Server-side validation](../sync/server-side-validation.md#security-boundary) states the boundary that role draws from the sync side.

## The rest of the functions

The pack creates 76 functions in the `kizunasync` schema. Beyond the five public RPCs they fall into five families, and none of them is executable by `authenticated`; five are executable by `service_role` as an operator surface.

| Family | Functions |
|---|---|
| Change capture | [`track_change`](../reference/sql-pack.md#kizunasynctrack_change), [`track_delete`](../reference/sql-pack.md#kizunasynctrack_delete), [`_arm_stamp`](../reference/sql-pack.md#kizunasync_arm_stamp), [`_stamp_transaction`](../reference/sql-pack.md#kizunasync_stamp_transaction), [`_seed_changelog`](../reference/sql-pack.md#internal-helpers), [`_relabel_changelog`](../reference/sql-pack.md#internal-helpers), [`_rekey_changelog`](../reference/sql-pack.md#internal-helpers), `_pk_text`, `_pk_text_sql`, `_row_pk` |
| Maintenance and status (`service_role`) | [`reap_tombstones`](../reference/sql-pack.md#kizunasyncreap_tombstones), [`compact_changelog`](../reference/sql-pack.md#kizunasynccompact_changelog), [`prune_clients`](../reference/sql-pack.md#kizunasyncprune_clients), [`_schedule_jobs`](../reference/sql-pack.md#kizunasync_schedule_jobs), [`jobs_status`](../reference/sql-pack.md#kizunasyncjobs_status) |
| Cursor, clock, and grammar | `_clamp_hlc`, `_compare_hlc`, `_cursor_high_water`, `_cursor_holes`, `_cursor_start`, `_encode_cursor`, `_encode_continuation`, `_reap_horizon`, `_min_schema_version`, `_jwt_session_id`, `_is_cron_schedule` |
| Decide and apply | `_decide_mutation`, `_process_mutation`, `_apply_upsert`, `_apply_update_masked`, `_apply_increment`, `_apply_array_union`, `_apply_array_remove`, `_apply_transforms`, `_apply_delete`, `_apply_hlc`, `_rejected`, `_row_matches_params`, `_tombstone_in_buckets`, `_render_user_row`, `_render_user_row_projected`, `_lock_user_row`, `_caller_role`, `_readable_columns`, `_writable_columns`, `_normalize_cell`, `_column_write_denied`, `_key_columns`, `_key_types`, `_is_key_type`, `_pk_object`, `_pk_predicate`, `_pk_locator` |
| Bookkeeping | `_require_rpc_context`, `_lookup_verdict`, `_record_verdict`, `_record_bucket_grants`, `_row_hlc_lock`, `_row_hlc_merge`, `_journal_overwrites`, `_register_client`, `_conflicts_for_page`, `_pull_envelope`, `_pull_gate`, `_pull_horizon`, `_pull_candidates`, `_pull_page`, `_pull_impl`, `_push_guard`, `_is_canonical_pk`, `_push_impl` |

## The per-table hooks

Every synced table gets two [row triggers](https://supabase.com/docs/guides/database/postgres/triggers#trigger-after-changes-are-made), attached by [`kizunasync init`](./cli.md#kizunasync-init) or [`kizunasync sync`](./cli.md#kizunasync-sync) and never by the pack itself. `kizunasync_track_change` fires after an insert or update, and `kizunasync_track_delete` fires after a delete. Each one queues its change in `_change_pending`. The transaction's first queued change also fires the pack's own statement trigger on that table, `kizunasync_arm_stamp`, which inserts one `_stamp_marker` row, and as the transaction commits that row's deferred trigger, `kizunasync_stamp_transaction`, numbers every queued change and writes it to `_changelog`, or to `_tombstones` for a delete and for the bucket value an update moved a row out of. The two per-table triggers also send a contentless [broadcast from the database](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database) on the topic `kizunasync:<table>`. Kizuna puts the table name in that message and never row data, so a connected client learns only that it should [pull](../reference/javascript/pull-once.md) for itself.

## Realtime and scheduled jobs

The pack adds one policy outside its own schema: `kizunasync wakeup receive` on `realtime.messages` lets an authenticated client select broadcast rows on a `kizunasync:%` topic. Supabase calls that a broadcast read policy in [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#broadcast-and-presence-read), and Kizuna narrows it to its own topic prefix. It changes no publication, and there is no matching send policy, because the `SECURITY DEFINER` trackers emit through `realtime.send`.

The pack tries to enable [`pg_cron`](https://supabase.com/docs/guides/cron#how-does-cron-work) itself, running Supabase's own [documented install](https://supabase.com/docs/guides/cron/install): `create extension if not exists pg_cron with schema pg_catalog`, and it grants nothing on the `cron` schema, because the Supabase image gives `postgres` what the jobs need when the extension is created. The install is guarded so it stays clean on a server that will not give it: refused or missing, the pack installs regardless. Where the extension ends up present, [`_schedule_jobs()`](../reference/sql-pack.md#kizunasync_schedule_jobs) schedules three jobs from [`_settings`](../reference/sql-pack.md#kizunasync_settings): `kizunasync-reap-tombstones` (default `16 3 * * *`), `kizunasync-compact-changelog` (default `47 3 * * *`), and `kizunasync-prune-clients` (default `31 3 * * *`). All three functions stay callable by hand, through [`kizunasync jobs run`](./cli.md#kizunasync-jobs), whether or not `pg_cron` ends up present. The config migration that [`init`](./cli.md#kizunasync-init) and [`sync`](./cli.md#kizunasync-sync) generate carries its own gate ahead of the tables it provisions, and refuses to apply unless `pg_cron` is present or the run passed `--allow-no-cron`.

## The provision ledger

`_provisions` carries two kinds of row. Object rows are the ones teardown reads, and `pack-file` rows are the ones hash reconciliation reads. A pack file whose ledgered hash differs from the shipped file's is reconciled by `kizunasync init`'s wizard or by [`kizunasync upgrade --reapply --yes`](./cli.md#kizunasync-upgrade), either of which re-applies the pack and records the shipped file's hash. A re-apply refreshes the arguments and version of each object row the pack seeds and leaves every other row in the `kizunasync` schema as it finds it. The ledger is deliberately partial. The base pack records its functions, the Realtime policy, the cron jobs, and the owner role. Generated per-table migrations record their triggers and config rows. Nothing records the schema itself, the bookkeeping tables, the indexes, or the sequence. All four therefore survive [`kizunasync deprovision`](./cli.md#kizunasync-deprovision). The triggers on `_change_pending` and `_stamp_marker` have no rows of their own, because dropping `_arm_stamp` and `_stamp_transaction` removes them. [Remove](./removing.md#3-check-what-remains) states the same thing from the operator's side. [`kizunasync status`](./cli.md#kizunasync-status) and [`kizunasync upgrade`](./cli.md#kizunasync-upgrade) compare the full-file hashes in `pack-file` rows.

Base pack rows carry `pack_version` `0.2.6-alpha.3`, the version every workspace package shares.

## Grants

Every grant is scoped to what the client and the maintenance jobs need. Supabase treats grants and policies as two separate gates, described in [Grants and policies](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies), and Kizuna closes the grant side first. The pack never requires your service-role key, in your app, in your CI, or in the [CLI](./cli.md) itself.

| Grantee | Access |
|---|---|
| `authenticated` | `usage` on the `kizunasync` schema; no table privileges on any bookkeeping table, including `_changelog`, `_verdicts`, and `_row_hlc`; `select` on `attachments`, scoped by the owner `SELECT` policy; `execute` on `pull`, `push`, `attachment_confirm`, `attachment_metadata`, and `attachment_vacuum` only. INSERT and UPDATE on `attachments` are never granted: `attachment_confirm` and `attachment_vacuum` are the writers. |
| `service_role` | `usage` on the `kizunasync` schema; `select` on the bookkeeping tables for operational inspection: `_changelog`, `_tombstones`, `_config`, `_settings`, `_reap_state`, `_clients`, `_provisions`, `_verdicts`, `_row_hlc`, `_conflict_journal`, `_bucket_grants`, and `attachments`; `execute` on `reap_tombstones()`, `compact_changelog()`, `prune_clients()`, and `_schedule_jobs()`, which [`kizunasync jobs`](./cli.md#kizunasync-jobs) runs over a service connection, plus `jobs_status()`, which reads the same jobs for a Data API caller since `cron` itself is never exposed. |
| `kizunasync_rls` | `execute` on `_require_rpc_context()`, plus ownership of the helpers that read and write application rows under the caller's policies. |

A client cannot write into `_change_pending`, `_changelog`, or `_tombstones`. The change-capture triggers are `SECURITY DEFINER`, and the pack grants no `INSERT`. A client also has no `USAGE` on the change sequence, and no access to `_clients` or `_provisions`. Device registration goes through the definer `_register_client` path inside `pull` and `push`. Most internal helpers, the apply helpers among them, require a transaction-local gate that only `pull` and `push` set. A lone Data API call to an apply helper therefore fails closed. The four maintenance functions and `jobs_status` refuse every claim set that is not `role: service_role`. [SQL pack grants](../reference/sql-pack.md#grants-and-security) has the full detail.

## Related pages

- [Install Kizuna into your Supabase project](./install.md)
- [Manage synced tables](./manage-synced-tables.md)
- [Upgrade an installed pack](./upgrading.md)
- [Remove ledgered objects](./removing.md)
- [Configuration](./configuration.md)
- [SQL pack reference](../reference/sql-pack.md)
- [CLI](./cli.md)
