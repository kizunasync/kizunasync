---
title: SQL pack
description: Tables, sequences, public RPCs, and maintenance functions provisioned by the Kizuna SQL pack.
status: alpha
docType: reference
audience: app-developer
---

# SQL pack

The installable SQL pack is one migration, `packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql`. It creates the `kizunasync` schema, one database role, thirteen tables, one sequence, twelve secondary indexes, sixty-four functions, one trigger on its own `_change_pending` table, four [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security#what-a-policy-does) policies, three guarded `pg_cron` jobs, and a ledger of what a teardown may remove. Everything it installs lives in the Supabase project that runs it.

[Tables](#tables) gives every column of the bookkeeping tables. [Functions](#functions) gives the signature, the return shape, and the errors of each public RPC and each maintenance function. [Triggers](#triggers) and [Scheduled jobs](#scheduled-jobs) cover what the pack runs without a caller. [Grants and security](#grants-and-security) and [Local ports](#local-ports) say who may call what, and [Pack vs demo](#pack-vs-demo) and [Realtime doorbell](#realtime-doorbell) mark the edges of what the migration installs.

The base file never alters an application table. Per-table [triggers](./sql-pack.md#triggers) and [`_config`](#kizunasync_config) rows come from the separate config migration that [`kizunasync init`](../cli/cli.md#kizunasync-init) and [`kizunasync sync`](../cli/cli.md#kizunasync-sync) generate from the tables the CLI proposed. [`kizunasync deprovision`](../cli/cli.md#kizunasync-deprovision) acts on ledgered rows only, so the schema, the bookkeeping tables, their indexes, and the sequence stay behind.

| Name | Kind | Purpose |
|------|------|---------|
| `kizunasync` | schema | Namespace for every object below, exposed through the Data API alongside `public`. |
| `kizunasync_rls` | role | `NOBYPASSRLS` member of `authenticated` that owns the application-row helpers. |
| [`kizunasync._provisions`](#kizunasync_provisions) | table | Partial object/file ledger used by upgrades and deprovision. |
| [`kizunasync._change_seq`](#kizunasync_change_seq) | sequence | One global sequence across all synced tables. |
| [`kizunasync._config`](#kizunasync_config) | table | Per-project table configuration: sync mode, bucket, TTL, conflict mode. |
| [`kizunasync._clients`](#kizunasync_clients) | table | Optional client/session registry for cursors, mutation progress, and staleness. |
| [`kizunasync._changelog`](#kizunasync_changelog) | table | Zero-ALTER change tracking, one row per committed `(table, pk)` write, labeled with the row's bucket value. |
| [`kizunasync._tombstones`](#kizunasync_tombstones) | table | Sync removal markers for rows deleted from application tables or moved out of a bucket value. |
| [`kizunasync._bucket_grants`](#kizunasync_bucket_grants) | table | The bucket values each user received live rows from, which decide the tombstones and `DELETE_WINS` verdicts that user gets. |
| [`kizunasync._change_pending`](#kizunasync_change_pending) | table | Changes a writing transaction has queued, numbered and removed as it commits. |
| [`kizunasync._row_hlc`](#kizunasync_row_hlc) | table | Per-row, per-column HLC state for `conflict_mode = 'hlc'` tables. |
| [`kizunasync._conflict_journal`](#kizunasync_conflict_journal) | table | Optional server-side record of overwritten column values; pull may attach matching rows as `conflicts`. |
| [`kizunasync._verdicts`](#kizunasync_verdicts) | table | Per-mutation replay map for an exactly-once apply effect across retries, answered for the pushing user only. |
| [`kizunasync._reap_state`](#kizunasync_reap_state) | table | Singleton watermark for the tombstone reaper. |
| [`kizunasync._settings`](#kizunasync_settings) | table | Single-row global push policy, pull scan cap, retention knobs, and job schedules. |
| [`kizunasync.attachments`](#kizunasyncattachments) | table | Metadata for uploaded files; bytes live in Storage. |
| [`kizunasync.pull`](#kizunasyncpull) | RPC | Fetches rows and tombstones since a cursor, RLS-bounded. |
| [`kizunasync.push`](#kizunasyncpush) | RPC | Applies a batch and answers a repeated mutation ID from the verdict ledger. |
| [`kizunasync.reap_tombstones()`](#kizunasyncreap_tombstones) | maintenance fn | Deletes tombstones and unsynced bookkeeping rows past their TTL. |
| [`kizunasync.compact_changelog()`](#kizunasynccompact_changelog) | maintenance fn | Removes superseded changelog rows and the conflict-journal rows whose winning row is gone. |
| [`kizunasync.prune_clients()`](#kizunasyncprune_clients) | maintenance fn | Deletes client rows stale past `client_ttl_days`, verdicts older than it, and the bucket grants of deleted users. |
| [`kizunasync._schedule_jobs()`](#kizunasync_schedule_jobs) | maintenance fn | Writes the three cron jobs from `_settings`. |
| [`kizunasync.jobs_status()`](#kizunasyncjobs_status) | operator fn | Reads the three jobs' schedule and latest run for a Data API caller, since `cron` itself is never exposed. |
| [`kizunasync.attachment_confirm`](#kizunasyncattachment_confirm) | RPC | Confirms an uploaded attachment. |
| [`kizunasync.attachment_metadata`](#kizunasyncattachment_metadata) | RPC | Reads integrity metadata for an object a peer can see through RLS. |
| [`kizunasync.attachment_vacuum`](#kizunasyncattachment_vacuum) | RPC | Deletes attachment metadata after removal. |
| [`kizunasync.track_change()`](#kizunasynctrack_change) | trigger fn | Queues upserts in `_change_pending`, and a tombstone for the old bucket value when a write moves the row; sends the doorbell. |
| [`kizunasync.track_delete()`](#kizunasynctrack_delete) | trigger fn | Queues deletes in `_change_pending`, drops the row's `_row_hlc` entry, and sends the doorbell. |
| [`kizunasync._stamp_change()`](#kizunasync_stamp_change) | trigger fn | Numbers each queued change at commit and writes it to `_changelog` or `_tombstones`. |
| [Internal helpers](#internal-helpers) | 54 functions | The cron grammar check, the changelog seed and relabel, the cursor codec, the column-privilege probes, the typed cell comparison, the apply primitives, the decision layer, and the pull and push engines. `track_change`, `track_delete`, and `_stamp_change` are also listed under [Triggers](#triggers). |
| [`kizunasync-reap-tombstones`](#scheduled-jobs) | cron job | `reap_tombstones()` on `_settings.reap_schedule`, default `16 3 * * *`. |
| [`kizunasync-compact-changelog`](#scheduled-jobs) | cron job | `compact_changelog()` on `_settings.compact_schedule`, default `47 3 * * *`. |
| [`kizunasync-prune-clients`](#scheduled-jobs) | cron job | `prune_clients()` on `_settings.client_prune_schedule`, default `31 3 * * *`. |
| [Grants and security](#grants-and-security) | security | Role grants and RLS policies for the `kizunasync` schema. |

## Tables

All thirteen tables live in `kizunasync`. Column defaults, nullability, and constraints below are the ones the migration declares; the base pack modifies no table in `public`.

### `kizunasync._provisions`

Ledger used for [idempotency](https://grokipedia.com/page/Idempotence) and teardown. It is not a complete inventory of every base-pack object: the pack seeds function, policy, cron, and role rows; generated per-table migrations add trigger and config rows; the CLI adds `pack-file` rows. [`kizunasync deprovision`](../cli/cli.md#kizunasync-deprovision) acts only on these rows, which is why [Remove](../cli/removing.md) reports leftovers as expected rather than as an error.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `bigint` (identity) | No | Primary key, generated always as identity. |
| `object_kind` | `text` | No | Kind discriminator. The pack and the CLI write `function`, `policy`, `cron`, `role`, `trigger`, `config`, and `pack-file`. |
| `object_name` | `text` | No | Fully qualified object name. |
| `content_hash` | `text` | No | Pack identity key. Meaning depends on `object_kind`: object rows (function, policy, cron, role, trigger) store the md5 of the object's base name, not the body, so editing a function body does not change the hash; `config` rows store the md5 of the `table:sync_mode:bucket_column` triple; `pack-file` rows store the md5 of the file's full SQL, which is what [`kizunasync upgrade`](../cli/cli.md#kizunasync-upgrade) reconciles. |
| `pack_version` | `text` | No | Fixed-group version token. The base migration seeds `0.2.6-alpha.1` on every row, matching this workspace's own pre-release version. |
| `created_at` | `timestamptz` | No | Default `now()`. |
| `object_args` | `text` | Yes | For `object_kind = 'function'`, the identity argument signature, so a teardown drops the exact overload. `NULL` for every other kind. |

Indexes and constraints: primary key `id`; unique `(object_kind, object_name)`.

The migration seeds 69 rows: 64 functions, the `kizunasync wakeup receive` policy on `realtime.messages`, the three cron jobs, and the `kizunasync_rls` role. On a conflict with a row the ledger already holds, the seed refreshes `object_args` and `pack_version` from the migration.

### `kizunasync._change_seq`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
create sequence if not exists kizunasync._change_seq as bigint cache 1;
```

One global sequence across all synced tables. Per-table sequences would forfeit cross-table writes-follow-reads ordering, which [Consistency model](../sync/consistency-model.md#the-four-session-guarantees) states as a session guarantee. Only [`_stamp_change()`](#kizunasync_stamp_change) draws from it, as the writing transaction commits. The sequence keeps `cache 1`, because a cached block of numbers would let a later draw hand out a value below one that is already visible.

### `kizunasync._config`

Per-project table configuration, empty in the pack itself. `kizunasync init` upserts one row per synced table it proposed, and `kizunasync sync` adds and removes rows afterwards. These rows are the [configuration record](../cli/configuration.md) the CLI reads back on every later run.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `table_name` | `text` | No | Primary key; the unqualified name of a table in `public`. |
| `sync_mode` | `text` | No | `'pull-only'` or `'read-write'`, checked. A push against a `pull-only` table raises `KZP01`. |
| `bucket_column` | `text` | Yes | Declared owner or tenant column, matched by [pull](#kizunasyncpull) params. |
| `soft_delete_column` | `text` | Yes | Application soft-delete marker. Ordinary row data to the pack; the client guard is what refuses a hard delete. |
| `tombstone_ttl_days` | `integer` | Yes | Retention the reaper enforces for this table's tombstones. `NULL` inherits `_settings.tombstone_ttl_days`, the project default. |
| `min_schema_version` | `integer` | No | Minimum client schema version. Default `1`. |
| `created_at` | `timestamptz` | No | Default `now()`. |
| `conflict_mode` | `text` | No | `'arrival'` or `'hlc'`, checked. Default `'arrival'`. |
| `register_clients` | `boolean` | No | Opt in to device registration in `_clients`. Default `false`. |
| `conflict_journal` | `boolean` | No | Opt in to server-side loser-value recording. Default `false`. |

Indexes and constraints: primary key `table_name`; check on `sync_mode`; check on `conflict_mode`. The `create table` statement declares `conflict_journal` itself, and no later `add column` adds it.

### `kizunasync._clients`

`_clients` is an optional client registry, and it tracks cursor progress, last mutation, schema version, and staleness. `pull` and `push` write it through the `SECURITY DEFINER` helper `_register_client`. They write it only when the response carries no signal, a requested table has `register_clients = true`, and the request carries a `client_id` or the JWT a `session_id` claim. The table is the retention floor for [`compact_changelog()`](#kizunasynccompact_changelog) and the deletion source for [`prune_clients()`](#kizunasyncprune_clients). Exactly-once mutation replay comes from [`_verdicts`](#kizunasync_verdicts), not from this table.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `client_id` | `uuid` | No | Primary key; the request's `client_id` argument when it carries one, else the JWT `session_id` claim. |
| `user_id` | `uuid` | No | The caller's `auth.uid()` at registration. |
| `cursor` | `text` | No | Opaque cursor token as `pull` last returned it, a checkpoint or a continuation. Default `'0'`. |
| `last_mutation_id` | `uuid` | Yes | The mutation id of the last verdict `push` applied, read by [`kizunasync status`](../cli/cli.md#kizunasync-status) as a per-client watermark. |
| `schema_version` | `integer` | No | Client's declared schema version. Default `1`. |
| `last_seen` | `timestamptz` | No | Default `now()`, refreshed on every registration. |

Indexes and constraints: primary key `client_id`; indexes `(user_id)` and `(last_seen)`. `_register_client` rejects a registration whose user is not `auth.uid()`, and one whose session is not the JWT `session_id`. Both come back with SQLSTATE `42501`. The table has no Row Level Security and grants clients nothing, so the `DEFINER` helper that writes it checks the caller itself. The helper refuses a caller-supplied `client_id` that already belongs to another user the same way, and it never reassigns that id silently, so a client that resets its local store registers under a new `client_id` rather than the one the previous user owns. A user keeps at most 100 registrations: each registration deletes that user's least recently seen rows beyond the 100 most recent, never the row it wrote.

### `kizunasync._changelog`

`_changelog` is zero-ALTER change tracking: one row per committed `(table, pk)` write, stamped with the writing transaction id. The [`track_change()`](#kizunasynctrack_change) trigger queues the write, and [`_stamp_change()`](#kizunasync_stamp_change) numbers it and writes the row as the writing transaction commits. Each row carries the bucket value of the row it wrote, so a pull of a bucketed table reads only the rows labeled with a value it requests, through the `(table_name, bucket_value, seq)` index, and never scans another tenant's changes.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `seq` | `bigint` | No | From `_change_seq`, drawn by `_stamp_change` at commit. No default. |
| `table_name` | `text` | No | The application table the write landed in. |
| `pk` | `uuid` | No | The row's `id`. |
| `op` | `text` | No | `'upsert'` or `'delete'`, checked. `_stamp_change` writes `'upsert'`. |
| `xid` | `xid8` | No | The writing transaction's `pg_current_xact_id()`, which the pull horizon tests against its snapshot. |
| `arrived_at` | `timestamptz` | No | Default `clock_timestamp()`. `_stamp_change` copies the time the change was queued, so the column keeps the write time. |
| `bucket_value` | `text` | Yes | The written row's `_config.bucket_column` value as text, the way `->>` renders it in UTC; `NULL` on an unbucketed table. |

Indexes and constraints: primary key `(table_name, pk, seq)`; index `(seq)`; index `(table_name, bucket_value, seq)`.

### `kizunasync._tombstones`

`_tombstones` holds one removal marker per application row and bucket value the row left. `track_delete` queues a delete, and `track_change` queues one for the old value when a write moves a row to another bucket value. `_stamp_change` upserts here as the writing transaction commits. A pull of a bucketed table reads only the markers of the values it requests, through the `(table_name, bucket_value, seq)` index, and never scans another tenant's deletes. On conflict, `_stamp_change` refreshes `seq`, `deleted_at`, `xid`, and `bucket_snapshot`, so the [fencing](../resources/glossary.md#fencing) horizon sees a re-delete. Because the bucket value is part of the key, a move-out and a later delete of the same row keep one marker each. An application soft-delete column stays ordinary row data and produces no tombstone.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `table_name` | `text` | No | The application table the row was deleted from. |
| `pk` | `uuid` | No | The deleted row's `id`. |
| `seq` | `bigint` | No | From `_change_seq`, drawn by `_stamp_change` at commit. No default. |
| `deleted_at` | `timestamptz` | No | Default `now()`. |
| `xid` | `xid8` | No | The deleting transaction's `pg_current_xact_id()`. |
| `bucket_snapshot` | `jsonb` | No | The OLD row projected onto `_config.bucket_column`, never a full row image. Default `'{}'`. |
| `bucket_value` | `text` | No | The bucket value the row left, as text rendered in UTC; `''` on an unbucketed table or for a `NULL` value. Default `''`. |

Indexes and constraints: primary key `(table_name, pk, bucket_value)`; index `(seq)`; index `(table_name, bucket_value, seq)`.

### `kizunasync._bucket_grants`

`_bucket_grants` records which bucket values each user has received live rows from. Every [pull](#kizunasyncpull) page grants its caller the `(table, bucket value)` pair of each row it carries, `''` on an unbucketed table, through the `SECURITY DEFINER` helper `_record_bucket_grants`; a pair already granted keeps its first time. A tombstone reaches a caller only for a pair that caller holds, and a committed tombstone answers `DELETE_WINS` only to such a caller, as [Tombstone visibility](#tombstone-visibility) describes. A caller with no `auth.uid()` holds no grant. Grants never expire by age: one older than the tombstone TTL cannot be proven unneeded, because the reap horizon moves only when a tombstone is reaped. [`prune_clients()`](#kizunasyncprune_clients) deletes the grants of users `auth.users` no longer holds. Only `service_role` holds `SELECT`.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `user_id` | `uuid` | No | The pulling caller's `auth.uid()`. |
| `table_name` | `text` | No | The application table the delivered row belongs to. |
| `bucket_value` | `text` | No | The row's `_config.bucket_column` value as text, rendered the way a tombstone's `bucket_value` is; `''` on an unbucketed table or for a `NULL` value. |
| `granted_at` | `timestamptz` | No | Default `now()`: the first pull that delivered a row of the pair. |

Indexes and constraints: primary key `(user_id, table_name, bucket_value)`.

### `kizunasync._change_pending`

`_change_pending` holds the changes a writing transaction has made and not yet numbered. [`track_change()`](#kizunasynctrack_change) and [`track_delete()`](#kizunasynctrack_delete) insert one row per change, and [`_stamp_change()`](#kizunasync_stamp_change) numbers each row as the transaction commits, writes it to `_changelog` or `_tombstones`, and deletes it. Outside an open transaction the table is therefore empty. It is `UNLOGGED` because no row outlives its transaction, so a crash loses only uncommitted work.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `bigint` (identity) | No | Primary key, generated always as identity. |
| `table_name` | `text` | No | The application table the change landed in. |
| `pk` | `uuid` | No | The row's `id`. |
| `op` | `text` | No | `'upsert'` or `'delete'`, checked. |
| `bucket_snapshot` | `jsonb` | No | For a delete, the OLD row projected onto `_config.bucket_column`, which becomes the tombstone's `bucket_snapshot`. Default `'{}'`. |
| `arrived_at` | `timestamptz` | No | Default `clock_timestamp()`: the write time, which `_changelog.arrived_at` keeps. |
| `bucket_value` | `text` | Yes | The bucket label `_stamp_change` copies: for an upsert the new row's value, for a delete the value the row left. `NULL` on an unbucketed table. |

Indexes and constraints: primary key `id`; index `(table_name, pk)`; check on `op`. The deferred constraint trigger `kizunasync_stamp_change` fires on every insert. `authenticated`, `anon`, and `service_role` hold no privilege on the table.

### `kizunasync._row_hlc`

Per-row, per-column [last-writer-wins](../resources/glossary.md#column-last-writer-wins-column-lww) state for tables with `conflict_mode = 'hlc'`, which [HLC mode](../sync/conflict-resolution.md#hlc-mode) explains. `push` writes it through `_apply_hlc`. [`track_delete()`](#kizunasynctrack_delete) deletes a row's entry when the row is deleted, through `push` or straight from SQL.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `table_name` | `text` | No | The application table. |
| `pk` | `uuid` | No | The application row id. |
| `column_hlc` | `jsonb` | No | Map of column name to winning HLC string. Default `'{}'`. |

Indexes and constraints: primary key `(table_name, pk)`.

### `kizunasync._conflict_journal`

`_conflict_journal` holds opt-in audit rows on the server for values that an arrival-mode or HLC-mode write overwrote. [Conflict history](../sync/conflict-resolution.md#conflict-history) describes it for readers. The pack writes it only when the table's `_config.conflict_journal` is true. It draws no value from `_change_seq`, because it is not a change-capture stream. The journal records no increment or array transform, because those values do not travel in the `columns` map it reads. It also skips first writes, columns absent from the pre-image, `id`, unchanged values (compared through the column's type, so a value written in another rendering is unchanged), values whose prior value was null, losing HLC columns, deletes, and rejected mutations. [`compact_changelog()`](#kizunasynccompact_changelog) deletes an entry once its winning changelog row is gone, because pull attaches an entry only beside that row.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `bigint` (identity) | No | Primary key, generated always as identity. |
| `table_name` | `text` | No | Application table. |
| `pk` | `uuid` | No | Application row id. |
| `column_name` | `text` | No | Column whose previous value lost. |
| `loser_value` | `jsonb` | No | RLS-visible value before the winning mutation. |
| `winner_mutation_id` | `uuid` | No | Mutation that overwrote the value. |
| `conflict_mode` | `text` | No | `arrival` or `hlc`, checked. |
| `winner_seq` | `bigint` | Yes | Changelog seq of the winning write, which `_stamp_change` sets as the writing transaction commits; it joins journal rows onto a pull page. |
| `pending_id` | `bigint` | Yes | The `_change_pending` row of the winning write while its transaction is open. `_stamp_change` clears it when it sets `winner_seq`, so a committed row never carries one. |
| `recorded_at` | `timestamptz` | No | Default `clock_timestamp()`. |

Indexes and constraints: primary key `id`; index `(table_name, pk, recorded_at desc)`; index `(winner_seq)`; partial index `(pending_id)` where `pending_id` is not null; check on `conflict_mode`. Only `service_role` holds `SELECT`. Authenticated callers see a journal row only when [pull](#kizunasyncpull) attaches it to a page that already carries the winning row.

### `kizunasync._verdicts`

Per-mutation replay map that turns at-least-once delivery into an exactly-once apply effect. `push` writes it through `_process_mutation`, which answers a repeated mutation id from this table rather than applying the write again. A mutation id is not a secret, since a pulled conflict names the winning write's, so a replay is answered only for the user who pushed it. Any other caller gets `RLS_DENIED` with a null `server_row`, and nothing is recorded. The owner gets the recorded kind and reason, and a `server_row` the verdict carried is rendered again for the recorded row under the owner's current policies, because the ledger keeps no row copy. When the owner cannot read the row at the replay, or its table has no `_config` row at that point, a rejection carries a null `server_row` and an applied verdict leaves `server_row` out. [`prune_clients()`](#kizunasyncprune_clients) deletes entries older than `_settings.client_ttl_days`, and a mutation replayed after that is decided again.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `mutation_id` | `uuid` | No | Primary key; the client's idempotency key. |
| `verdict` | `jsonb` | No | The recorded verdict. A `server_row` it carries is stored as `null`. |
| `recorded_at` | `timestamptz` | No | Default `now()`. |
| `user_id` | `uuid` | Yes | The pushing caller's `auth.uid()`, the only user a replay answers. |
| `table_name` | `text` | Yes | The mutation's table, which a replay renders the row from. |
| `pk` | `uuid` | Yes | The mutation's primary key, which a replay renders the row for. |

Indexes and constraints: primary key `mutation_id`; index `(recorded_at)`.

### `kizunasync._reap_state`

Singleton watermark holding the highest tombstone `seq` that [`reap_tombstones()`](#kizunasyncreap_tombstones) has removed. A checkpoint cursor below `reaped_seq`, or a continuation cursor whose start is below it, earns `CHECKPOINT_EXPIRED` on the next pull. The bootstrap cursor `'0'` never does.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `boolean` | No | Primary key, always `true`. |
| `reaped_seq` | `bigint` | No | Highest reaped tombstone seq. Default `0`. |
| `reaped_at` | `timestamptz` | Yes | When the last reap ran, whether or not it removed rows. |

Indexes and constraints: primary key `id`; check `_reap_state_singleton` requires `id` to be true. The migration seeds the single row.

### `kizunasync._settings`

Single-row server deployment configuration, not protocol: the push policy, the pull scan cap, and the retention knobs and job schedules every [scheduled job](#scheduled-jobs) reads. The pack seeds the push policy permissive and the retention columns at the pack's own defaults. `kizunasync init` writes every knob its flags or its wizard answered; `kizunasync sync` writes only the columns whose answer differs from what the project already carries. [Configuration](../cli/configuration.md#kizunasync_settings) covers which flag writes which column.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `boolean` | No | Primary key, always `true`. |
| `max_batch_size` | `integer` | Yes | `NULL` means unlimited; `1` means no batches. A larger batch raises `KZP02`. A fresh install seeds `500`. |
| `require_atomic` | `boolean` | No | When true, a non-atomic push raises `KZP03`. Default `false`. |
| `reap_schedule` | `text` | No | UTC crontab [`_schedule_jobs()`](#kizunasync_schedule_jobs) gives `kizunasync-reap-tombstones`. Default `'16 3 * * *'`. |
| `compact_schedule` | `text` | No | UTC crontab `_schedule_jobs()` gives `kizunasync-compact-changelog`. Default `'47 3 * * *'`. |
| `client_prune_schedule` | `text` | No | UTC crontab `_schedule_jobs()` gives `kizunasync-prune-clients`. Default `'31 3 * * *'`. |
| `client_ttl_days` | `integer` | No | Days of silence after which [`prune_clients()`](#kizunasyncprune_clients) deletes a client row and [`compact_changelog()`](#kizunasynccompact_changelog) stops counting its cursor, and the age past which `prune_clients()` deletes a recorded verdict. Default `90`. |
| `hlc_max_skew_ms` | `integer` | No | Forward-drift tolerance for an origin HLC, read once per push and clamped by `_apply_hlc`. Default `5000`. |
| `tombstone_ttl_days` | `integer` | No | Project default tombstone lifetime, applied to a table whose own `_config.tombstone_ttl_days` is `NULL`. Default `30`. |
| `max_pull_scan` | `integer` | No | Candidates one [pull](#kizunasyncpull) page examines at most, the rows it withholds included. A page stops there with `has_more` true and continues from the last candidate it examined. Default `5000`. |

Indexes and constraints: primary key `id`; check `id`; check `max_batch_size is null or max_batch_size >= 1`; check `client_ttl_days >= 1`; check `hlc_max_skew_ms >= 0`; check `tombstone_ttl_days >= 1`; check `max_pull_scan >= 1`; each schedule column checks `kizunasync._is_cron_schedule(<column>)`, described under [Scheduled jobs](#scheduled-jobs). The migration seeds `(true, 500, false)` plus the defaults above, and a re-applied pack keeps an existing row.

### `kizunasync.attachments`

Metadata for uploaded files. Bytes live in [Supabase Storage](https://supabase.com/docs/guides/storage/uploads/standard-uploads#uploading) and the row carries the reference, which is the split [Media and attachments](../attachments/media-and-attachments.md) describes. [`attachment_confirm`](#kizunasyncattachment_confirm) and [`attachment_vacuum`](#kizunasyncattachment_vacuum) write it, and the Supabase transfer adapter calls both. The owner reads it directly through RLS, and a peer reads it through [`attachment_metadata`](#kizunasyncattachment_metadata), which reaches a row only through the synced table the confirm recorded. A row has no lifecycle column: it exists only once `attachment_confirm` has run, and `attachment_vacuum` deletes it outright rather than marking it gone.

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | `uuid` | No | Primary key, minted by `attachment_confirm`. |
| `bucket_id` | `text` | No | Storage bucket id. |
| `object_path` | `text` | No | Storage object path, shaped `{owner}/{pk}/{upload_id}.{ext}`. |
| `sha256` | `text` | Yes | Hex-encoded digest of the confirmed bytes. |
| `size` | `bigint` | Yes | Byte count. |
| `media_type` | `text` | Yes | MIME type. |
| `created_by` | `uuid` | No | Default `auth.uid()` at insert time. |
| `created_at` | `timestamptz` | No | Default `now()`. |
| `updated_at` | `timestamptz` | No | Default `now()`, refreshed on confirm. |
| `table_name` | `text` | Yes | The synced table whose row references the object, recorded by the confirm that names one. A peer reads the metadata only through this table. |

Indexes and constraints: primary key `id`; unique index `(bucket_id, object_path)`, which is the confirm idempotency key. The pack enables Row Level Security on the table, and three owner-scoped policies limit `SELECT`, `INSERT`, and `UPDATE` to the row's `created_by`. `authenticated` holds only `SELECT` on the table, so the `INSERT` and `UPDATE` policies decide nothing unless an operator grants those privileges, and `attachment_confirm` and `attachment_vacuum` are the writers. [Grants and security](#grants-and-security) lists the policies. `attachment_metadata` is the one path that reads a row on a peer's behalf.

## Functions

Authenticated callers may execute exactly five functions: `pull`, `push`, `attachment_confirm`, `attachment_metadata`, and `attachment_vacuum`. All five are [`SECURITY DEFINER`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker) so a client needs no privilege on private bookkeeping; Kizuna adds a second owner for the application-row helpers, so the caller's own policies decide every row regardless. `reap_tombstones`, `compact_changelog`, `prune_clients`, and `_schedule_jobs` are maintenance functions granted to `service_role` only, callable by hand through [`kizunasync jobs run`](../cli/cli.md#kizunasync-jobs) or `kizunasync jobs schedule`; `jobs_status` is a fifth `service_role` function beside them, an operator read rather than a maintenance action. The remaining 54 functions are [internal helpers](#internal-helpers), including the three trigger functions also listed under [Triggers](#triggers).

### `kizunasync.pull`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.pull(
  buckets        jsonb,
  cursor         text,
  schema_version integer,
  "limit"        integer  default 500,
  client_id      uuid     default null
) returns jsonb
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `buckets` | `jsonb` | — | Array of at most 64 `{ "table": "<name>", "params": {...} }` objects. `params` is a column-equality filter matched against the rendered row. The bucket column's value is cast through the column's type once, so an uppercase uuid names the same bucket as its lowercase form, and a value the type refuses fails the pull with that cast's class-22 error. |
| `cursor` | `text` | — | Opaque cursor from the previous response, a checkpoint or a continuation, or `'0'` for a fresh sync. |
| `schema_version` | `integer` | — | Client's declared schema version, compared with the highest `min_schema_version` among the requested tables, or with the highest across every configured table when none of the requested tables match. A `null` value is gated like a stale one. |
| `"limit"` | `integer` | `500` | Maximum combined rows and tombstones per page, at least `1`. A `null` argument falls back to `500`, and a value below `1` raises `22023`. A page can also stop earlier at the scan cap, `_settings.max_pull_scan`. |
| `client_id` | `uuid` | `null` | The client's own identifier, keyed into [`_clients`](#kizunasync_clients) when a requested table registers clients. A `null` value falls back to the JWT `session_id` claim. |

#### Returns

`jsonb`:

| Field | Type | Description |
|-------|------|-------------|
| `conflicts` | `jsonb[]` | Present only when the opt-in journal has rows whose `winner_seq` is in this page and whose pk is already in `rows`. Each entry carries `column_name`, `conflict_mode`, `loser_value`, `pk`, `table`, `winner_mutation_id`, and `winner_seq`. The key is omitted when there is nothing to attach. |
| `cursor` | `text` | New cursor to pass on the next call: a flat checkpoint token on the page that closes the checkpoint, a continuation token `<start>:<seq>` on a continuation page. |
| `has_more` | `boolean` | `true` on a keyset continuation page, including one the scan cap stopped below `limit`, and `false` on the page that carries the rest of the stream, an exact fit included. |
| `rows` | `jsonb[]` | Array of `{ "pk", "row", "seq", "table" }` objects ordered by `(seq, table, pk)`. `row` is the full `to_jsonb` snapshot as the caller's `SELECT` policy renders it. |
| `tombstones` | `jsonb[]` | Array of `{ "deleted_at", "pk", "seq", "table" }` objects in the same order: rows deleted, and rows a write moved out of a requested bucket value. Only the primary key travels, never a row image. Which removed keys reach a caller is decided by the stored `bucket_snapshot`, the caller's [bucket grants](#kizunasync_bucket_grants), and whether the row is still deliverable to the caller, rather than by Row Level Security, under [Tombstone visibility](#tombstone-visibility). |
| `signal` | `jsonb \| null` | `{ "type": "RESET_REQUIRED" }` or `{ "type": "CHECKPOINT_EXPIRED" }` when a gate fires; otherwise `null`. |

Real response, from `packages/protocol/transcripts/pull/002-keyset-pagination.json` (first page, `limit: 2`, `has_more: true`):

```json
{
  "cursor": "0:2",
  "has_more": true,
  "rows": [
    { "pk": "00000000-0000-4000-8000-e10000000001", "row": { "done": false, "owner_id": "00000000-0000-4000-8000-a10000000001", "title": "row one" }, "seq": "1", "table": "todos" },
    { "pk": "00000000-0000-4000-8000-e10000000002", "row": { "done": false, "owner_id": "00000000-0000-4000-8000-a10000000001", "title": "row two" }, "seq": "2", "table": "todos" }
  ],
  "signal": null,
  "tombstones": []
}
```

A page is a prefix of one stream: the deliverable rows and tombstones together, ordered by `(seq, table, pk)`. `limit` caps the entries a page holds, rows and tombstones counted together. Each list keeps the stream order. When the remaining stream holds `limit` entries or fewer, the page carries all of them, returns the horizon cursor described below, and sets `has_more` to `false`. An exact fit therefore closes the checkpoint in one page. Otherwise the page carries the first `limit` entries and sets `has_more` to `true`. Its cursor is a continuation token, `<start>:<seq>`: the `seq` of its last entry, after the checkpoint the transfer started from, `0` for a bootstrap. A tombstone travels on the page its `seq` falls in, like a row.

A page also stops once it has examined `_settings.max_pull_scan` candidates, default `5000`, counting the rows it withholds because the caller's policies hide them or no bucket entry matches together with the entries it delivers. Such a page sets `has_more` to `true` even when it holds fewer than `limit` entries, or none, and its continuation token carries the `seq` of the last candidate it examined, so the next page starts after the rows it already read. A stream that ends exactly at the cap closes the checkpoint like an exact fit. A pull names at most 64 bucket entries, and a bucketed table contributes only the changelog rows labeled with a requested value, so the rows of other bucket values never count against the cap.

The pack assigns every change's sequence number when the writing transaction commits. [`track_change()`](#kizunasynctrack_change) and [`track_delete()`](#kizunasynctrack_delete) queue the change in [`_change_pending`](#kizunasync_change_pending), and a deferred constraint trigger, [`_stamp_change()`](#kizunasync_stamp_change), numbers each queued change at commit while it holds one transaction-scoped advisory lock. PostgreSQL makes a committing transaction visible before it releases its locks, so the numbers a snapshot sees form a gapless prefix, apart from numbers an aborted commit consumed.

A pull takes one snapshot and advances the [horizon](../resources/glossary.md#consistency-horizon) to the largest sequence number visible in it, never below the incoming high-water. No later commit can land below that number, so it is a safe place to resume. An open transaction has no sequence number yet, so it never holds back other commits. A change is deliverable as soon as its transaction's commit is visible. The page that closes the checkpoint returns a flat [cursor](../resources/glossary.md#cursor). The pack still honors the composite form `<high_water>~<hole1>.<hole2>` and delivers the holes that token names. [The live SQL horizon](../sync/fencing-and-horizons.md#the-live-sql-horizon) explains the same rule from the sync side.

The cost falls on writes. Transactions that change synced tables run their commit step one at a time, including the write-ahead log flush, so synced-write commits per second have a ceiling that depends on the disk's flush latency. Transactions that touch no synced table never take the lock and are unaffected. [What commit-time numbering costs](../sync/fencing-and-horizons.md#what-commit-time-numbering-costs) lists the other edges of holding that lock.

#### Errors and signals

| Signal type | Cause | Client action |
|-------------|-------|----------------|
| `RESET_REQUIRED` | `schema_version` is `null` or below the highest `min_schema_version` among the requested tables | Upgrade the client schema, then re-sync from `cursor = '0'` |
| `CHECKPOINT_EXPIRED` | The checkpoint the transfer started from (the cursor itself, or a continuation cursor's start) predates the oldest retained tombstone (`_reap_state.reaped_seq`). A transfer from `'0'` never expires, and one from a checkpoint expires as soon as a reap passes it, even between two pages | Re-sync from `cursor = '0'` |

A signal response echoes the incoming cursor and carries empty `rows` and `tombstones` with `has_more: false`. `pull` omits the rows the caller's policies hide, and it raises no error for them. `has_more: true` with `signal: null` means a further page exists, continued from the cursor by keyset rather than by offset. The `pull` wrapper also registers the caller in [`_clients`](#kizunasync_clients) when a requested table sets `register_clients` and the request carries a `client_id` or the JWT a `session_id`. It keys that registration on the request's `client_id` when the request carries one. A page that carries a signal registers nothing.

`pull` also raises one policy error rather than returning it as a signal, checked after the `RESET_REQUIRED` gate and before `CHECKPOINT_EXPIRED`:

| SQLSTATE | Condition |
|----------|-----------|
| `KZL01` | A requested bucket for a table provisioned with `bucket_column` omits that column: `kizunasync.pull(): table "<t>" is bucketed on "<c>": the pull bucket must name that column`. |
| `KZL02` | `authenticated` cannot `SELECT` a requested table's `id` column or its `bucket_column`, under [Column-level privileges](#column-level-privileges). |

Before any gate runs, `pull` refuses a `limit` below `1` with SQLSTATE `22023` (`invalid_parameter_value`) and the message `kizunasync.pull(): limit must be at least 1`, and a `buckets` array of more than 64 entries with the same SQLSTATE and the message `kizunasync.pull(): a pull names at most 64 bucket entries`.

#### Example

[`createRpcRemote`](./javascript/create-rpc-remote.md) makes this call for the app client. To make it by hand for inspection, reach the `kizunasync` schema through your supabase-js client. The `Database` type that `supabase gen types` writes describes `public` by default, so the module widens the client to the untyped `SupabaseClient` before it names the schema, as `createRpcRemote` does:

```typescript
// src/kizunasync-rpc.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase-client'

export const kizunasyncRpc = (supabase as SupabaseClient).schema('kizunasync')
```

The first page of a bootstrap for one user's `todos` bucket:

```typescript
// src/inspect-sync.ts
import { kizunasyncRpc } from './kizunasync-rpc'

export async function pullFirstPage(userId: string): Promise<unknown> {
  const { data, error } = await kizunasyncRpc.rpc('pull', {
    buckets: [{ table: 'todos', params: { user_id: userId } }],
    cursor: '0',
    schema_version: 1,
    limit: 500,
  })

  if (error !== null) {
    throw error
  }

  return data
}
```

### `kizunasync.push`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.push(
  batch            jsonb,
  last_mutation_id uuid,
  schema_version   integer,
  client_id        uuid    default null
) returns jsonb
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `batch` | `jsonb` | — | `{ "mutations": [...], "atomic": boolean }`. A missing `atomic` reads as `false`. |
| `last_mutation_id` | `uuid` | — | The client's own idempotency watermark for this call; `_clients.last_mutation_id` is written from what the server applied, not from this argument. |
| `schema_version` | `integer` | — | Client's declared schema version, compared with the highest `min_schema_version` among the mutations' tables, or with the highest across every configured table when none of them match, before any mutation runs. A `null` value is gated like a stale one. |
| `client_id` | `uuid` | `null` | The client's own identifier, keyed into [`_clients`](#kizunasync_clients) when a requested table registers clients. A `null` value falls back to the JWT `session_id` claim. |

#### Mutation shape

Each element of `batch.mutations`:

| Field | Type | Description |
|-------|------|-------------|
| `mutation_id` | `uuid` | Idempotency key. A replay applies nothing. The user who pushed the mutation gets the recorded kind and reason with `server_row` rendered again, and any other user gets `RLS_DENIED` with a null `server_row`. |
| `table` | `text` | Must have a `_config` row. An unknown table raises `feature_not_supported`. |
| `pk` | `uuid` | Row primary key. |
| `op` | `text` | `'insert'`, `'update'`, or `'delete'`. |
| `columns` | `jsonb` | Column values to apply, `id` omitted. The key set is the update mask. |
| `precondition` | `jsonb` | Optional column-equality assertions against the current server row. Each expected value is cast through its column's type before the comparison, so a timestamp written at another offset or an uppercase uuid matches the stored value it names. A mismatch yields the `PRECONDITION` verdict, and so does a key that names no column the caller may read. A value the column's type refuses yields `CONSTRAINT`. |
| `transforms` | `jsonb` | Optional map of column to `{ "op": ..., ... }` for an update, described in [Using transforms](./javascript/using-transforms.md). The closed menu is `increment` with a numeric `by`, and `arrayUnion` or `arrayRemove` with a non-empty `values` array. Any other shape, or transforms on an insert or a delete, refuses the whole batch with `22023`. |
| `hlc` | `text` | Required on every mutation of a table whose `conflict_mode` is `'hlc'`, deletes included; format `<iso8601>\|<logical>\|<node>`. A mutation without one refuses the whole batch with `22023`. |

#### Returns

`jsonb`, in one of three shapes. Two of them depend on `atomic`, and the third reports the schema gate that runs before any mutation.

Non-atomic (`atomic: false`, the default). Real response, `push/002-rls-denied-not-a-wedge.json`:

```json
{
  "verdicts": [
    { "mutation_id": "00000000-0000-4000-8000-f10000000002", "reason": "RLS_DENIED", "server_row": null, "verdict": "rejected" },
    { "mutation_id": "00000000-0000-4000-8000-f10000000003", "verdict": "applied" }
  ]
}
```

Atomic (`atomic: true`), batch aborted. Real response, `push/005-atomic-batch-revert.json`:

```json
{
  "batch": {
    "offender_mutation_id": "00000000-0000-4000-8000-f10000000002",
    "outcome": "aborted",
    "reason": "PRECONDITION",
    "server_row": { "done": false, "owner_id": "00000000-0000-4000-8000-a10000000001", "title": "claimed by device-b" }
  }
}
```

Stale schema. The pack checks the client's `schema_version` before any mutation, and the response mirrors the pull `RESET_REQUIRED` signal. Real response, `lifecycle/003-push-stale-schema.json`:

```json
{
  "signal": { "type": "RESET_REQUIRED" }
}
```

An applied verdict carries `server_row` when the mutation ran any transform, so the client can snap optimistic state to the arbitrated total.

#### Verdict reasons

| Reason | Description |
|--------|-------------|
| `applied` | The mutation applied, or replayed from the verdict ledger. |
| `RLS_DENIED` | The write is not permitted by the caller's RLS: an insert fails the table's `WITH CHECK`, or an update or delete matches no row the caller may write, including a row that does not exist or that a policy hides. An update carrying neither columns nor transforms is also rejected this way. |
| `COLUMN_DENIED` | The mutation writes a column `authenticated` cannot `UPDATE`, under [Column-level privileges](#column-level-privileges), or a generated column, which Postgres computes itself. `server_row` carries the row narrowed to the columns the caller may read. |
| `PRECONDITION` | One or more `precondition` assertions did not match the current server row. `server_row` is included when the caller may read the row. |
| `DELETE_WINS` | The row's latest change is a removal the caller may know about: a delete the same transaction queued after its last write of the row, or the pk's newest tombstone, newer than every changelog row of this `(table, pk)`, when the caller holds a [bucket grant](#kizunasync_bucket_grants) for the value it removed the row from. A committed removal the caller holds no grant for answers `RLS_DENIED` with a `null` `server_row`. The tombstone a write leaves when it moves a row to another bucket value is followed by that write's changelog row, so a moved row is decided like any other. |
| `CONSTRAINT` | A genuine integrity failure rolled back this one mutation: a user `CHECK`, foreign key, or not-null constraint, a validation trigger raising in SQLSTATE class 23, a value the column's type refuses (class 22, such as `22P02` for text written to an integer column), a validation trigger's `raise exception` with no SQLSTATE of its own (`P0001`), or a transform against a column of the wrong type. The pack's own internals raise only coded errors, so a `P0001` always comes from the application. |
| `SUPERSEDED` | HLC mode only: the incoming HLC is not newer than the stored winner for any target column. |

A mutation is one unit. A `rejected` verdict leaves no effect: none of its columns, transforms, `_changelog` entries, `_conflict_journal` entries, or `_row_hlc` stamps are written. Only the verdict recorded in `_verdicts` persists, and it keeps no copy of `server_row`.

#### Policy errors

Raised rather than returned as verdicts:

| SQLSTATE | Condition |
|----------|-----------|
| `22023` (`invalid_parameter_value`) | A mutation in the batch is malformed: a `mutation_id` or `pk` that is not a uuid, an `op` other than `insert`, `update`, or `delete`, a `table` that is not a string, transforms on an insert or a delete, a transform outside the closed menu or with a non-numeric `by` or an empty `values`, or a mutation of an HLC-mode table without an `hlc`. The check runs after the schema gate and before any mutation, and its message names the mutation's position in the batch and the problem. |
| `KZP01` | A mutation targets a `sync_mode = 'pull-only'` table. |
| `KZP02` | The batch is larger than `_settings.max_batch_size`. |
| `KZP03` | `_settings.require_atomic` is true but `batch.atomic` is false. |
| `KZL01` | Raised by [`pull`](#kizunasyncpull), not `push`: the requested bucket for a table provisioned with `bucket_column` omits that column. |
| `KZL02` | Raised by [`pull`](#kizunasyncpull), not `push`: `authenticated` cannot `SELECT` a requested table's `id` column or its `bucket_column`. |
| `feature_not_supported` | The table has no `_config` row. A stale or `null` `schema_version` is not raised here; it returns the `RESET_REQUIRED` signal shape above, and that response registers no client. |

#### HLC conflict mode

For a table with `conflict_mode = 'hlc'`, every column the mutation names resolves on its own. The pack writes a column only when the incoming [HLC](../resources/glossary.md#hybrid-logical-clock-hlc) is strictly greater than the stored winner in `_row_hlc`. Before that comparison, it clamps the physical component to `now()` plus `_settings.hlc_max_skew_ms`, 5000 ms by default, so a far-future clock cannot poison the row. When every named column loses and the mutation carries no transform, the verdict is `SUPERSEDED`.

#### Example

`createRpcRemote` makes this call for the app client. By hand, with the `kizunasyncRpc` module from the [`pull` example](#kizunasyncpull), one update of a todo's title looks like this:

```typescript
// src/inspect-sync.ts (excerpt)
import { kizunasyncRpc } from './kizunasync-rpc'

export async function pushTitle(todoId: string, lastMutationId: string | null): Promise<unknown> {
  const { data, error } = await kizunasyncRpc.rpc('push', {
    batch: {
      mutations: [{
        mutation_id: crypto.randomUUID(),
        table: 'todos',
        pk: todoId,
        op: 'update',
        columns: { title: 'works on a plane', done: false },
      }],
      atomic: false,
    },
    last_mutation_id: lastMutationId,
    schema_version: 1,
  })

  if (error !== null) {
    throw error
  }

  return data
}
```

### `kizunasync.reap_tombstones()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.reap_tombstones() returns bigint
```

No arguments. Deletes [tombstone](../resources/glossary.md#tombstone) rows older than `coalesce(_config.tombstone_ttl_days, _settings.tombstone_ttl_days)`, raises `_reap_state.reaped_seq` to the highest removed `seq`, and returns that seq, or `0` when nothing was removed. Every run stamps `_reap_state.reaped_at`, whether or not anything expired, so an operator can tell "nothing expired" from "the job never ran". A table with no `_config` row, because `kizunasync sync --remove` dropped it, also loses its `_changelog` rows older than the project default TTL and every one of its `_row_hlc` rows, on the same run. An unsynced table has no reader left to hold that history for. [`pg_cron`](https://supabase.com/docs/guides/cron#how-does-cron-work) schedules the function by default, as [Scheduled jobs](#scheduled-jobs) describes.

#### Errors and signals

`reap_tombstones` runs for a call with no JWT, such as cron's or a direct connection's, and for a JWT whose `role` is `service_role`, so an operator can also call it over the Data API on a service-role key. It refuses every other claim set that does not come from `pull` or `push` with SQLSTATE `42501`, and it raises no other error. A client whose checkpoint predates the new `reaped_seq`, including one in the middle of a transfer that started from it, receives `CHECKPOINT_EXPIRED` on its next pull, then re-syncs from `cursor = '0'`.

#### Example

```sql
-- Supabase SQL editor or psql
select kizunasync.reap_tombstones();
```

### `kizunasync.compact_changelog()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.compact_changelog() returns bigint
```

`compact_changelog` takes no arguments and removes superseded changelog rows. A row qualifies when it sits at or below a floor and a newer changelog row or a newer [tombstone](#kizunasync_tombstones) exists for the same `(table_name, pk)`; a row a tombstone supersedes belongs to a deleted row that a pull could only withhold. The same run deletes every [`_conflict_journal`](#kizunasync_conflict_journal) entry whose winning changelog row is gone. It returns the number of deleted changelog rows. The floor is the lowest cursor high-water among clients registered in [`_clients`](#kizunasync_clients) with `last_seen` inside `_settings.client_ttl_days`, leaving out registrations still at cursor `'0'`, which have pulled nothing yet. A client silent past that TTL stops holding the floor back, and [`prune_clients()`](#kizunasyncprune_clients) deletes its row on the same setting. With no live client registered at all, the floor is the current sequence high-water. A project that never turns the registry on therefore still compacts its own superseded rows. The floor never sits below `_reap_state.reaped_seq`, because a checkpoint under that watermark answers `CHECKPOINT_EXPIRED` and rehydrates without the history. It refuses a client-JWT call the same way `reap_tombstones` does. It also runs on a schedule by default, as [Scheduled jobs](#scheduled-jobs) describes.

#### Example

```sql
-- Supabase SQL editor or psql
select kizunasync.compact_changelog();
```

### `kizunasync.prune_clients()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.prune_clients() returns bigint
```

No arguments. Deletes every [`_clients`](#kizunasync_clients) row whose `last_seen` predates `now() - _settings.client_ttl_days`, and returns the number of client rows deleted. It also deletes every [`_verdicts`](#kizunasync_verdicts) entry recorded before that same cutoff, and every [`_bucket_grants`](#kizunasync_bucket_grants) row whose user `auth.users` no longer holds, whatever its age; the return value counts neither. A pruned client that syncs again registers a fresh row on its next `pull` or `push`. Refuses a client-JWT call the same way `reap_tombstones` does, and it is scheduled by default; see [Scheduled jobs](#scheduled-jobs).

#### Example

```sql
-- Supabase SQL editor or psql
select kizunasync.prune_clients();
```

### `kizunasync._schedule_jobs()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync._schedule_jobs() returns jsonb
```

No arguments. The single writer of the three [scheduled jobs](#scheduled-jobs): it unschedules each of `kizunasync-reap-tombstones`, `kizunasync-compact-changelog`, and `kizunasync-prune-clients` where a job of that name already exists, then reschedules all three from `_settings.reap_schedule`, `_settings.compact_schedule`, and `_settings.client_prune_schedule`. The pack's own install calls it once; [`kizunasync init`](../cli/cli.md#kizunasync-init), [`kizunasync sync`](../cli/cli.md#kizunasync-sync), and [`kizunasync upgrade`](../cli/cli.md#kizunasync-upgrade) call it again after any write to `_settings`, so a later `upgrade` never overwrites a schedule a project customized. On a database with no `pg_cron` extension it schedules nothing and reports that in its return value; the three functions stay directly callable through [`kizunasync jobs run`](../cli/cli.md#kizunasync-jobs) either way.

#### Returns

`jsonb`: `{ "jobs": { "kizunasync-compact-changelog": "<schedule>", "kizunasync-prune-clients": "<schedule>", "kizunasync-reap-tombstones": "<schedule>" }, "pg_cron": boolean }`.

#### Errors and signals

The function admits the same callers as [`reap_tombstones`](#kizunasyncreap_tombstones): no JWT, or a JWT whose `role` is `service_role`. It refuses every other claim set without the `pull`/`push` context with SQLSTATE `42501`. No other error is raised.

#### Example

```sql
-- Supabase SQL editor or psql
select kizunasync._schedule_jobs();
-- {"jobs": {"kizunasync-compact-changelog": "47 3 * * *", "kizunasync-prune-clients": "31 3 * * *", "kizunasync-reap-tombstones": "16 3 * * *"}, "pg_cron": true}
```

### `kizunasync.jobs_status`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.jobs_status() returns table (
  jobname text,
  schedule text,
  active boolean,
  last_start timestamptz,
  last_status text,
  last_message text
)
```

No arguments. The `cron` schema is never exposed through the Data API, so this function is the read surface for a caller that reaches the three jobs over PostgREST rather than a direct connection. It returns one row per pack job `pg_cron` schedules, each carrying its latest run from `cron.job_run_details`. `last_start`, `last_status`, and `last_message` are null for a job that has never run. It returns no rows at all when `pg_cron` is absent, the same answer [`_schedule_jobs()`](#kizunasync_schedule_jobs) gives as `"pg_cron": false`.

#### Errors and signals

The guard is the one the maintenance functions carry: it admits a call with no JWT or a claim set whose `role` is `service_role`, which is how the operator surface reads it over the Data API, and refuses every other claim set with SQLSTATE `42501`. `EXECUTE` is granted to `service_role` alone either way.

#### Example

```sql
-- Supabase SQL editor or psql
select * from kizunasync.jobs_status();
```

### `kizunasync.attachment_confirm`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.attachment_confirm(
  p_bucket     text,
  p_path       text,
  p_sha256     text,
  p_size       bigint,
  p_media_type text,
  p_table      text default null
) returns void
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `p_bucket` | `text` | — | Supabase Storage bucket id. |
| `p_path` | `text` | — | Object path. Its first segment (`storage.foldername(p_path)[1]`) must be the caller's [UUID](https://grokipedia.com/page/Universally_unique_identifier). |
| `p_sha256` | `text` | — | Hex-encoded SHA-256 of the uploaded bytes, 64 hex characters in either case. The row stores it in lowercase. |
| `p_size` | `bigint` | — | Byte count, zero or more. |
| `p_media_type` | `text` | — | MIME type. |
| `p_table` | `text` | `null` | The synced table whose row references the object. It must name a table `_config` declares. |

Records the integrity metadata of an object the caller uploaded in a row of [`kizunasync.attachments`](#kizunasyncattachments), keyed by `(bucket_id, object_path)`. Because `SECURITY DEFINER` bypasses the table's RLS, the function authorizes the uploader itself: the object must exist in `storage.objects` with the caller's `auth.uid()` as its `owner_id`, and the path's owner segment must be the caller too. An object uploaded with the service key has no `owner_id`, so no user can confirm it.

The write is an `insert … on conflict (bucket_id, object_path) do update`. Once a row carries a hash, its hash, size, and media type never change: a call with the same values succeeds and refreshes `updated_at`, and a call with a different hash, size, or media type raises `23514` and changes nothing. A row recorded without a table takes the table a later confirm names, and a recorded table stays. [`attachment_metadata`](#kizunasyncattachment_metadata) answers a peer only through that recorded table, so a confirm without `p_table` leaves the object's metadata readable by its owner alone.

#### Errors and signals

| Condition | Message |
|-----------|---------|
| Malformed path with no UUID first segment | `attachment_confirm: malformed object path <path>` (SQLSTATE `22023`) |
| Hash that is not 64 hex characters, or no hash | `attachment_confirm: sha256 must be 64 hex characters, got <sha256>` (SQLSTATE `22023`) |
| Negative size, or no size | `attachment_confirm: size must be zero or more, got <size>` (SQLSTATE `22023`) |
| `p_table` names a table `_config` does not declare | `attachment_confirm: table <table> is not synced` (SQLSTATE `22023`) |
| Caller is not the object path's owner segment | `attachment_confirm: caller <uid> is not the owner (<uid>) of <path>` (SQLSTATE `42501`) |
| No Storage object at the path in the bucket owned by the caller | `attachment_confirm: caller <uid> has uploaded no object <path> in bucket <bucket>` (SQLSTATE `42501`) |
| The recorded row belongs to another user | `attachment_confirm: row for <path> is owned by <uid>, not the caller` (SQLSTATE `42501`) |
| A different hash, size, or media type than the recorded ones | `attachment_confirm: <path> is confirmed with other metadata` (SQLSTATE `23514`) |

#### Example

The Supabase transfer adapter, [`createSupabaseTransfer`](./javascript/create-supabase-transfer.md), makes this call after each upload. The same call by hand, for a todo image in a `todo-images` Storage bucket, goes through the `kizunasyncRpc` module from the [`pull` example](#kizunasyncpull):

```typescript
// src/inspect-sync.ts (excerpt)
import { kizunasyncRpc } from './kizunasync-rpc'

export async function confirmTodoImage(path: string, sha256: string, size: number, mediaType: string): Promise<void> {
  const { error } = await kizunasyncRpc.rpc('attachment_confirm', {
    p_bucket: 'todo-images',
    p_path: path,
    p_sha256: sha256,
    p_size: size,
    p_media_type: mediaType,
    p_table: 'todos',
  })

  if (error !== null) {
    throw error
  }
}
```

### `kizunasync.attachment_metadata`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.attachment_metadata(
  p_bucket_id    text,
  p_object_path  text
) returns table (sha256 text, size bigint, media_type text, created_at timestamptz, updated_at timestamptz)
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `p_bucket_id` | `text` | — | Supabase Storage bucket id. |
| `p_object_path` | `text` | — | Object path, shaped `{owner}/{pk}/{upload_id}.{ext}`. |

`attachment_metadata` reads integrity metadata for an object the caller did not upload, so a peer can verify bytes it is about to download without becoming that object's owner. The caller sees a row in exactly two cases. First, the caller's own `attachments` row carries this `(bucket_id, object_path)`. Second, the `attachments` row for this `(bucket_id, object_path)` recorded a `table_name` that `_config` still declares, and the object path's second segment is a primary key of that table. In that case [`_render_user_row`](#internal-helpers) shows the row to the caller under its own `SELECT` policy, and one of the row's columns equals `p_object_path`.

`_config` declares no dedicated attachment column, so the match is "any column of the recorded table's row the caller can already read carries this exact path". That is what makes the second branch a genuine RLS check rather than a bypass: the caller only ever confirms bytes it is already allowed to see, and nobody else learns whether the row exists. Only the recorded table is rendered, so a row of another table that carries the same primary key and path reveals nothing, and a row confirmed without a table gives peers nothing. A malformed path, one whose second segment is not a UUID, returns nothing rather than raising.

#### Returns

Zero or one row of `sha256`, `size`, `media_type`, `created_at`, `updated_at`, taken from the caller's own row or the peer's, once visibility is established.

#### Example

The transfer adapter reads this before it downloads a peer's attachment. The function below reads it for a todo image, with the `kizunasyncRpc` module from the [`pull` example](#kizunasyncpull):

```typescript
// src/inspect-sync.ts (excerpt)
import { kizunasyncRpc } from './kizunasync-rpc'

export async function readTodoImageMetadata(path: string): Promise<unknown> {
  const { data, error } = await kizunasyncRpc.rpc('attachment_metadata', {
    p_bucket_id: 'todo-images',
    p_object_path: path,
  })

  if (error !== null) {
    throw error
  }

  return data
}
```

### `kizunasync.attachment_vacuum`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
kizunasync.attachment_vacuum(
  p_bucket text,
  p_path   text
) returns void
```

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `p_bucket` | `text` | — | Supabase Storage bucket id. |
| `p_path` | `text` | — | Object path. |

Deletes the caller's metadata row for `(bucket_id, object_path)` once the object is gone from `storage.objects`. The row must have `created_by = auth.uid()`, and while the object exists the call deletes nothing, so the metadata a peer verifies against stays as long as the bytes do. The path is matched, never parsed, so a path of any shape is a no-op rather than an error. The adapter calls it after the Storage object is removed. `SECURITY DEFINER`, written in plain SQL, with both predicates in the `delete` itself.

#### Example

The transfer adapter calls this once it has removed the Storage object. By hand, the call takes the same [`kizunasyncRpc`](#kizunasyncpull) module:

```typescript
// src/inspect-sync.ts (excerpt)
import { kizunasyncRpc } from './kizunasync-rpc'

export async function vacuumTodoImage(path: string): Promise<void> {
  const { error } = await kizunasyncRpc.rpc('attachment_vacuum', {
    p_bucket: 'todo-images',
    p_path: path,
  })

  if (error !== null) {
    throw error
  }
}
```

### Internal helpers

Fifty-four further functions carry the engine, and none is granted to `authenticated`; three of them, `track_change`, `track_delete`, and `_stamp_change`, are also listed under [Triggers](#triggers). The `Owner` column names the role that owns the function: the ten owned by `kizunasync_rls` run under the caller's Row Level Security, while the rest are owned by `postgres`, which is what lets the ones that read or write a private ledger do so. The `Gate` column records whether the body opens with `_require_rpc_context()`, the transaction-local check described under [Grants and security](#grants-and-security).

| Function | Owner | Gate | Purpose |
|---|---|---|---|
| `_is_cron_schedule(p_schedule text)` | postgres | no | Validates the five-field UTC crontab grammar a `_settings` schedule column's check constraint calls; [`kizunasync`](../cli/cli.md) runs a matching Rust check before it writes one. |
| `_clamp_hlc(p_hlc text, p_now timestamptz, p_max_skew_ms integer)` | postgres | no | Clamps an HLC's physical component to `now()` plus the skew allowance. |
| `_compare_hlc(p_a text, p_b text)` | postgres | no | Total order over HLC strings by physical time, logical counter, then node. |
| `_cursor_high_water(p_cursor text)` | postgres | no | Decodes the high-water mark, which is the position of a continuation token. Raises on a token that is not already canonical. |
| `_cursor_holes(p_cursor text)` | postgres | no | Decodes the strictly ascending hole list after `~`. Raises on a non-canonical token. |
| `_cursor_start(p_cursor text)` | postgres | no | Decodes the start a continuation token carries, the checkpoint its transfer started from, and returns null for a checkpoint token. Raises on a non-canonical token. |
| `_encode_cursor(p_high_water bigint, p_holes bigint[])` | postgres | no | Encodes a checkpoint token, emitting the flat form when there are no holes. Sorts a hole array it is building. |
| `_encode_continuation(p_start bigint, p_high_water bigint)` | postgres | no | Encodes the continuation token `<start>:<high-water>` that a continuation page returns. |
| `_jwt_session_id()` | postgres | no | Reads the `session_id` claim from `auth.jwt()`. |
| `_min_schema_version(p_tables text[])` | postgres | no | Highest `min_schema_version` across the requested tables, falling back to the highest across every configured table when none match. |
| `_reap_horizon()` | postgres | no | Current `_reap_state.reaped_seq`. |
| `_caller_role()` | postgres | no | The caller's role: the transaction's `SET ROLE`, then the JWT `role` claim, then `authenticated`. |
| `_readable_columns(p_table text)` | postgres | no | Columns of `public.<table>` the caller's role may `SELECT`, in `attnum` order. `_pull_page` computes it once per requested table and passes the result to `_render_user_row_projected`, rather than probing per row. |
| `_writable_columns(p_table text, p_privilege text)` | postgres | no | Columns of `public.<table>` the caller's role may `INSERT` or `UPDATE`, per `p_privilege`, leaving out generated columns, which Postgres computes itself. The push decision layer compares a mutation's written columns against this set before any apply. |
| `_normalize_cell(p_table text, p_column text, p_value jsonb)` | postgres | no | Casts a client value through its column's type with `jsonb_populate_record`, the cast the apply primitives write through, and renders it back with `to_jsonb`, so it compares equal to the stored cell it names. A value the type refuses raises in class 22. A name that is no column of the table comes back unchanged and never matches. Preconditions and the conflict journal compare through it. |
| `_render_user_row(p_table text, p_pk uuid)` | kizunasync_rls | no | Computes the caller's readable-column projection through `_readable_columns` and delegates to `_render_user_row_projected`; the push decision layer, which renders one row per mutation, calls this form. |
| `_render_user_row_projected(p_table text, p_pk uuid, p_columns text[])` | kizunasync_rls | no | Renders one application row projected onto the given column list, as the caller's `SELECT` policy allows, or null when `id` is not in the projection. `pull` calls this form for each row its page reaches, after probing `_readable_columns` once per requested table. |
| `_lock_user_row(p_table text, p_pk uuid)` | kizunasync_rls | yes | Reads the caller's readable-column projection of one application row `for no key update`, so the row stays locked until the push commits and a second writer waits for it. Returns null when the row is absent, hidden by the caller's `SELECT` policy, excluded by its `UPDATE` policy, or the role holds no `UPDATE` privilege on the table. |
| `_row_matches_params(p_row jsonb, p_params jsonb)` | postgres | no | Column-equality match of a rendered row against bucket params. |
| `_tombstone_in_buckets(p_table text, p_snapshot jsonb, p_buckets jsonb)` | postgres | no | Decides whether a bucketed table's tombstone snapshot is in scope for the request, on the bucket column alone, so a bucket that names extra params still receives the deletes of its bucket value. The tombstone key folds a `NULL` bucket value into `''`, and the snapshot keeps the two apart. |
| `_require_rpc_context()` | postgres | no | Raises `42501` unless `kizunasync.rpc` is `'1'`. |
| `_lookup_verdict(p_mutation_id uuid, out verdict jsonb, out user_id uuid, out table_name text, out pk uuid)` | postgres | yes | Reads a recorded verdict with the user who pushed it and the row it named; every field is null for an unknown id. |
| `_record_verdict(p_mutation_id uuid, p_table text, p_pk uuid, p_verdict jsonb)` | postgres | yes | Writes a verdict to the ledger with the caller's `auth.uid()`, the table, and the pk, storing a `server_row` it carries as `null`. |
| `_record_bucket_grants(p_tables text[], p_bucket_values text[])` | postgres | yes | Records the caller's grant for each `(table, bucket value)` pair a pull page delivered a live row from, keeping the first time of a pair already granted; does nothing for a caller with no `auth.uid()`. |
| `_row_hlc_lock(p_table text, p_pk uuid)` | postgres | yes | Returns the stored per-column HLC map locked `for update` until the push commits, inserting an empty placeholder first when the pk has none, so two HLC writes of one pk compare and merge one after the other. A rejected mutation rolls the placeholder back. |
| `_row_hlc_merge(p_table text, p_pk uuid, p_column_hlc jsonb)` | postgres | yes | Merges winning column HLCs into the stored map, keeping the greater HLC of every column. |
| `_journal_overwrites(p_table text, p_pk uuid, p_mutation_id uuid, p_applied jsonb, p_prior jsonb, p_conflict_mode text)` | postgres | yes | Records losing values when the table opted into the journal, each tied by `pending_id` to the winning write's queued change. It compares each written value with the prior one through `_normalize_cell`, so a value that changed only its rendering is no overwrite. Raises `internal_error` when an overwrite's queued change is missing, which fails the whole push. |
| `_apply_upsert(p_table text, p_pk uuid, p_columns jsonb)` | kizunasync_rls | yes | Masked insert with `on conflict (id) do update`. |
| `_apply_update_masked(p_table text, p_pk uuid, p_columns jsonb)` | kizunasync_rls | yes | Masked update, returning the affected row count. |
| `_apply_increment(p_table text, p_pk uuid, p_column text, p_by numeric)` | kizunasync_rls | yes | Adds a delta to a numeric column; a non-numeric column raises in class 23. |
| `_apply_array_union(p_table text, p_pk uuid, p_column text, p_values jsonb)` | kizunasync_rls | yes | Appends missing members to a `text[]` column, order-stable. |
| `_apply_array_remove(p_table text, p_pk uuid, p_column text, p_values jsonb)` | kizunasync_rls | yes | Removes members from a `text[]` column. |
| `_apply_transforms(p_table text, p_pk uuid, p_transforms jsonb)` | kizunasync_rls | yes | Dispatches the transform menu and raises on an unknown op. |
| `_apply_delete(p_table text, p_pk uuid, p_precondition jsonb)` | kizunasync_rls | yes | Deletes the application row when the precondition, if any, still matches the caller's readable projection of it through `_normalize_cell`, returning the affected row count. |
| `_rejected(p_mutation_id uuid, p_reason text, p_server_row jsonb)` | postgres | no | Builds the rejected verdict object. |
| `_apply_hlc(p_mutation_id uuid, p_op text, p_table text, p_pk uuid, p_columns jsonb, p_hlc text)` | postgres | yes | Per-column HLC comparison against the map `_row_hlc_lock` returns, then the winning columns through `_apply_upsert` for an insert or `_apply_update_masked` otherwise, the journal, and the merge. A `SUPERSEDED` verdict carries the row as the caller's `SELECT` policy renders it. |
| `_column_write_denied(p_table text, p_op text, p_columns jsonb, p_transforms jsonb)` | postgres | yes | The column-privilege gate. Returns true when the caller's role lacks a privilege the mutation's apply path needs: `UPDATE` on its columns and transformed columns, `INSERT` on `id` and its columns for an insert, or table-level `DELETE` for a delete. `_decide_mutation` turns true into `COLUMN_DENIED` before any apply. |
| `_decide_mutation(p_mutation jsonb)` | postgres | yes | Turns one mutation into a verdict: the table's config, the column-privilege gate, the `_lock_user_row` lock for an insert or update, the delete-wins check that the row's latest change is a removal (a delete the same transaction queued last, or the pk's newest tombstone when it is newer than its changelog rows, which answers `DELETE_WINS` to a caller holding a grant for its bucket value and `RLS_DENIED` to anyone else), the precondition against the locked or rendered row through `_normalize_cell`, apply, transforms. The precondition runs inside the mutation's own unit, which answers `CONSTRAINT` for a class-23 or class-22 error or a `P0001` raised there. An HLC write of a row the caller could not lock answers `RLS_DENIED` before any `_row_hlc` read, and so does an HLC insert over an existing pk. An HLC insert of a new pk waits on the `_row_hlc_lock` of a push inserting the same pk and then looks again: a pk that exists by then is locked like any existing row, or answers `RLS_DENIED` with no row when the caller cannot lock it. A delete that removes no row answers `DELETE_WINS` when a tombstone newer than the row's changelog rows committed while it waited and the caller holds a grant for its bucket value, `PRECONDITION` when the fresh row fails the precondition, and `RLS_DENIED` otherwise. |
| `_process_mutation(p_mutation jsonb)` | postgres | yes | Replay guard around `_decide_mutation` and the verdict ledger: a recorded id answers `RLS_DENIED` with no row to any user but its owner, and the owner's `server_row` is rendered again when the verdict carries one; with no readable row or no configured table, a rejection carries `null` and an applied verdict leaves `server_row` out. |
| `_register_client(p_session uuid, p_user uuid, p_schema_version integer, p_cursor text default null, p_last_mutation_id uuid default null, p_client_id uuid default null)` | postgres | no | Upserts `_clients`, keyed by `coalesce(p_client_id, p_session)`, after checking session and user against the JWT; refuses a `client_id` already owned by another user, and keeps at most 100 registrations per user by deleting that user's least recently seen rows. |
| `_conflicts_for_page(p_rows jsonb)` | postgres | no | Selects journal rows whose `winner_seq` and pk are in the delivered page. |
| `_pull_envelope(p_cursor text, p_has_more boolean, p_rows jsonb, p_tombstones jsonb)` | postgres | no | Builds the pull response and omits `conflicts` when empty. |
| `_pull_gate(p_buckets jsonb, p_cursor text, p_schema_version integer, out envelope jsonb, out bucket_tables text[])` | postgres | yes | Runs the pull gates in order: the schema check, the bucket policy (`KZL01`), the column policy (`KZL02`), and the reap check, which reads a continuation token's start rather than its position. Returns the `RESET_REQUIRED` or `CHECKPOINT_EXPIRED` envelope, null when no gate fires, with the distinct requested tables. |
| `_pull_horizon(p_high_water bigint, p_snap pg_snapshot)` | postgres | yes | The horizon under the pull's snapshot: the largest seq visible in it across `_changelog` and `_tombstones`, never below `p_high_water`. |
| `_pull_candidates(p_buckets jsonb, p_bucket_tables text[], p_snap pg_snapshot, p_cursor text, p_new_high_water bigint)` | postgres | yes | Returns the unrendered stream above the cursor and under the horizon as `table (seq bigint, table_name text, pk uuid, deleted_at timestamptz)`: the latest changelog row per `(table, pk)` of each requested table, with a null `deleted_at`, and every tombstone of a requested bucket value the caller holds a grant for. On a bucketed table it reads only the changelog rows and tombstones labeled with a requested value, one range of each table's `(table_name, bucket_value, seq)` index per value; an unbucketed table contributes every row and tombstone of the table. It decodes the cursor's high-water and holes itself. |
| `_pull_page(p_buckets jsonb, p_bucket_tables text[], p_snap pg_snapshot, p_cursor text, p_new_high_water bigint, p_limit integer)` | postgres | yes | Walks the `_pull_candidates` stream in `(seq, table, pk)` order and renders each candidate's current row when it reaches it. It withholds a row the caller's policies hide or no bucket entry matches, and a tombstone whose row is still deliverable that way. Every row the page carries grants the caller its bucket value through `_record_bucket_grants`. It stops after `p_limit + 1` entries, one more than a page returns, to learn whether another page exists, or after examining `_settings.max_pull_scan` candidates when one more remains. When the stream fits in `p_limit` within the scan cap, an exact fit included, it returns the final page with the flat cursor `p_new_high_water` and `has_more` false. Otherwise it returns a continuation page, rows and tombstones together, whose cursor is `_encode_continuation` of the incoming token's start, or its high-water when it has none, and the page's last seq, or the seq of the last candidate it examined when the scan cap stopped it. |
| `_pull_impl(buckets jsonb, cursor text, schema_version integer, "limit" integer default 500)` | postgres | yes | The pull engine, run with the time zone pinned to UTC: takes the snapshot, refuses a `limit` below 1 or more than 64 bucket entries with `22023`, runs `_pull_gate`, casts each bucketed table's requested value through its column type with `_normalize_cell`, then runs `_pull_horizon` and `_pull_page` in that order. |
| `_push_guard(batch jsonb, schema_version integer)` | postgres | yes | Reads `_settings` once, publishes `hlc_max_skew_ms` as the transaction-local `kizunasync.hlc_max_skew_ms` setting `_apply_hlc` reads, returns the `RESET_REQUIRED` signal for a stale schema, raises `22023` for a malformed mutation, and raises `KZP01`, `KZP02`, or `KZP03` for a policy violation. |
| `_push_impl(batch jsonb, last_mutation_id uuid, schema_version integer)` | postgres | yes | The push engine: runs `_push_guard`, then the non-atomic or the atomic mutation loop over `_process_mutation`. |
| `track_change()` | postgres | no | Trigger function; see [`kizunasync.track_change()`](#kizunasynctrack_change). |
| `track_delete()` | postgres | no | Trigger function; see [`kizunasync.track_delete()`](#kizunasynctrack_delete). |
| `_stamp_change()` | postgres | no | Trigger function; see [`kizunasync._stamp_change()`](#kizunasync_stamp_change). |
| `_seed_changelog(p_table text)` | postgres | no | Queues one upsert, labeled with the row's bucket value, for every row of a configured table that has no changelog entry and no queued change, and returns how many it queued. A table with no `_config` row raises `0A000`, and a call carrying a client JWT raises `42501`. |
| `_relabel_changelog(p_table text)` | postgres | no | Relabels a table's changelog rows from its current `_config.bucket_column`, deletes the changelog rows of pks the table no longer holds, re-keys the tombstones whose snapshot carries the new column and deletes the others, deletes the table's bucket grants, and returns how many changelog rows it relabeled. A table with no `_config` row raises `0A000`, and a call carrying a client JWT raises `42501`. |

A provisioning migration calls `_seed_changelog` once it has attached a table's capture triggers, because rows the table held before the triggers existed have no changelog entry and no pull would deliver them. The rows it queues are numbered by [`_stamp_change()`](#kizunasync_stamp_change) when the migration commits, like any other write, so sequence numbers stay commit-ordered, and a second call queues nothing. The stamp holds its advisory lock while it numbers every seeded row, so seeding a large table makes every other commit that writes a synced table wait until the provisioning transaction ends. The example migration `0002_example.sql` calls it for `public.todos`.

A provisioning migration calls `_relabel_changelog` after it changes a table's `_config.bucket_column`, because every label a pull reads names the old column until then. Each changelog row takes the new column's value from the row it names as the table holds it now, and a changelog row whose pk is gone is deleted, since its tombstone supersedes it. A tombstone whose snapshot carries the new column is re-keyed by that value, keeping the newer of two that land on the same value, and every other tombstone is deleted, because it cannot be scoped by the new column. A bucket column change therefore needs a `min_schema_version` bump, so every device bootstraps again. The table's bucket grants name values of the old column, so the function deletes them as well.

The capture triggers, the seed, the relabel, and `_pull_impl` run with the time zone pinned to UTC, because `to_jsonb` renders a `timestamptz` in the session's `TimeZone`. A `timestamptz` bucket value therefore spells one label, one tombstone key, and one grant value whatever time zone the writer or the puller runs in, and a pull renders `timestamptz` columns in UTC.

`_pull_candidates` reads the backlog of the requested bucket values above the cursor once without rendering it, and `_pull_page` renders only the rows its page reaches, at most `_settings.max_pull_scan` per page. A pull creates no temporary table. `_push_impl` raises the internal sentinel `KZA01` to roll an atomic batch back and catches it in the same block, so that code never reaches a client. `_decide_mutation` raises the internal sentinel `KZM01`, carrying the rejected verdict, to roll back every write of one rejected mutation, and catches it in the same function, so that code never leaves the function.

## Triggers

The base pack creates three trigger functions. The generated config migration attaches `track_change` and `track_delete` to each synced table, and the pack itself attaches `_stamp_change` to `_change_pending`. All three run [`SECURITY DEFINER`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker) so an authenticated caller needs no write privilege on the bookkeeping tables, which is what [What Kizuna installs](../cli/whats-installed.md#the-per-table-hooks) shows per table.

### `kizunasync.track_change()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
create or replace function kizunasync.track_change() returns trigger
language plpgsql security definer set search_path to '' set timezone to 'UTC'
```

The trigger fires `after insert or update`, queues a `_change_pending` row with `op = 'upsert'` labeled with the new row's bucket value, and then sends a contentless [Realtime broadcast](https://supabase.com/docs/guides/realtime/broadcast#broadcast-from-the-database) on topic `kizunasync:<table_name>` with event `changed`, once per table per transaction, as [Realtime doorbell](#realtime-doorbell) describes. The broadcast is the [doorbell hint](../resources/glossary.md#wake-up), never a data path. An update that leaves every column unchanged queues no change and sends no doorbell. The trigger compares the old and new rows as `jsonb`, so a table with a `json`, `xml`, or `point` column, types Postgres gives no equality operator, updates normally, and a `json` rewrite that changes only whitespace or key order counts as unchanged.

An update that changes the value of the table's `_config.bucket_column` moves the row out of one bucket and into another. The trigger first queues a delete for the value the row left, with that value's snapshot, and only then the upsert, so the tombstone takes the lower sequence number in the same commit. A device that received the row from the old value and pulls only that value then receives the tombstone and drops the row, and a device that pulls the new value receives the row.

### `kizunasync.track_delete()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
create or replace function kizunasync.track_delete() returns trigger
language plpgsql security definer set search_path to '' set timezone to 'UTC'
```

`track_delete` fires `after delete`. It reads the table's `bucket_column` from `_config`, projects the OLD row onto it, and queues a `_change_pending` row with `op = 'delete'`, that projection, and the OLD row's bucket value as the label. It also deletes the row's [`_row_hlc`](#kizunasync_row_hlc) entry, so the HLC state goes with the row whether the delete came through `push` or straight from SQL. It sends the same contentless broadcast `track_change` sends.

#### Example

`kizunasync init` generates this per-table trigger pair, and the pack migration does not ship it:

```sql
-- supabase/migrations/20260928120000_todos_policies.sql
create trigger kizunasync_track_change
  after insert or update on public.todos
  for each row execute function kizunasync.track_change();

create trigger kizunasync_track_delete
  after delete on public.todos
  for each row execute function kizunasync.track_delete();
```

### `kizunasync._stamp_change()`

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
create or replace function kizunasync._stamp_change() returns trigger
language plpgsql security definer set search_path to ''
```

`_stamp_change` numbers each queued change as the writing transaction commits. For every `_change_pending` row it takes the transaction-scoped advisory lock `pg_advisory_xact_lock(1264210777, 1)` and draws the next `_change_seq` value. An upsert becomes a `_changelog` row that keeps the queued `arrived_at` and bucket label. A delete upserts the row's tombstone for the bucket value it left, `''` when there is none, and on a conflict it refreshes `seq`, `deleted_at`, `xid`, and `bucket_snapshot`, so a re-delete reaches pulls as a new change. The function then copies the number into the `winner_seq` of any `_conflict_journal` row that names the queued change, clears that row's `pending_id`, and deletes the queued row.

The lock lasts until the transaction ends and is reentrant, so later changes in the same transaction do not wait for it. If a subtransaction that ran the function aborts, PostgreSQL rolls that work back and fires the deferred event again later, so every queued change that commits is numbered exactly once. The function does not call `_require_rpc_context()`, because a direct SQL write to a synced table must be numbered too. [`pull`](#kizunasyncpull) explains why numbers drawn at commit make the largest visible sequence number a safe cursor.

The pack attaches the function to its own table, deferred to commit:

```sql
-- packages/supabase-pack/supabase/migrations/0001_kizuna_init.sql (excerpt)
create constraint trigger kizunasync_stamp_change
  after insert on kizunasync._change_pending
  deferrable initially deferred
  for each row execute function kizunasync._stamp_change();
```

## Scheduled jobs

[`pg_cron`](https://supabase.com/docs/guides/cron#how-does-cron-work) is optional, and the pack tries to give the project one the way Supabase's own [install guide](https://supabase.com/docs/guides/cron/install) does. Its install block is the single statement `create extension if not exists pg_cron with schema pg_catalog;` inside a `do $$ ... exception when ... then null; end $$`, and it grants nothing on the `cron` schema: on the Supabase image an event trigger gives `postgres` what it needs on every `create extension` and keeps `cron.job` read-only, and `_schedule_jobs()` changes jobs only through `cron.schedule()` and `cron.unschedule()`. The wrapper absorbs every SQLSTATE meaning "this server will not give us cron": `0A000` when the extension is not available at all, `P0001` when `pg_cron` refuses a database other than the one named by `cron.database_name`, and the defensive `undefined_file`, `insufficient_privilege`, and `object_not_in_prerequisite_state`. The install continues clean either way. That block is never ledgered, and [`kizunasync deprovision`](../cli/cli.md#kizunasync-deprovision) never drops the extension, because another schema in the same database may depend on it. The three retention functions stay directly callable through [`kizunasync jobs run`](../cli/cli.md#kizunasync-jobs) whether or not the extension is present. A config migration that [`kizunasync init`](../cli/cli.md#kizunasync-init) or [`kizunasync sync`](../cli/cli.md#kizunasync-sync) generates carries its own gate ahead of the tables it provisions, and refuses to apply with `kizunasync: pg_cron is not enabled on this database` unless the run passed `--allow-no-cron`.

Schedules come from [`_settings`](#kizunasync_settings), and [`_schedule_jobs()`](#kizunasync_schedule_jobs) is the only function that writes them into `cron.job`. The pack's own install calls it once, and `kizunasync init`, `kizunasync sync`, and `kizunasync upgrade` call it again after any write to `_settings`, so a re-applied pack never resets a schedule a project customized.

| Job | Default schedule (UTC) | Command |
|---|---|---|
| `kizunasync-reap-tombstones` | `16 3 * * *` | `select kizunasync.reap_tombstones()` |
| `kizunasync-compact-changelog` | `47 3 * * *` | `select kizunasync.compact_changelog()` |
| `kizunasync-prune-clients` | `31 3 * * *` | `select kizunasync.prune_clients()` |

Each schedule is a five-field crontab (minute, hour, day-of-month, month, day-of-week), validated by [`_is_cron_schedule`](#internal-helpers) both at the `_settings` check constraint and, before a write reaches the database, by the matching Rust grammar in `kizunasync`. [`kizunasync jobs list`](../cli/cli.md#kizunasync-jobs) reads the live schedule, the last run, and its status from `cron.job` and `cron.job_run_details`; [`kizunasync doctor`](../cli/cli.md#kizunasync-doctor) reports the extension and job health as project checks.

### Retention

Every pack table keeps its rows until one of the paths below removes them. The three jobs cover the tables that grow with traffic, and the rest shrink only through a call or a CLI run.

| Table | What removes its rows |
|---|---|
| `_provisions` | [`kizunasync deprovision`](../cli/cli.md#kizunasync-deprovision) deletes each row whose object it drops. No job touches the ledger. |
| `_config` | `kizunasync sync --remove` and `kizunasync deprovision` delete a table's row. No job touches it. |
| `_clients` | [`prune_clients()`](#kizunasyncprune_clients) deletes the rows silent past `_settings.client_ttl_days`, and each registration deletes that user's least recently seen rows beyond 100. |
| `_changelog` | [`compact_changelog()`](#kizunasynccompact_changelog) deletes the rows at or below its floor that a newer changelog row or a newer tombstone of the same row supersedes. [`reap_tombstones()`](#kizunasyncreap_tombstones) deletes the rows of a table with no `_config` row once they are older than `_settings.tombstone_ttl_days`, and `_relabel_changelog` deletes the rows whose pk the table no longer holds. |
| `_tombstones` | `reap_tombstones()` deletes the markers older than the table's `tombstone_ttl_days`, or the project default when the table declares none or has no `_config` row. `_relabel_changelog` deletes the markers it cannot re-key by the new bucket column. |
| `_bucket_grants` | `prune_clients()` deletes the grants of users `auth.users` no longer holds, and `_relabel_changelog` deletes every grant of the table it relabels. No grant expires by age. |
| `_change_pending` | [`_stamp_change()`](#kizunasync_stamp_change) deletes each row as the writing transaction commits, so the table is empty outside an open transaction. |
| `_row_hlc` | [`track_delete()`](#kizunasynctrack_delete) deletes a row's entry when the row is deleted, and `reap_tombstones()` deletes every entry of a table with no `_config` row. |
| `_conflict_journal` | `compact_changelog()` deletes the entries whose winning changelog row is gone. |
| `_verdicts` | `prune_clients()` deletes the entries recorded before `_settings.client_ttl_days`. |
| `_reap_state` | Nothing. `reap_tombstones()` updates its single row on every run. |
| `_settings` | Nothing. The CLI updates its single row. |
| `attachments` | [`attachment_vacuum`](#kizunasyncattachment_vacuum) deletes the caller's row once its Storage object is gone. No job touches it. |

A table with no `_config` row, because `kizunasync sync --remove` dropped it, has no reader left, so the jobs empty its bookkeeping without waiting for a client. On its next run `reap_tombstones()` deletes the table's tombstones and changelog rows older than `_settings.tombstone_ttl_days` and every one of its `_row_hlc` entries, and the next `compact_changelog()` deletes the conflict-journal entries whose winning changelog row went with them. Its bucket grants stay until their user is deleted, and the verdicts of its mutations stay until they pass `client_ttl_days`.

## Grants and security

The public RPCs are postgres-owned `SECURITY DEFINER` wrappers over private bookkeeping. They delegate every application-row read and write to a second set of `SECURITY DEFINER` helpers, owned by `kizunasync_rls`. That role is a `NOBYPASSRLS` member of `authenticated`, so the [policies on the application table](https://supabase.com/docs/guides/database/postgres/row-level-security#grants-and-policies) remain the authorization boundary.

| Grantee | Objects |
|---------|---------|
| `authenticated` | `usage` on the schema; `select` on `attachments` under RLS; `execute` on `pull`, `push`, `attachment_confirm`, `attachment_metadata`, and `attachment_vacuum` only |
| `service_role` | `usage` on the schema; `select` on `_changelog`, `_tombstones`, `_config`, `_settings`, `_reap_state`, `_clients`, `_provisions`, `_verdicts`, `_row_hlc`, `_conflict_journal`, `_bucket_grants`, and `attachments`; `execute` on `reap_tombstones()`, `compact_changelog()`, `prune_clients()`, `_schedule_jobs()`, and `jobs_status()` |
| `kizunasync_rls` | Membership in `authenticated`; `create` on the schema only while the migration transfers the helpers to it, revoked after the last transfer and granted again first by a re-run; `execute` on `_require_rpc_context()`, `_readable_columns(text)`, and `_normalize_cell(text, text, jsonb)` after the blanket revoke |

### What `authenticated` deliberately does not get

- No table privilege on any bookkeeping table. `pull` and `push` are `SECURITY DEFINER` and never need a client `SELECT` on the change stream, and the change-capture triggers are `SECURITY DEFINER` too, so no client `INSERT` or `UPDATE` on `_change_pending`, `_changelog`, or `_tombstones` is required.
- No `EXECUTE` on any internal helper. Only the five public RPCs are granted.
- No `USAGE` on `_change_seq`, so a client cannot burn or forge a sequence number.
- No `EXECUTE` on `reap_tombstones`, `compact_changelog`, `prune_clients`, `_schedule_jobs`, or `jobs_status`, which cron, `kizunasync jobs run`, or the sync inspector's service-role connection calls instead. All five refuse every claim set that does not carry `role: service_role` regardless, so the `service_role` grant widens the operator surface only.
- No default-privileges mechanism protects a newly created function. A per-schema default-privileges entry only adds to [PostgreSQL](https://grokipedia.com/page/PostgreSQL)'s built-in defaults, and it cannot subtract the built-in `PUBLIC` execute default. A role-global entry leaks into every other schema in the database. The pack uses one explicit blanket `revoke` instead, and that statement runs after the last `create function`. Any migration that adds a function carries its own revoke. The audit test `packages/supabase-pack/tests/rpc-privilege-lockdown.test.ts` enforces that discipline.

### GUC call gate

Twenty-five of the internal helpers open with `_require_rpc_context()`, which raises `42501` unless `current_setting('kizunasync.rpc')` is `'1'`. Only `pull` and `push` set it, and only for their own transaction. The rest carry no such call, each for its own reason. The three trigger functions fire from ordinary application DML or from its commit and would break under the gate. The codec, comparison, matching, grammar, and envelope helpers hold no privileged state. `_render_user_row` reads under the caller's own policies, and `_register_client` checks the JWT user and session itself. `_seed_changelog` and `_relabel_changelog` run from a provisioning migration, outside any `pull` or `push`, and refuse any call that carries a JWT. Only `_pull_envelope` reaches `_conflicts_for_page`. With the grants above, a direct Data API call to any of them already fails on missing `EXECUTE`. The gate is the second line if a role ever gains one.

### How application-row authorization works

The caller's own Row Level Security is the sole authorization boundary, and the pack holds no ownership opinion. The `kizunasync_rls` owner cannot bypass RLS and inherits `request.jwt.claims`, so [`auth.uid()`](https://supabase.com/docs/guides/database/postgres/row-level-security#authuid) inside a helper is the real caller. A public-read table using `using (true)` returns every row, and a stricter policy filters the result. A tenant table's own policy authorizes against the tenant value, rather than comparing a column to `auth.uid()`. The [bucket](../resources/glossary.md#bucket) column only scopes which permitted rows a pull selects, as [Sync rules and buckets](../sync/sync-rules-and-buckets.md#1-understand-the-two-layers) explains. The three attachment RPCs are the exception in form only. They bypass the `attachments` policies as `DEFINER` and authorize the caller themselves. `attachment_confirm` requires a Storage object the caller owns under its own owner segment, `attachment_vacuum` deletes only a row whose `created_by` is `auth.uid()`, and `attachment_metadata` reads either the caller's own row or the caller's own RLS on the recorded table's row.

### Column-level privileges

Row Level Security decides which rows a caller reaches; Postgres's own column-level `GRANT` and `REVOKE` decide which columns of a reachable row a caller reads or writes, and the pack applies neither on the project's behalf. `pull` renders only the columns [`_readable_columns`](#internal-helpers) reports `authenticated` may `SELECT`, so a restricted column is absent from `row` rather than rendered as `null`. A pull is refused with `KZL02` when `id` or a requested table's `bucket_column` is unreadable, because those are the columns a pull selects to run at all. A push refuses a mutation that writes a column outside [`_writable_columns`](#internal-helpers) with the verdict reason `COLUMN_DENIED`, before applying anything else in that mutation, and `server_row` carries the row narrowed to the columns the caller may read. Both probes resolve the caller's role through [`_caller_role`](#internal-helpers): the transaction's `SET ROLE` first, the JWT `role` claim next, `authenticated` last. The [conflict journal](#kizunasync_conflict_journal) never surfaces a column `authenticated` cannot read, for the same reason `pull` omits it. Column privileges are granted to a role, not to a row, so every `authenticated` caller sees the same column projection regardless of which row they reach.

Supabase documents column-level security as an advanced feature: it is applied by hand in SQL or from the dashboard's policy editor, and neither the Supabase CLI nor [`supabase db diff`](https://supabase.com/docs/reference/cli/supabase-db-diff) manages or diffs it. Supabase also notes the Postgres ordering this depends on: a column-level `REVOKE` only narrows access once the table-level privilege is revoked too, because `has_column_privilege` folds a table-level grant into every column it covers regardless of a narrower column-level grant sitting beside it. [Column Level Security](https://supabase.com/docs/guides/auth/column-level-security) covers both points. [`kizunasync doctor`](../cli/cli.md#kizunasync-doctor)'s `column-privileges` check reports what a project's own grants currently allow.

### Tombstone visibility

A deleted row's image never travels, and only its primary key does. A tombstone rides the page when three conditions hold. Its key names a requested bucket value and its stored `bucket_snapshot` matches the pull params on the bucket column, since a bucket's other params filter live rows only. The caller holds a [bucket grant](#kizunasync_bucket_grants) for its table and bucket value, meaning an earlier pull delivered that caller a live row of the pair. Finally, the row's current state is not deliverable to the caller: it is gone, hidden by the caller's policies, or outside every requested bucket. Naming another tenant's bucket value therefore reveals none of its deleted keys, and a first pull carries no tombstone of a bucket value it had not received before. An unscoped pull of a bucketed table is refused with `KZL01` before any page is built. Unbucketed tables stay table-scoped under the grant `''`.

A row that a write moves to another bucket value leaves the old value a tombstone as well, which reaches the callers that received the row from the old value. A row that moved to another requested value, or was recreated where the caller can see it, travels as a row instead, so a caller that pulls both the old and the new value keeps the row, and a caller that cannot see a recreated row still drops its stale copy.

A policy stricter than the bucket does not replay on a row that is gone, and grants never expire by age, so two residuals remain. Members of the same bucket value receive the deleted keys of rows they never saw, and a member removed from a bucket keeps receiving the deletions of that bucket value. A table whose Row Level Security is finer than its bucket should mark removals with its `soft_delete_column`, so each removal travels as an ordinary row update under the caller's policies.

### Row Level Security policies

The pack creates four:

| Policy | Table | Command | Predicate |
|---|---|---|---|
| `Attachments are visible to their owner.` | `kizunasync.attachments` | `select` | `(select auth.uid()) = created_by` |
| `Attachments are writable by their owner.` | `kizunasync.attachments` | `insert` | `with check ((select auth.uid()) = created_by)` |
| `Attachments are updatable by their owner.` | `kizunasync.attachments` | `update` | `(select auth.uid()) = created_by`, in both `using` and `with check` |
| `kizunasync wakeup receive` | `realtime.messages` | `select` | `extension = 'broadcast'` and the topic is `like 'kizunasync:%'` |

Each one wraps the call as `(select auth.uid())` so PostgreSQL [caches the JWT lookup per statement](https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select). There is no send policy on `realtime.messages`: the trigger functions emit through `realtime.send` as `SECURITY DEFINER`, so no send policy is needed. [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#broadcast-and-presence-read) covers how a private channel reads that topic.

### What a caller can still learn

A few signals cross the authorization boundary in one direction: never a row, only that something happened to one. The [Realtime doorbell](#realtime-doorbell) names the table on its topic, and the `kizunasync wakeup receive` policy admits every authenticated caller, so any signed-in user can watch when a table it cannot read is written, never what changed. The pull [horizon](#kizunasyncpull) is one sequence numbered across every synced table by the same [stamp lock](#kizunasync_stamp_change), so a caller's own cursor reflects commit activity on tables outside its own policies as well as its own; [What commit-time numbering costs](../sync/fencing-and-horizons.md#what-commit-time-numbering-costs) covers the same lock from the write side. An error a pull or a push raises names the table and, on a bucketed table, the bucket column, because the schema and bucket gates run before Row Level Security does and have nothing else to report.

> **Danger**: Row Level Security must be enabled on every synced table. `pull` and `push` reach application rows through `kizunasync_rls`, and Postgres applies no policy at all to a table with Row Level Security disabled, to that role or any other, so a pull or a push hands every row to any signed-in caller. [`kizunasync init`](../cli/cli.md#kizunasync-init) and [`kizunasync sync`](../cli/cli.md#kizunasync-sync) refuse to sync a table in that state unless the run passes `--allow-no-rls`.

A trigger function the project attaches to a synced table runs in the same transaction as [`track_change()`](#kizunasynctrack_change) and [`track_delete()`](#kizunasynctrack_delete). [Set a fixed `search_path`](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker) on it the same way those two do, so a schema earlier on the caller's default path cannot shadow an unqualified reference inside it. [Retention](#retention) lists what removes each bookkeeping table's rows, none of it reachable by a signed-in caller.

### The surrounding project

The pack rides a Supabase project its owner operates, so TLS, Auth, and RLS remain platform controls rather than a second Kizuna data plane. The following are project settings, not pack behavior:

- A client carries a [publishable key](https://supabase.com/docs/guides/api/api-keys#publishable-keys-and-public-components) or the legacy anon JWT. A client never ships a [secret key](https://supabase.com/docs/guides/api/api-keys#secret-keys-and-elevated-access), because security rests on policies rather than on key secrecy.
- Policies authorize on `auth.uid()` and `app_metadata`, never on user-editable `user_metadata`.
- [Rotating to asymmetric JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys#rotating-and-revoking-keys) replaces reliance on the legacy JWT secret.
- [Network restrictions](https://supabase.com/docs/guides/platform/network-restrictions#to-get-started-via-the-dashboard), [Auth CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha#enable-captcha-protection-for-your-supabase-project), [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), and a [shorter access-token expiry](https://supabase.com/docs/guides/auth/sessions#what-are-recommended-values-for-access-token-jwt-expiration) stay available. A JWT remains valid until it expires, even after sign-out or user deletion.
- Clients point at the HTTPS project URL. The native HTTP stack uses rustls and trusts the Mozilla root certificates compiled into it rather than the device's certificate store, and it adds no certificate pinning.

## Local ports

| Service | Address |
|---------|---------|
| API ([PostgREST](https://postgrest.org/) and Auth) | `http://127.0.0.1:55321` |
| Postgres | `localhost:55322` |
| Studio | `http://127.0.0.1:55323` |

Defined in `packages/supabase-pack/supabase/config.toml`, which also sets the shadow database port to 55320. The `kizunasync` schema is [exposed through the Data API](https://supabase.com/docs/guides/api/using-custom-schemas#exposing-custom-schemas) alongside `public` and `graphql_public`, which is what makes the two RPCs callable. [Local Supabase](../cli/local-supabase.md#3-inspect-the-running-services) covers running the stack.

## Pack vs demo

The Supabase CLI reads one migrations directory, so the installable pack and the local demo fixtures share `packages/supabase-pack/supabase/migrations/`. `pack.manifest.json` beside that directory is the machine-readable record of which file is which, and `kizunasync init` reads it when emitting SQL into a real project. The `$comment` key at the top of the file is omitted here:

```json
{
  "pack": ["0001_kizuna_init.sql"],
  "demo": [
    "0002_example.sql"
  ]
}
```

The demo file creates the example table, its Storage setup, sample identities, the soft-delete column, and the shared-board and rate-limit policies. It is a local fixture and does not belong in an application's migration set.

The CLI records a full-file hash in a `pack-file` ledger row for version reconciliation. Object rows use name-derived identity hashes, and they drive teardown. The tables, indexes, sequence, and schema carry no object row, so a teardown leaves them in place. It never infers or removes unledgered application data, which [Remove](../cli/removing.md#3-check-what-remains) shows step by step.

## Realtime doorbell

`track_change` and `track_delete` call `realtime.send` with the payload `{"t": "<table>"}`, event `changed`, topic `kizunasync:<table>`, and the private flag set. The payload exists to satisfy the function signature: a client subscribes to the topic, discards what arrives, and pulls. A missed signal delays the next pull and loses nothing, because the poll fallback and the cursor carry correctness on their own.

A transaction sends one doorbell per table, however many of its rows it writes. The first write of a table sets a transaction-local flag with `set_config(..., true)`, named by the table's oid, and a later write of that table in the same transaction finds the flag and sends nothing, so a push that writes 500 rows of one table sends one Realtime message. A subtransaction that rolls back takes its flag and its message with it. `realtime.send` never raises, so a doorbell that is not delivered is caught by the client's poll.

A third emitter sits in `_register_client`, which sends `{"t": "_clients"}` on topic `kizunasync:clients` after it upserts a registration row, once per transaction by the same kind of flag. The `kizunasync wakeup receive` policy matches `kizunasync:%`, so that topic is readable by the same authenticated callers, and no client in this repository subscribes to it.

On the client side, [`createRealtimeWakeup`](./javascript/create-realtime-wakeup.md) from `@kizunasync/supabase` subscribes to those channels and implements the `IWakeup` port. [`createSupabaseKizunaSync`](./javascript/initializing.md#parameters) builds one for the config's tables unless the config sets `realtimeWakeups: false`, so an app calls it directly only to pass its own `wakeup`. Its `topicPrefix` option must match the `kizunasync` prefix the triggers use, and its `private` option must stay true while the `kizunasync wakeup receive` policy gates the topic.

```typescript
// src/kizunasync.ts (excerpt)
import { createRealtimeWakeup } from '@kizunasync/supabase'
import { supabase } from './supabase-client'

const wakeup = createRealtimeWakeup(supabase, {
  tables: ['todos'],
  topicPrefix: 'kizunasync',
  private: true,
})
```

## Related reference

- [What Kizuna installs](../cli/whats-installed.md): the same objects, grouped as a provisioning checklist.
- [Local Supabase](../cli/local-supabase.md): start, migrate, reset, stop.
- [Sync rules and buckets](../sync/sync-rules-and-buckets.md): `_config` rows and bucket filters.
- [Media and attachments](../attachments/media-and-attachments.md): `attachment_confirm` and `attachment_vacuum` in use.
- [Fencing and horizons](../sync/fencing-and-horizons.md): commit-time numbering, the pull horizon, and cursor semantics.
- [Protocol reference](./protocol.md): the wire shapes these RPCs produce.
- [CLI](../cli/cli.md): `kizunasync init`, `kizunasync deprovision`, `kizunasync doctor`.
- [Configuration](../cli/configuration.md): the `_config` and `_settings` columns, and what writes each one.
- [CI and CD](../operations/ci-cd.md#live-sql-conformance-gate): the job that replays transcript families against this pack.
