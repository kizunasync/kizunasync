-- Kizuna Sync SQL pack: the installable engine (schema, tables, functions,
-- grants, realtime doorbell, retention). This is the SINGLE pack migration that
-- `kizunasync init` emits into an app's supabase/migrations/. It carries NO demo data:
-- no public.todos, no per-project kizunasync._config rows, no triggers on user
-- tables: those are generated per-project by `kizunasync init` into
-- kizunasync._config and kizunasync._settings (see crates/kizunasync-cli/src/config_sql.rs).
-- The example's todos fixtures live in
-- the single DEMO migration 0002_example.sql.
--
-- This file installs the kizunasync schema: its tables, the five public RPCs
-- (pull, push, attachment_confirm, attachment_metadata, attachment_vacuum), the
-- internal helper functions they call, the change-capture trigger functions and
-- the commit-time stamp trigger on kizunasync._change_pending, the changelog seed
-- provisioning runs once it has attached the capture triggers, the relabel it
-- runs after a table's bucket column changes, the three cron jobs that reap
-- tombstones, compact the changelog and prune stale clients, and the
-- provisioning ledger kizunasync._provisions.
--
-- Provisioned by `kizunasync init`. `kizunasync deprovision` removes the subset recorded in
-- kizunasync._provisions; the base schema, bookkeeping tables, indexes, and
-- sequence deliberately remain. User tables are NEVER altered by this file.

create schema if not exists kizunasync;

-- MARK: - RLS-enforcing owner role
--
-- The user-row read/write helpers are SECURITY DEFINER OWNED BY this role. It is
-- NOBYPASSRLS and a member of `authenticated`, so (1) it inherits the per-table
-- grants + auth-schema access `authenticated` holds, and (2) request.jwt.claims is
-- inherited into the DEFINER context, so auth.uid() is the real caller. Because the
-- owner cannot bypass RLS, the caller's own policies govern every user-row touch:
-- a public-read policy (`using (true)`) returns all rows, a strict policy filters,
-- and the pack imposes NO ownership opinion of its own. The bucket column is a
-- pull-scoping filter applied UNDER RLS (it can only narrow, never widen), never an
-- authorization gate. postgres is granted the role so it can own/alter the helpers
-- and act as their owner; the role gets CREATE on this schema so the ownership
-- transfer (ALTER FUNCTION ... OWNER TO) succeeds on the stock Supabase stack, and
-- gives it back after the last transfer. A re-run grants it again here first.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kizunasync_rls') then
    create role kizunasync_rls nologin nobypassrls inherit;
  end if;
end $$;

grant authenticated to kizunasync_rls;
grant kizunasync_rls to postgres;
grant create on schema kizunasync to kizunasync_rls;

-- MARK: - Provisions ledger

create table if not exists kizunasync._provisions (
  id bigint generated always as identity primary key,
  object_kind text not null,           -- 'function' | 'cron' | 'policy' | 'role' | 'trigger' | 'config' | 'pack-file'
  object_name text not null,
  content_hash text not null,          -- object rows: md5 of the base name, not the body; config rows: md5 of table:sync_mode:bucket_column; pack-file rows: md5 of the file SQL
  pack_version text not null,
  created_at timestamptz not null default now(),
  object_args text,                    -- function identity args; deprovision drops the exact overload
  unique (object_kind, object_name)
);

comment on column kizunasync._provisions.object_args is
  'For object_kind=function: the identity argument signature '
  '(pg_get_function_identity_arguments), so deprovision drops the exact overload. '
  'NULL for every other kind.';

-- MARK: - The global change sequence
--
-- Per-table sequences forfeit cross-table writes-follow-reads (P:session-guarantees-and-exactly-once-effect).
-- kizunasync._stamp_change is the only caller of nextval, at commit. CACHE 1 is
-- load-bearing: a cached block would let a later stamp hand out a value below
-- one that is already visible.

-- MARK: - global-change-sequence
create sequence if not exists kizunasync._change_seq as bigint cache 1;
-- `if not exists` leaves an existing sequence as it is, so a re-apply restores
-- the cache here.
alter sequence kizunasync._change_seq cache 1;

-- MARK: - Config
--
-- EMPTY in the pack: each project's tables are upserted here by `kizunasync init`
-- (the demo's todos row lives in 0002_example.sql).

create table if not exists kizunasync._config (
  table_name text primary key,
  sync_mode text not null check (sync_mode in ('pull-only', 'read-write')),
  -- MARK: - config-bucket-column
  bucket_column text,                  -- declared, indexed owner/tenant column
  soft_delete_column text,
  -- MARK: - config-tombstone-ttl-days
  tombstone_ttl_days integer,
  -- MARK: - config-min-schema-version
  min_schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  conflict_mode text not null default 'arrival' check (conflict_mode in ('arrival', 'hlc')),
  register_clients boolean not null default false,
  conflict_journal boolean not null default false
);

comment on column kizunasync._config.tombstone_ttl_days is
  'Per-table tombstone lifetime in days. NULL means the project default in '
  'kizunasync._settings.tombstone_ttl_days, which kizunasync.reap_tombstones() '
  'coalesces to.';

comment on column kizunasync._config.conflict_journal is
  'Opt-in per-table loser-value journal (P:session-guarantees-and-exactly-once-effect / D-conflict-journal-visibility). When true, overwritten same-column '
  'values are recorded in kizunasync._conflict_journal and may appear as pull conflicts.';

-- MARK: - Client registry
--
-- Opt-in per table (_config.register_clients). It exists so retention knows how
-- far behind the fleet is: compact_changelog() floors on the live clients' cursors
-- and prune_clients() drops the ones past _settings.client_ttl_days. Exactly-once
-- apply is _verdicts, never this table.

-- MARK: - clients-registry
create table if not exists kizunasync._clients (
  client_id uuid primary key,
  user_id uuid not null,
  -- MARK: - clients-cursor
  cursor text not null default '0',    -- opaque cursor token as pull returned it (D-cursor-opaque-token)
  -- MARK: - clients-last-mutation-id
  last_mutation_id uuid,
  schema_version integer not null default 1,
  last_seen timestamptz not null default now()
);

create index if not exists _clients_user_id_idx on kizunasync._clients (user_id);
create index if not exists _clients_last_seen_idx on kizunasync._clients (last_seen);

comment on table kizunasync._clients is
  'Per-client watermark for retention and staleness, written by kizunasync.pull '
  'and kizunasync.push when the response carries no signal, a requested table '
  'sets _config.register_clients, and the request carries a client_id or the JWT '
  'a session_id. Keyed by the request client_id, or by the JWT session_id when '
  'the request carries none.';

comment on column kizunasync._clients.last_mutation_id is
  'The last mutation id the client acknowledged through push. A per-client '
  'progress watermark for operators: replay protection is _verdicts.';

-- MARK: - Changelog
--
-- One row per committed upsert, written by kizunasync._stamp_change while the
-- writing transaction commits. seq has no default: only the stamp draws it.
-- bucket_value is the written row's _config.bucket_column value as text, null on
-- an unbucketed table, so a pull of a bucketed table reads only the entries of
-- the values it requests, through _changelog_bucket_idx.

create table if not exists kizunasync._changelog (
  seq bigint not null,
  table_name text not null,
  pk uuid not null,
  -- MARK: - changelog-op
  op text not null check (op in ('upsert', 'delete')),
  xid xid8 not null default pg_current_xact_id(),
  arrived_at timestamptz not null default clock_timestamp(),
  -- MARK: - changelog-bucket-value
  bucket_value text,
  primary key (table_name, pk, seq)
);

create index if not exists _changelog_seq_idx on kizunasync._changelog (seq);
create index if not exists _changelog_bucket_idx on kizunasync._changelog (table_name, bucket_value, seq);

-- MARK: - Tombstones
--
-- Upserted by kizunasync._stamp_change while the deleting transaction commits;
-- seq has no default, as on _changelog. A row leaves one tombstone per bucket
-- value it left: a delete, or a write that moved it to another value. A pull of
-- a bucketed table reads only the tombstones of the values it requests, through
-- _tombstones_bucket_idx.

-- MARK: - tombstones-table
create table if not exists kizunasync._tombstones (
  -- MARK: - tombstones-table-name
  table_name text not null,
  -- MARK: - tombstones-pk
  pk uuid not null,
  -- MARK: - tombstones-seq
  seq bigint not null,
  -- MARK: - tombstones-deleted-at
  deleted_at timestamptz not null default now(),
  xid xid8 not null default pg_current_xact_id(),
  bucket_snapshot jsonb not null default '{}'::jsonb,
  -- MARK: - tombstones-bucket-value
  bucket_value text not null default '',
  primary key (table_name, pk, bucket_value)
);

comment on column kizunasync._tombstones.bucket_snapshot is
  'Projected bucket-column image of OLD at delete time: never a full row image.';

comment on column kizunasync._tombstones.bucket_value is
  'The bucket value the row left, as text; empty for an unbucketed table or a null '
  'value. Part of the key, so a move-out and a later delete keep one tombstone each.';

create index if not exists _tombstones_seq_idx on kizunasync._tombstones (seq);
create index if not exists _tombstones_bucket_idx on kizunasync._tombstones (table_name, bucket_value, seq);

-- MARK: - Bucket grants
--
-- One row per (user, table, bucket value) a pull page delivered a live row
-- from, '' on an unbucketed table, written by _record_bucket_grants. A tombstone
-- reaches a caller only for a pair that caller holds, and a committed tombstone
-- answers DELETE_WINS only to such a caller (D-tombstone-delivery). Grants never
-- expire by age: one older than the tombstone TTL cannot be proven unneeded,
-- because the reap horizon moves only when a tombstone is actually reaped.
-- prune_clients() deletes the grants of a user missing from auth.users.

-- MARK: - bucket-grants
create table if not exists kizunasync._bucket_grants (
  user_id uuid not null,
  table_name text not null,
  bucket_value text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, table_name, bucket_value)
);

-- MARK: - Pending changes
--
-- A row lives only inside its writing transaction: the commit-time stamp numbers
-- it and deletes it before the commit, so outside an open transaction the table
-- is empty. UNLOGGED because no row outlives its transaction (a crash loses only
-- uncommitted work). bucket_value carries the label the stamp copies onto the
-- changelog row or the tombstone.

create unlogged table if not exists kizunasync._change_pending (
  id bigint generated always as identity primary key,
  table_name text not null,
  pk uuid not null,
  op text not null check (op in ('upsert', 'delete')),
  bucket_snapshot jsonb not null default '{}'::jsonb,
  arrived_at timestamptz not null default clock_timestamp(),
  bucket_value text
);

create index if not exists _change_pending_row_idx on kizunasync._change_pending (table_name, pk);

-- MARK: - Per-row HLC high-water

create table if not exists kizunasync._row_hlc (
  table_name text not null,
  pk uuid not null,
  column_hlc jsonb not null default '{}'::jsonb,
  primary key (table_name, pk)
);

-- MARK: - Conflict journal
--
-- Server-side audit of overwritten same-column values. Pull attaches matching
-- rows as optional D-conflict-journal-visibility conflicts when winner_seq is in the delivered page.
-- Written only when
-- _config.conflict_journal is true for the table.
-- Does NOT draw from _change_seq: this is not a change-capture stream. A row is
-- written with pending_id naming the winning write's queued change; the
-- commit-time stamp copies that change's number into winner_seq and clears
-- pending_id, so a committed row always carries winner_seq.

create table if not exists kizunasync._conflict_journal (
  id bigint generated always as identity primary key,
  table_name text not null,
  pk uuid not null,
  column_name text not null,
  loser_value jsonb not null,
  winner_mutation_id uuid not null,
  conflict_mode text not null check (conflict_mode in ('arrival', 'hlc')),
  winner_seq bigint,
  pending_id bigint,
  recorded_at timestamptz not null default clock_timestamp()
);

create index if not exists _conflict_journal_row_idx
  on kizunasync._conflict_journal (table_name, pk, recorded_at desc);

create index if not exists _conflict_journal_winner_seq_idx
  on kizunasync._conflict_journal (winner_seq);

create index if not exists _conflict_journal_pending_idx on kizunasync._conflict_journal (pending_id) where pending_id is not null;

comment on table kizunasync._conflict_journal is
  'Opt-in per-table loser-value journal (P:session-guarantees-and-exactly-once-effect / D-conflict-journal-visibility). Pull attaches matching rows as optional conflicts when winner_seq is in the delivered page.';

-- MARK: - Verdict ledger
--
-- A mutation id is no secret (a pulled conflict names the winner's), so a replay
-- answers only the user who pushed it: user_id is that caller's auth.uid(), and
-- table_name and pk name the row a replay renders again. The verdict is stored
-- with server_row nulled, so the ledger holds no row copy. prune_clients()
-- deletes entries older than _settings.client_ttl_days.

create table if not exists kizunasync._verdicts (
  mutation_id uuid primary key,
  verdict jsonb not null,
  recorded_at timestamptz not null default now(),
  user_id uuid,
  table_name text,
  pk uuid
);

create index if not exists _verdicts_recorded_at_idx on kizunasync._verdicts (recorded_at);

-- MARK: - Persistent reap watermark

create table if not exists kizunasync._reap_state (
  id boolean primary key default true,
  reaped_seq bigint not null default 0,
  reaped_at timestamptz,
  constraint _reap_state_singleton check (id)
);

insert into kizunasync._reap_state (id) values (true)
on conflict (id) do nothing;

-- MARK: - Cron schedule grammar
--
-- Five whitespace-separated fields, each a comma list of `*`, `n`, `n-m`, `*/k`
-- or `n-m/k` inside the pg_cron ranges (minute 0-59, hour 0-23, day 1-31, month
-- 1-12, weekday 0-7). Names, seconds and `@` macros are refused: a typo fails at
-- the write instead of scheduling a job that never runs. `kizunasync` validates the
-- same grammar before it writes the row.

-- MARK: - cron-schedule-grammar
create or replace function kizunasync._is_cron_schedule(p_schedule text)
returns boolean language plpgsql immutable set search_path to '' as $$
declare
  v_bounds constant integer[][] := array[array[0, 59], array[0, 23], array[1, 31], array[1, 12], array[0, 7]];
  v_fields text[];
  v_field  text;
  v_item   text;
  v_step   text;
  v_range  text;
  v_low    integer;
  v_high   integer;
  v_index  integer;
begin
  if p_schedule is null then
    return false;
  end if;
  v_fields := regexp_split_to_array(btrim(p_schedule), '\s+');
  if array_length(v_fields, 1) is distinct from 5 then
    return false;
  end if;
  for v_index in 1..5 loop
    v_field := v_fields[v_index];
    -- string_to_array('', ',') is an empty array, so an empty field would skip the item checks below.
    if v_field = '' then
      return false;
    end if;
    foreach v_item in array string_to_array(v_field, ',')
    loop
      if v_item !~ '^(\*|\d{1,2}(-\d{1,2})?)(/\d{1,2})?$' then
        return false;
      end if;
      v_step := split_part(v_item, '/', 2);
      if v_step <> '' and v_step::integer < 1 then
        return false;
      end if;
      v_range := split_part(v_item, '/', 1);
      if v_range = '*' then
        continue;
      end if;
      -- A step qualifies `*` or an explicit `n-m` range, never a lone `n`.
      if v_step <> '' and position('-' in v_range) = 0 then
        return false;
      end if;
      v_low := split_part(v_range, '-', 1)::integer;
      v_high := coalesce(nullif(split_part(v_range, '-', 2), ''), split_part(v_range, '-', 1))::integer;
      if v_low < v_bounds[v_index][1] or v_high > v_bounds[v_index][2] or v_low > v_high then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end $$;

-- MARK: - Global push policy + retention knobs
--
-- A fresh install is seeded with batches of at most 500 mutations and non-atomic
-- pushes allowed; a re-applied pack keeps the row it finds. `kizunasync init`
-- overwrites this row from the wizard or `--max-batch-size` / `--require-atomic`
-- flags.

create table if not exists kizunasync._settings (
  id boolean primary key default true check (id),
  max_batch_size integer check (max_batch_size is null or max_batch_size >= 1),
  require_atomic boolean not null default false,
  -- 03:16 is John 3:16: God loved the world, and whoever believes keeps that in the heart.
  reap_schedule text not null default '16 3 * * *' check (kizunasync._is_cron_schedule(reap_schedule)),
  compact_schedule text not null default '47 3 * * *' check (kizunasync._is_cron_schedule(compact_schedule)),
  client_prune_schedule text not null default '31 3 * * *' check (kizunasync._is_cron_schedule(client_prune_schedule)),
  client_ttl_days integer not null default 90 check (client_ttl_days >= 1),
  hlc_max_skew_ms integer not null default 5000 check (hlc_max_skew_ms >= 0),
  tombstone_ttl_days integer not null default 30 check (tombstone_ttl_days >= 1),
  max_pull_scan integer not null default 5000 check (max_pull_scan >= 1)
);

comment on table kizunasync._settings is
  'Single-row server deployment config (not protocol): the push policy, the pull '
  'scan cap, and the retention knobs and job schedules. max_batch_size: NULL = '
  'unlimited, 1 = no batches. require_atomic: when true, non-atomic pushes are '
  'rejected. Enforced fail-loud in kizunasync._push_guard.';

comment on column kizunasync._settings.max_pull_scan is
  'Candidates one pull page examines at most, the rows it withholds included. '
  'kizunasync._pull_page stops there with has_more true and continues the '
  'transfer from the last candidate it examined.';

comment on column kizunasync._settings.reap_schedule is
  'Crontab (UTC) kizunasync._schedule_jobs() gives the kizunasync-reap-tombstones job.';

comment on column kizunasync._settings.compact_schedule is
  'Crontab (UTC) kizunasync._schedule_jobs() gives the kizunasync-compact-changelog job.';

comment on column kizunasync._settings.client_prune_schedule is
  'Crontab (UTC) kizunasync._schedule_jobs() gives the kizunasync-prune-clients job.';

comment on column kizunasync._settings.client_ttl_days is
  'Days of silence after which a client row is stale: kizunasync.prune_clients() '
  'deletes it, and kizunasync.compact_changelog() ignores its cursor when it '
  'computes the compaction floor.';

comment on column kizunasync._settings.hlc_max_skew_ms is
  'Forward-drift tolerance for an origin HLC. kizunasync._push_guard reads it once '
  'per push and kizunasync._apply_hlc clamps every hlc-mode write to it.';

comment on column kizunasync._settings.tombstone_ttl_days is
  'Project default tombstone lifetime. kizunasync.reap_tombstones() applies it to '
  'a _config row whose own tombstone_ttl_days is null and to every tombstone of a '
  'table that has no _config row at all.';

insert into kizunasync._settings (id, max_batch_size, require_atomic)
values (true, 500, false)
on conflict (id) do nothing;

-- MARK: - Attachments meta

create table if not exists kizunasync.attachments (
  id uuid primary key,
  bucket_id text not null,
  object_path text not null,
  sha256 text,
  size bigint,
  media_type text,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  table_name text
);

-- One metadata row per stored object (the confirm idempotency key).
create unique index if not exists attachments_object_uidx
  on kizunasync.attachments (bucket_id, object_path);

alter table kizunasync.attachments enable row level security;

drop policy if exists "Attachments are visible to their owner." on kizunasync.attachments;
create policy "Attachments are visible to their owner."
  on kizunasync.attachments for select to authenticated
  using ((select auth.uid()) = created_by);

drop policy if exists "Attachments are writable by their owner." on kizunasync.attachments;
create policy "Attachments are writable by their owner."
  on kizunasync.attachments for insert to authenticated
  with check ((select auth.uid()) = created_by);

drop policy if exists "Attachments are updatable by their owner." on kizunasync.attachments;
create policy "Attachments are updatable by their owner."
  on kizunasync.attachments for update to authenticated
  using ((select auth.uid()) = created_by)
  with check ((select auth.uid()) = created_by);

-- MARK: - Change-capture triggers
--
-- SECURITY DEFINER so triggers can write bookkeeping tables without granting
-- INSERT on them to `authenticated` (clients must never write those tables
-- directly via the Data API). track_change and track_delete queue each change in
-- _change_pending instead of numbering it, and emit a contentless realtime
-- doorbell (table name only, never row data) once per table per transaction: the
-- first write of a table sets a transaction-local flag, and later writes of that
-- table in the same transaction find it and send nothing, so a batch of N rows is
-- one realtime message, not N. The flag is named by the table's oid because a
-- setting name accepts only plain identifiers and a table name need not be one.
-- realtime.send never raises, so a doorbell that is not delivered is caught by
-- the client's poll. A subtransaction that rolls back takes its flag and its
-- message with it.
-- _stamp_change numbers every queued change while the writing transaction
-- commits and writes it to _changelog or _tombstones. Every function that writes
-- or compares a bucket label or a grant value pins the time zone to UTC, because
-- to_jsonb renders a timestamptz in the session TimeZone: a writer and a puller
-- in different zones spell one label.

create or replace function kizunasync.track_change() returns trigger
language plpgsql security definer set search_path to '' set timezone to 'UTC' as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
  v_col text;
begin
  -- An update that changes no column is not a change to replicate. Without this
  -- guard an idempotent upsert on every app boot fans out a changelog row, a
  -- doorbell, and a pull to every client. The rows compare as jsonb: `json`,
  -- `xml`, and `point` have no equality operator, so a row comparison would fail
  -- every update of a table that carries one.
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    if v_new = v_old then
      return new;
    end if;
  end if;
  select c.bucket_column into v_col
  from kizunasync._config c
  where c.table_name = tg_table_name;

  -- MARK: - bucket-move-out
  -- A write that moves the row to another bucket value leaves the old value a
  -- tombstone, queued first so it takes the lower seq in the same commit.
  if v_col is not null and v_old is not null and (v_new ->> v_col) is distinct from (v_old ->> v_col) then
    insert into kizunasync._change_pending (table_name, pk, op, bucket_snapshot, bucket_value)
    values (tg_table_name, old.id, 'delete', jsonb_build_object(v_col, v_old -> v_col), v_old ->> v_col);
  end if;
  insert into kizunasync._change_pending (table_name, pk, op, bucket_value)
  values (tg_table_name, new.id, 'upsert', v_new ->> v_col);
  if current_setting('kizunasync.doorbell_' || tg_relid, true) is distinct from '1' then
    perform set_config('kizunasync.doorbell_' || tg_relid, '1', true);
    perform realtime.send(jsonb_build_object('t', tg_table_name), 'changed', 'kizunasync:' || tg_table_name, true);
  end if;
  return new;
end $$;

-- MARK: - tombstone-trigger
-- A delete also drops the row's HLC state here, whoever deletes, through push or
-- straight from SQL, so no stamp outlives the row it describes.
create or replace function kizunasync.track_delete() returns trigger
language plpgsql security definer set search_path to '' set timezone to 'UTC' as $$
declare
  v_col text;
  v_snap jsonb := '{}'::jsonb;
begin
  select c.bucket_column into v_col
  from kizunasync._config c
  where c.table_name = tg_table_name;
  if v_col is not null then
    v_snap := jsonb_build_object(v_col, to_jsonb(old) -> v_col);
  end if;
  insert into kizunasync._change_pending (table_name, pk, op, bucket_snapshot, bucket_value)
  values (tg_table_name, old.id, 'delete', v_snap, to_jsonb(old) ->> v_col);
  delete from kizunasync._row_hlc where table_name = tg_table_name and pk = old.id;
  if current_setting('kizunasync.doorbell_' || tg_relid, true) is distinct from '1' then
    perform set_config('kizunasync.doorbell_' || tg_relid, '1', true);
    perform realtime.send(jsonb_build_object('t', tg_table_name), 'changed', 'kizunasync:' || tg_table_name, true);
  end if;
  return old;
end $$;

-- The commit-time stamp. Only this function draws from kizunasync._change_seq,
-- and only while it holds one transaction-scoped advisory lock. PostgreSQL marks
-- a committing transaction visible to new snapshots before it releases that
-- transaction's locks (in CommitTransaction, ProcArrayEndTransaction runs after
-- RecordTransactionCommit and before the lock release; PostgreSQL's own waits on
-- another transaction rely on this order). So a transaction can draw a number
-- only after every earlier drawer is visible or aborted: any snapshot sees the
-- drawn numbers as a prefix, except numbers an aborted transaction consumed, and
-- the largest number visible in a snapshot is a cursor below which no later
-- commit can land. An open transaction has drawn nothing, so it never holds the
-- cursor back. If a subtransaction that ran a stamp aborts, PostgreSQL rolls the
-- stamp back and fires that deferred event again later, so every queued change
-- that commits is numbered exactly once.
--
-- The lock key is the two-integer form, whose key space does not overlap the
-- one-bigint form; 1264210777 is 0x4B5A5359, ASCII KZSY. The lock is reentrant,
-- so later stamps in the same transaction do not wait. There is deliberately no
-- _require_rpc_context(): a direct SQL write to a synced table is stamped too.
-- arrived_at and the bucket label are copied from the queued row, so they keep
-- the write time and the bucket value of the write. A tombstone is keyed by the
-- bucket value the row left ('' when there is none), and a re-delete refreshes
-- seq, deleted_at, xid, and bucket_snapshot on the tombstone of that value, so
-- the horizon reads it as a new change.
create or replace function kizunasync._stamp_change() returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  v_seq bigint;
begin
  perform pg_advisory_xact_lock(1264210777, 1);
  v_seq := nextval('kizunasync._change_seq');
  if new.op = 'upsert' then
    insert into kizunasync._changelog (seq, table_name, pk, op, arrived_at, bucket_value)
    values (v_seq, new.table_name, new.pk, 'upsert', new.arrived_at, new.bucket_value);
  else
    insert into kizunasync._tombstones (seq, table_name, pk, bucket_snapshot, bucket_value)
    values (v_seq, new.table_name, new.pk, new.bucket_snapshot, coalesce(new.bucket_value, ''))
    on conflict (table_name, pk, bucket_value) do update
      set seq = excluded.seq,
          deleted_at = now(),
          xid = pg_current_xact_id(),
          bucket_snapshot = excluded.bucket_snapshot;
  end if;
  update kizunasync._conflict_journal
     set winner_seq = v_seq, pending_id = null
   where pending_id = new.id;
  delete from kizunasync._change_pending where id = new.id;
  return null;
end $$;

drop trigger if exists kizunasync_stamp_change on kizunasync._change_pending;
create constraint trigger kizunasync_stamp_change
  after insert on kizunasync._change_pending
  deferrable initially deferred
  for each row execute function kizunasync._stamp_change();

-- MARK: - seed-changelog
--
-- Rows a table held before its capture triggers existed have no changelog entry,
-- and pull reads only the changelog, so a bootstrap would never deliver them.
-- Provisioning calls this after it attaches the triggers. It queues one upsert,
-- labeled like track_change labels one, for every row of the configured table
-- that has neither a changelog entry nor a queued change, and the commit-time
-- stamp numbers them like any other write, so seqs stay commit-ordered and a
-- second call queues nothing. The stamp holds its advisory lock while it numbers
-- every seeded row, so seeding a large table delays other synced commits until
-- the provisioning transaction ends. Returns the number of rows it queued. It
-- runs from a migration, never from pull or push, so it refuses any call that
-- carries a JWT instead of taking the rpc gate.
create or replace function kizunasync._seed_changelog(p_table text) returns bigint
language plpgsql security definer set search_path to '' set timezone to 'UTC' as $_$
declare
  v_col    text;
  v_queued bigint;
begin
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: _seed_changelog is not a client RPC'
      using errcode = '42501';
  end if;

  select c.bucket_column into v_col
    from kizunasync._config c
   where c.table_name = p_table;
  if not found then
    raise exception 'kizunasync._seed_changelog(): table "%" has no _config row', p_table
      using errcode = 'feature_not_supported';
  end if;

  execute format(
    'insert into kizunasync._change_pending (table_name, pk, op, bucket_value) '
    || 'select $1, t.id, ''upsert'', to_jsonb(t) ->> $2 from %I.%I t '
    || 'where not exists (select 1 from kizunasync._changelog cl where cl.table_name = $1 and cl.pk = t.id) '
    || 'and not exists (select 1 from kizunasync._change_pending p where p.table_name = $1 and p.pk = t.id)',
    'public', p_table
  ) using p_table, v_col;
  get diagnostics v_queued = row_count;

  return v_queued;
end $_$;

-- MARK: - relabel-changelog
--
-- Provisioning calls this after it changes a table's _config.bucket_column, so
-- the labels a pull reads name the new column. Every changelog row of a pk the
-- table still holds takes its label from that row; a changelog row whose pk is
-- gone is deleted, since its tombstone supersedes it. A tombstone is re-keyed by
-- the new column's value in its snapshot, and one whose snapshot does not carry
-- that column is deleted: it cannot be scoped by the new column, so a bucket
-- column change makes every device bootstrap again. Of two tombstones of one pk
-- that re-key to the same value, the older goes, as a re-delete refreshes one.
-- The table's grants name values of the old column, so they go too. Returns the
-- number of changelog rows it relabeled. Like the seed, it runs from a
-- migration and refuses any call that carries a JWT.
create or replace function kizunasync._relabel_changelog(p_table text) returns bigint
language plpgsql security definer set search_path to '' set timezone to 'UTC' as $_$
declare
  v_col       text;
  v_relabeled bigint;
begin
  if nullif(current_setting('request.jwt.claims', true), '') is not null
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: _relabel_changelog is not a client RPC'
      using errcode = '42501';
  end if;

  select c.bucket_column into v_col
    from kizunasync._config c
   where c.table_name = p_table;
  if not found then
    raise exception 'kizunasync._relabel_changelog(): table "%" has no _config row', p_table
      using errcode = 'feature_not_supported';
  end if;

  execute format(
    'delete from kizunasync._changelog cl where cl.table_name = $1 '
    || 'and not exists (select 1 from %I.%I t where t.id = cl.pk)',
    'public', p_table
  ) using p_table;
  execute format(
    'update kizunasync._changelog cl set bucket_value = to_jsonb(t) ->> $2 '
    || 'from %I.%I t where cl.table_name = $1 and cl.pk = t.id',
    'public', p_table
  ) using p_table, v_col;
  get diagnostics v_relabeled = row_count;

  delete from kizunasync._tombstones t
   where t.table_name = p_table
     and not coalesce(t.bucket_snapshot ? v_col, false);
  delete from kizunasync._tombstones t
   where t.table_name = p_table
     and exists (
       select 1
         from kizunasync._tombstones o
        where o.table_name = t.table_name
          and o.pk = t.pk
          and o.seq > t.seq
          and coalesce(o.bucket_snapshot ->> v_col, '') = coalesce(t.bucket_snapshot ->> v_col, '')
     );
  update kizunasync._tombstones t
     set bucket_value = coalesce(t.bucket_snapshot ->> v_col, '')
   where t.table_name = p_table
     and t.bucket_value is distinct from coalesce(t.bucket_snapshot ->> v_col, '');

  delete from kizunasync._bucket_grants g where g.table_name = p_table;

  return v_relabeled;
end $_$;

-- MARK: - HLC helpers

-- MARK: - hlc-skew-clamp
create or replace function kizunasync._clamp_hlc(p_hlc text, p_now timestamptz, p_max_skew_ms integer)
returns text language sql immutable set search_path to '' as $$
  with parts as (
    select
      split_part(p_hlc, '|', 1) as iso,
      split_part(p_hlc, '|', 2) as logical,
      split_part(p_hlc, '|', 3) as node,
      to_char(
        (p_now + make_interval(secs => p_max_skew_ms / 1000.0)) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) as ceiling
  )
  select case
    when iso collate "C" > ceiling collate "C"
      then ceiling || '|' || logical || '|' || node
    else p_hlc
  end
  from parts;
$$;

create or replace function kizunasync._compare_hlc(p_a text, p_b text)
returns integer language sql immutable set search_path to '' as $$
  with parts as (
    select
      coalesce(split_part(p_a, '|', 1), '') as iso_a,
      coalesce(split_part(p_b, '|', 1), '') as iso_b,
      coalesce(nullif(split_part(p_a, '|', 2), ''), '0')::bigint as logical_a,
      coalesce(nullif(split_part(p_b, '|', 2), ''), '0')::bigint as logical_b,
      coalesce(split_part(p_a, '|', 3), '') as node_a,
      coalesce(split_part(p_b, '|', 3), '') as node_b
  )
  select case
    when iso_a collate "C" <> iso_b collate "C"
      then case when iso_a collate "C" < iso_b collate "C" then -1 else 1 end
    when logical_a <> logical_b then case when logical_a < logical_b then -1 else 1 end
    when node_a collate "C" < node_b collate "C" then -1
    when node_a collate "C" > node_b collate "C" then 1
    else 0
  end
  from parts;
$$;

-- MARK: - Cursor codec
--
-- A checkpoint token is `<high-water>`, optionally followed by `~<holes>`. A
-- page the limit cuts returns a continuation token instead, which prefixes
-- `<start>:`, the high-water of the checkpoint its transfer started from (`0`
-- for a bootstrap). Delivery reads the high-water and the holes. Checkpoint
-- expiry reads the start, because a continuation is a position inside a
-- transfer, not a checkpoint.

create or replace function kizunasync._cursor_high_water(p_cursor text)
returns bigint language plpgsql immutable set search_path to '' as $$
declare
  pos text;
  hw bigint;
  holes text[];
  i integer;
  n bigint;
  prev bigint := 0;
begin
  if p_cursor is null
     or p_cursor !~ '^((0|[1-9][0-9]*):)?(0|[1-9][0-9]*)(~[1-9][0-9]*(\.[1-9][0-9]*)*)?$' then
    raise exception 'invalid cursor token: %', coalesce(p_cursor, '');
  end if;
  pos := regexp_replace(p_cursor, '^[0-9]+:', '');
  hw := split_part(pos, '~', 1)::bigint;
  if position('~' in pos) = 0 then
    return hw;
  end if;
  holes := string_to_array(split_part(pos, '~', 2), '.');
  for i in 1 .. coalesce(array_length(holes, 1), 0) loop
    n := holes[i]::bigint;
    if n >= hw or (i > 1 and n <= prev) then
      raise exception 'invalid cursor token: %', p_cursor;
    end if;
    prev := n;
  end loop;
  return hw;
end;
$$;

create or replace function kizunasync._cursor_holes(p_cursor text)
returns bigint[] language plpgsql immutable set search_path to '' as $$
declare
  pos text;
  hw bigint;
  holes text[];
  i integer;
  n bigint;
  prev bigint := 0;
  out bigint[] := array[]::bigint[];
begin
  if p_cursor is null
     or p_cursor !~ '^((0|[1-9][0-9]*):)?(0|[1-9][0-9]*)(~[1-9][0-9]*(\.[1-9][0-9]*)*)?$' then
    raise exception 'invalid cursor token: %', coalesce(p_cursor, '');
  end if;
  pos := regexp_replace(p_cursor, '^[0-9]+:', '');
  if position('~' in pos) = 0 then
    return out;
  end if;
  hw := split_part(pos, '~', 1)::bigint;
  holes := string_to_array(split_part(pos, '~', 2), '.');
  for i in 1 .. coalesce(array_length(holes, 1), 0) loop
    n := holes[i]::bigint;
    if n >= hw or (i > 1 and n <= prev) then
      raise exception 'invalid cursor token: %', p_cursor;
    end if;
    out := out || n;
    prev := n;
  end loop;
  return out;
end;
$$;

-- Null when the token carries no start, that is, for every checkpoint token.
create or replace function kizunasync._cursor_start(p_cursor text)
returns bigint language plpgsql immutable set search_path to '' as $$
begin
  -- The high-water decoder validates the whole token, so a malformed one raises here too.
  perform kizunasync._cursor_high_water(p_cursor);
  if position(':' in p_cursor) = 0 then
    return null;
  end if;
  return split_part(p_cursor, ':', 1)::bigint;
end;
$$;

create or replace function kizunasync._encode_cursor(p_high_water bigint, p_holes bigint[])
returns text language sql immutable set search_path to '' as $$
  select case
    when p_holes is null or array_length(p_holes, 1) is null
      then p_high_water::text
    else p_high_water::text || '~' || (
      select string_agg(h::text, '.' order by h)
      from unnest(p_holes) as h
    )
  end;
$$;

-- The pack emits continuations without holes, so the token is the start and the page's last seq.
create or replace function kizunasync._encode_continuation(p_start bigint, p_high_water bigint)
returns text language sql immutable set search_path to '' as $$
  select p_start::text || ':' || p_high_water::text;
$$;

-- MARK: - Identity + schema-version helpers

create or replace function kizunasync._jwt_session_id() returns uuid
language sql stable set search_path to '' as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

-- The highest minimum among the requested tables, so one stale table gates the
-- whole request; the highest across the config when none of them is configured.
create or replace function kizunasync._min_schema_version(p_tables text[]) returns integer
language sql stable set search_path to '' as $$
  select coalesce(
    max(c.min_schema_version) filter (where c.table_name = any(p_tables)),
    max(c.min_schema_version)
  )
  from kizunasync._config c;
$$;

create or replace function kizunasync._reap_horizon() returns bigint
language sql stable set search_path to '' as $$
  select reaped_seq from kizunasync._reap_state where id;
$$;

-- MARK: - Column privileges
--
-- Postgres column privileges are granted to ROLES, never to individual users, so
-- the readable projection of a table is the same for every caller of that role.
-- The pack reads them instead of referencing whole rows: `to_jsonb(t)` needs
-- SELECT on EVERY column, so one column-level revoke would otherwise turn every
-- pull and every push into a bare 42501.
--
-- SECURITY DEFINER because the callers are the kizunasync_rls-owned read helper
-- and the postgres-owned decision layer, neither of which may be assumed to hold
-- catalog access of its own. The role these answer for is the CALLER's, taken
-- from the SET ROLE the Data API performs (PostgREST's `authenticated`), not from
-- the definer.

-- The transaction's SET ROLE first (still readable inside a SECURITY DEFINER
-- chain), the jwt role claim next, `authenticated` last. The claims cast is
-- shape-guarded so an absent or malformed GUC yields null instead of raising.
create or replace function kizunasync._caller_role() returns text
language sql stable set search_path to '' as $$
  select coalesce(
    nullif(current_setting('role', true), 'none'),
    nullif(
      case
        when coalesce(current_setting('request.jwt.claims', true), '') ~ '^\s*\{' then
          current_setting('request.jwt.claims', true)::jsonb ->> 'role'
      end,
      ''
    ),
    'authenticated'
  );
$$;

create or replace function kizunasync._readable_columns(p_table text)
returns text[] language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(a.attname::text order by a.attnum), array[]::text[])
  from pg_catalog.pg_attribute a
  where a.attrelid = ('public.' || quote_ident(p_table))::regclass
    and a.attnum > 0
    and not a.attisdropped
    and has_column_privilege(kizunasync._caller_role(), a.attrelid, a.attname::text, 'SELECT');
$$;

-- The columns the caller's role holds p_privilege ('INSERT' or 'UPDATE') on. The
-- push decision layer compares a mutation's written columns against this set
-- before any apply, so a column refusal is a COLUMN_DENIED verdict rather than a
-- rolled-back write. A generated column is left out whatever its grants say:
-- Postgres computes it, and a write naming one would raise 428C9.
create or replace function kizunasync._writable_columns(p_table text, p_privilege text)
returns text[] language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(a.attname::text order by a.attnum), array[]::text[])
  from pg_catalog.pg_attribute a
  where a.attrelid = ('public.' || quote_ident(p_table))::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attgenerated = ''
    and has_column_privilege(kizunasync._caller_role(), a.attrelid, a.attname::text, p_privilege);
$$;

-- MARK: - Typed cell comparison

-- The value a client sent for one column, cast through that column's type and
-- rendered back the way to_jsonb renders a stored row, so comparing it with a
-- rendered cell compares typed values: a timestamp at another offset, an
-- uppercase uuid, or a json object in another key order equals the stored value
-- it names. It is the same cast the apply primitives write through, so a value
-- the type refuses raises here in class 22. A name that is no column of the
-- table comes back unchanged, and it never equals the cell a rendered row lacks.
create or replace function kizunasync._normalize_cell(p_table text, p_column text, p_value jsonb)
returns jsonb language plpgsql stable set search_path to '' as $_$
declare
  v_cell jsonb;
begin
  execute format('select to_jsonb(jsonb_populate_record(null::%I.%I, $1)) -> $2', 'public', p_table)
    into v_cell using jsonb_build_object(p_column, p_value), p_column;
  return coalesce(v_cell, p_value);
end $_$;

-- MARK: - Row rendering + param/bucket matching
--
-- SECURITY DEFINER owned by kizunasync_rls (NOBYPASSRLS), so the read runs under
-- the CALLER's RLS: auth.uid() is the real caller (inherited jwt claims) and the
-- row is returned only if the caller's SELECT policy permits it, null otherwise.
-- Visibility IS RLS, nothing else: no bucket-ownership comparison, no bucketless
-- shortcut. A public-read (`using (true)`) table returns every row; a strict table
-- filters. The bucket column governs pull SCOPING elsewhere (_row_matches_params),
-- never authorization here.
--
-- RLS decides which ROWS the caller sees; the projection decides which COLUMNS.
-- The row is rendered from _readable_columns, so a column the role may not SELECT
-- is simply absent from the document. An unreadable `id` leaves nothing to key the
-- row by, so the row is invisible to that role and the function returns null.
--
-- Two functions, deliberately NOT two overloads of one name: the provisions
-- ledger is unique on (object_kind, object_name) and deprovision drops a function
-- by name, which Postgres refuses while the name is ambiguous.
--
-- _render_user_row_projected takes the projection. Column privileges are per role,
-- so a pull delivering thousands of rows of one table probes them once and passes
-- the same list down (_pull_page's v_readable). _render_user_row probes for
-- itself, which is what the push decision layer wants: it renders one row per
-- mutation.
--
-- _lock_user_row is the push decision layer's read of the row an insert or update
-- is about to write: the same projection, taken `for no key update`, so a second
-- writer of that row waits until this push commits and then decides on what it
-- committed. A locking read also passes the table's UPDATE policy, so it returns
-- null for a row the caller may read but not update, and a role with no UPDATE
-- privilege on the table (42501) locks nothing either. It is volatile because a
-- stable function may run no statement but a plain select.

create or replace function kizunasync._render_user_row_projected(p_table text, p_pk uuid, p_columns text[])
returns jsonb language plpgsql stable security definer set search_path to '' as $_$
declare
  v_projection text;
  v_row        jsonb;
begin
  if not ('id' = any(p_columns)) then
    return null;
  end if;
  select string_agg('t.' || quote_ident(c.column_name), ', ' order by c.ord)
    into v_projection
  from unnest(p_columns) with ordinality as c(column_name, ord);

  execute format(
    'select to_jsonb(r) from (select %s from %I.%I t where t.id = $1) r',
    v_projection, 'public', p_table
  ) into v_row using p_pk;
  return v_row;
end $_$;

alter function kizunasync._render_user_row_projected(text, uuid, text[]) owner to kizunasync_rls;

create or replace function kizunasync._render_user_row(p_table text, p_pk uuid)
returns jsonb language sql stable security definer set search_path to '' as $$
  select kizunasync._render_user_row_projected(p_table, p_pk, kizunasync._readable_columns(p_table));
$$;

alter function kizunasync._render_user_row(text, uuid) owner to kizunasync_rls;

create or replace function kizunasync._lock_user_row(p_table text, p_pk uuid)
returns jsonb language plpgsql volatile security definer set search_path to '' as $_$
declare
  v_columns    text[];
  v_projection text;
  v_row        jsonb;
begin
  perform kizunasync._require_rpc_context();
  v_columns := kizunasync._readable_columns(p_table);
  if not ('id' = any(v_columns)) then
    return null;
  end if;
  select string_agg('t.' || quote_ident(c.column_name), ', ' order by c.ord)
    into v_projection
  from unnest(v_columns) with ordinality as c(column_name, ord);

  begin
    execute format(
      'select to_jsonb(r) from (select %s from %I.%I t where t.id = $1 for no key update) r',
      v_projection, 'public', p_table
    ) into v_row using p_pk;
  exception
    when insufficient_privilege then
      return null;
  end;
  return v_row;
end $_$;

alter function kizunasync._lock_user_row(text, uuid) owner to kizunasync_rls;

create or replace function kizunasync._row_matches_params(p_row jsonb, p_params jsonb)
returns boolean language sql immutable set search_path to '' as $$
  select p_row is not null
     and not exists (
       select 1
       from jsonb_each(coalesce(p_params, '{}'::jsonb)) as param(col, val)
       where (p_row -> param.col) is distinct from param.val
     );
$$;

-- A tombstone matches on the bucket column alone: its snapshot carries nothing
-- else, and the other params of a bucket filter live rows only, so a bucket
-- that names extra params still receives the deletes of its bucket value.
create or replace function kizunasync._tombstone_in_buckets(
  p_table text,
  p_snapshot jsonb,
  p_buckets jsonb
) returns boolean
language sql
stable
set search_path to ''
as $$
  select exists (
    select 1
    from jsonb_array_elements(p_buckets) as b
    where b ->> 'table' = p_table
      and case
        when coalesce(p_snapshot, '{}'::jsonb) = '{}'::jsonb then
          exists (
            select 1
            from kizunasync._config c
            where c.table_name = p_table
              and c.bucket_column is null
          )
        else
          exists (
            select 1
            from kizunasync._config c
            where c.table_name = p_table
              and c.bucket_column is not null
              and (b -> 'params') ? c.bucket_column
              and kizunasync._row_matches_params(
                p_snapshot, jsonb_build_object(c.bucket_column, b -> 'params' -> c.bucket_column)
              )
          )
      end
  );
$$;

-- MARK: - RPC call gate
--
-- pull/push are SECURITY DEFINER over the private bookkeeping (clients get no
-- SELECT/DML on the ledgers). User-row authz is NOT done here: it is the caller's
-- own RLS, enforced by the kizunasync_rls-owned read/write helpers. Internals are
-- not granted EXECUTE to authenticated; only pull/push (and attachment_*) are. The
-- GUC remains a second line if EXECUTE is ever granted. Most internal helpers
-- check this transaction-local GUC, which only pull and push set. The rest do
-- not, each for a reason docs/reference/sql-pack.md gives: the trigger functions,
-- the helpers that hold no privileged state, _render_user_row, which reads under
-- the caller's own policies, and the functions that check their caller
-- themselves.

create or replace function kizunasync._require_rpc_context()
returns void language plpgsql stable security invoker set search_path to '' as $$
begin
  if current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: internal function is not callable outside pull/push'
      using errcode = '42501';
  end if;
end $$;

-- MARK: - Bookkeeping writers
--
-- Exactly-once verdicts and HLC high-water live in tables that must not be
-- writable (or bulk-readable) through the Data API. These postgres-owned helpers
-- alone touch the ledgers, gated by the transaction-local kizunasync.rpc GUC; the
-- user-table writes they orchestrate are delegated to the kizunasync_rls-owned
-- apply helpers, which enforce the caller's RLS.

-- The recorded verdict with the user who pushed it and the row it named; every
-- field is null when the id has no entry.
create or replace function kizunasync._lookup_verdict(
  p_mutation_id uuid,
  out verdict jsonb,
  out user_id uuid,
  out table_name text,
  out pk uuid
) returns record
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform kizunasync._require_rpc_context();
  select v.verdict, v.user_id, v.table_name, v.pk
    into verdict, user_id, table_name, pk
    from kizunasync._verdicts v
   where v.mutation_id = p_mutation_id;
end;
$$;

-- Records the caller as the verdict's owner. A verdict that carries server_row
-- keeps the key with a null value, which tells a replay to render the row again.
create or replace function kizunasync._record_verdict(p_mutation_id uuid, p_table text, p_pk uuid, p_verdict jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform kizunasync._require_rpc_context();
  insert into kizunasync._verdicts (mutation_id, verdict, user_id, table_name, pk)
  values (
    p_mutation_id,
    case when p_verdict ? 'server_row' then p_verdict || jsonb_build_object('server_row', null) else p_verdict end,
    auth.uid(),
    p_table,
    p_pk
  );
end;
$$;

-- Records the caller's grant for each (table, bucket value) pair a pull page
-- delivered a live row from; a pair already granted keeps its first time. A
-- caller with no auth.uid() holds no grant, so it receives no tombstone.
create or replace function kizunasync._record_bucket_grants(p_tables text[], p_bucket_values text[])
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform kizunasync._require_rpc_context();
  if auth.uid() is null then
    return;
  end if;
  insert into kizunasync._bucket_grants (user_id, table_name, bucket_value)
  select distinct auth.uid(), g.table_name, g.bucket_value
  from unnest(p_tables, p_bucket_values) as g(table_name, bucket_value)
  on conflict (user_id, table_name, bucket_value) do nothing;
end;
$$;

-- The row's per-column HLC map, locked `for update` until the push commits, so two
-- hlc writes of one pk compare and merge one after the other. A pk with no map
-- gets an empty placeholder first, which a concurrent writer of the same pk waits
-- on; a rejected mutation rolls the placeholder back with the rest of its writes.
create or replace function kizunasync._row_hlc_lock(p_table text, p_pk uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_column_hlc jsonb;
begin
  perform kizunasync._require_rpc_context();
  insert into kizunasync._row_hlc (table_name, pk)
  values (p_table, p_pk)
  on conflict (table_name, pk) do nothing;
  select h.column_hlc into v_column_hlc
    from kizunasync._row_hlc h
   where h.table_name = p_table and h.pk = p_pk
     for update;
  return coalesce(v_column_hlc, '{}'::jsonb);
end;
$$;

-- Keeps the greater HLC of every column, so the stored map never moves backwards.
create or replace function kizunasync._row_hlc_merge(p_table text, p_pk uuid, p_column_hlc jsonb)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform kizunasync._require_rpc_context();
  insert into kizunasync._row_hlc as h (table_name, pk, column_hlc)
  values (p_table, p_pk, p_column_hlc)
  on conflict (table_name, pk) do update
    set column_hlc = h.column_hlc || (
      select coalesce(jsonb_object_agg(incoming.col, incoming.hlc), '{}'::jsonb)
      from jsonb_each_text(excluded.column_hlc) as incoming(col, hlc)
      where not (h.column_hlc ? incoming.col)
         or kizunasync._compare_hlc(incoming.hlc, h.column_hlc ->> incoming.col) > 0
    );
end;
$$;

-- Record overwritten same-column values when the table opted into the journal.
-- p_applied is the column mask that actually landed; p_prior is the RLS-visible
-- row from before the write (null when the row did not exist). First writes and
-- equal values are not overwrites; values compare through the column type
-- (_normalize_cell), so a no-op written in another rendering changes nothing and
-- journals nothing. Transforms (D-field-transforms) are not journaled.
-- The write that just landed is still a queued, unnumbered change, so each row
-- names it by pending_id and the commit-time stamp fills winner_seq. An
-- overwrite with no queued change raises internal_error, which _decide_mutation
-- does not catch: the whole push fails and nothing commits.
create or replace function kizunasync._journal_overwrites(
  p_table text,
  p_pk uuid,
  p_mutation_id uuid,
  p_applied jsonb,
  p_prior jsonb,
  p_conflict_mode text
) returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_enabled boolean;
  v_col text;
  v_new jsonb;
  v_old jsonb;
  v_pending_id bigint;
begin
  perform kizunasync._require_rpc_context();
  if p_prior is null or p_applied is null or p_applied = '{}'::jsonb then
    return;
  end if;
  select c.conflict_journal into v_enabled
    from kizunasync._config c
   where c.table_name = p_table;
  if not coalesce(v_enabled, false) then
    return;
  end if;

  select p.id into v_pending_id
    from kizunasync._change_pending p
   where p.table_name = p_table and p.pk = p_pk
   order by p.id desc
   limit 1;

  for v_col, v_new in select key, value from jsonb_each(p_applied)
  loop
    if v_col = 'id' or not (p_prior ? v_col) then
      continue;
    end if;
    v_old := p_prior -> v_col;
    if v_old is null or v_old = 'null'::jsonb or v_old is not distinct from kizunasync._normalize_cell(p_table, v_col, v_new) then
      continue;
    end if;
    if v_pending_id is null then
      raise exception 'kizunasync: no pending change for %.% to journal an overwrite against', p_table, p_pk
        using errcode = 'internal_error';
    end if;
    insert into kizunasync._conflict_journal (
      table_name, pk, column_name, loser_value, winner_mutation_id, conflict_mode, pending_id
    ) values (
      p_table, p_pk, v_col, v_old, p_mutation_id, p_conflict_mode, v_pending_id
    );
  end loop;
end;
$$;

-- MARK: - Apply primitives
--
-- SECURITY DEFINER owned by kizunasync_rls (NOBYPASSRLS) so the user-table write
-- runs under the CALLER's RLS: auth.uid() is the real caller and every INSERT
-- WITH CHECK / UPDATE-DELETE USING policy governs the write. An RLS-blocked write
-- surfaces as an insufficient_privilege raise (insert/upsert) or zero rows
-- (update/delete), which the decision layer turns into an RLS_DENIED verdict.
-- Ledger bookkeeping is NOT done here: it stays in the postgres-owned decision
-- layer (kizunasync_rls has no access to the private ledgers). Still gated by
-- _require_rpc_context (defense-in-depth); the role holds explicit EXECUTE on that
-- gate (granted after the blanket revoke) since it is a member of `authenticated`.

create or replace function kizunasync._apply_upsert(p_table text, p_pk uuid, p_columns jsonb)
returns void language plpgsql security definer set search_path to '' as $_$
declare
  v_cols text;
  v_vals text;
  v_set  text;
  v_sql  text;
begin
  perform kizunasync._require_rpc_context();
  select string_agg(quote_ident(k), ', '),
         string_agg('r.' || quote_ident(k), ', '),
         string_agg(quote_ident(k) || ' = excluded.' || quote_ident(k), ', ')
    into v_cols, v_vals, v_set
  from jsonb_object_keys(p_columns) as k
  where k <> 'id';

  v_sql := format(
    'insert into %I.%I (id%s) '
    || 'select $2%s from jsonb_populate_record(null::%I.%I, $1) r '
    || 'on conflict (id) do update set %s',
    'public', p_table,
    case when v_cols is null then '' else ', ' || v_cols end,
    case when v_vals is null then '' else ', ' || v_vals end,
    'public', p_table,
    coalesce(v_set, 'id = excluded.id')
  );

  execute v_sql using p_columns, p_pk;
end $_$;

alter function kizunasync._apply_upsert(text, uuid, jsonb) owner to kizunasync_rls;

create or replace function kizunasync._apply_update_masked(p_table text, p_pk uuid, p_columns jsonb)
returns integer language plpgsql security definer set search_path to '' as $_$
declare
  v_set      text;
  v_sql      text;
  v_affected integer;
begin
  perform kizunasync._require_rpc_context();
  select string_agg(quote_ident(k) || ' = r.' || quote_ident(k), ', ')
    into v_set
  from jsonb_object_keys(p_columns) as k
  where k <> 'id';

  if v_set is null then
    return 0;
  end if;

  v_sql := format(
    'update %I.%I as t set %s from jsonb_populate_record(null::%I.%I, $1) r where t.id = $2',
    'public', p_table, v_set, 'public', p_table
  );
  execute v_sql using p_columns, p_pk;
  get diagnostics v_affected = row_count;
  return v_affected;
end $_$;

alter function kizunasync._apply_update_masked(text, uuid, jsonb) owner to kizunasync_rls;

-- D-field-transforms increment: col = coalesce(col, 0) + n. Non-numeric columns raise
-- integrity_constraint_violation → CONSTRAINT. Not HLC-compared, not journaled.
create or replace function kizunasync._apply_increment(p_table text, p_pk uuid, p_column text, p_by numeric)
returns integer language plpgsql security definer set search_path to '' as $_$
declare
  v_affected integer;
  v_ty text;
begin
  perform kizunasync._require_rpc_context();
  select t.typname into v_ty
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where n.nspname = 'public' and c.relname = p_table and a.attname = p_column and a.attnum > 0 and not a.attisdropped;
  if v_ty is null or v_ty not in ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8') then
    raise exception 'kizunasync.increment: column %.% is not numeric', p_table, p_column
      using errcode = 'integrity_constraint_violation';
  end if;
  execute format(
    'update %I.%I set %I = coalesce(%I, 0) + $1 where id = $2',
    'public', p_table, p_column, p_column
  ) using p_by, p_pk;
  get diagnostics v_affected = row_count;
  return v_affected;
end $_$;

alter function kizunasync._apply_increment(text, uuid, text, numeric) owner to kizunasync_rls;

create or replace function kizunasync._apply_array_union(p_table text, p_pk uuid, p_column text, p_values jsonb)
returns integer language plpgsql security definer set search_path to '' as $_$
declare
  v_affected integer;
  v_ty text;
  v_elems text[];
begin
  perform kizunasync._require_rpc_context();
  select t.typname into v_ty
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where n.nspname = 'public' and c.relname = p_table and a.attname = p_column and a.attnum > 0 and not a.attisdropped;
  if v_ty is null or v_ty <> '_text' then
    raise exception 'kizunasync.arrayUnion: column %.% is not text[]', p_table, p_column
      using errcode = 'integrity_constraint_violation';
  end if;
  select coalesce(array_agg(elem), array[]::text[])
    into v_elems
    from jsonb_array_elements_text(p_values) as elem;
  execute format(
    $q$
    update %I.%I set %I = (
      select coalesce(array_agg(e order by ord), array[]::text[])
      from (
        select distinct on (e) e, ord
        from (
          select e, ordinality as ord
            from unnest(coalesce(%I, array[]::text[])) with ordinality as t(e, ordinality)
          union all
          select e, 1000000000 + ordinality
            from unnest($1) with ordinality as t(e, ordinality)
        ) src
        order by e, ord
      ) deduped
    )
    where id = $2
    $q$,
    'public', p_table, p_column, p_column
  ) using v_elems, p_pk;
  get diagnostics v_affected = row_count;
  return v_affected;
end $_$;

alter function kizunasync._apply_array_union(text, uuid, text, jsonb) owner to kizunasync_rls;

-- The row count is read after each update: after a loop that ran none, GET
-- DIAGNOSTICS would report the column-type lookup's count instead.
create or replace function kizunasync._apply_array_remove(p_table text, p_pk uuid, p_column text, p_values jsonb)
returns integer language plpgsql security definer set search_path to '' as $_$
declare
  v_affected integer := 0;
  v_ty text;
  v_elem text;
begin
  perform kizunasync._require_rpc_context();
  select t.typname into v_ty
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_type t on t.oid = a.atttypid
   where n.nspname = 'public' and c.relname = p_table and a.attname = p_column and a.attnum > 0 and not a.attisdropped;
  if v_ty is null or v_ty <> '_text' then
    raise exception 'kizunasync.arrayRemove: column %.% is not text[]', p_table, p_column
      using errcode = 'integrity_constraint_violation';
  end if;
  for v_elem in select jsonb_array_elements_text(p_values)
  loop
    execute format(
      'update %I.%I set %I = array_remove(coalesce(%I, array[]::text[]), $1) where id = $2',
      'public', p_table, p_column, p_column
    ) using v_elem, p_pk;
    get diagnostics v_affected = row_count;
  end loop;
  return v_affected;
end $_$;

alter function kizunasync._apply_array_remove(text, uuid, text, jsonb) owner to kizunasync_rls;

create or replace function kizunasync._apply_transforms(p_table text, p_pk uuid, p_transforms jsonb)
returns integer language plpgsql security definer set search_path to '' as $_$
declare
  v_col text;
  v_spec jsonb;
  v_op text;
  v_affected integer := 0;
begin
  perform kizunasync._require_rpc_context();
  if p_transforms is null or p_transforms = '{}'::jsonb then
    return 0;
  end if;
  for v_col, v_spec in select key, value from jsonb_each(p_transforms)
  loop
    v_op := v_spec ->> 'op';
    if v_op = 'increment' then
      v_affected := v_affected + kizunasync._apply_increment(p_table, p_pk, v_col, (v_spec ->> 'by')::numeric);
    elsif v_op = 'arrayUnion' then
      v_affected := v_affected + kizunasync._apply_array_union(p_table, p_pk, v_col, v_spec -> 'values');
    elsif v_op = 'arrayRemove' then
      v_affected := v_affected + kizunasync._apply_array_remove(p_table, p_pk, v_col, v_spec -> 'values');
    else
      raise exception 'kizunasync: unknown transform op %', v_op
        using errcode = 'integrity_constraint_violation';
    end if;
  end loop;
  return v_affected;
end $_$;

alter function kizunasync._apply_transforms(text, uuid, jsonb) owner to kizunasync_rls;

-- Pure user-row delete under the caller's RLS, with the mutation's precondition in
-- its WHERE: a write that committed while the delete waited on the row is checked
-- against the precondition before the row goes. The compare target is the
-- caller's readable projection, the rendering a PRECONDITION server_row carries,
-- and each expected value is cast through its column type first (_normalize_cell).
-- The _row_hlc bookkeeping cleanup is not done here (this runs as kizunasync_rls,
-- which has no ledger access); the postgres-owned track_delete trigger clears it
-- as the row goes.
create or replace function kizunasync._apply_delete(p_table text, p_pk uuid, p_precondition jsonb)
returns integer language plpgsql security definer set search_path to '' as $_$
declare
  v_projection text;
  v_affected   integer;
begin
  perform kizunasync._require_rpc_context();
  if p_precondition is null then
    execute format('delete from %I.%I where id = $1', 'public', p_table) using p_pk;
    get diagnostics v_affected = row_count;
    return v_affected;
  end if;

  select string_agg('t.' || quote_ident(c.column_name), ', ' order by c.ord)
    into v_projection
  from unnest(kizunasync._readable_columns(p_table)) with ordinality as c(column_name, ord);

  -- A scalar subquery, not `not exists`: the planner turns that into an anti
  -- join, which the READ COMMITTED recheck of a row updated while the delete
  -- waited does not evaluate against the new row version.
  execute format(
    'delete from %I.%I t where t.id = $1 and ('
    || 'select coalesce(bool_and((r.projected -> pc.col) is not distinct from kizunasync._normalize_cell($3, pc.col, pc.val)), true) '
    || 'from (select to_jsonb(p) as projected from (select %s) p) r, jsonb_each($2) as pc(col, val))',
    'public', p_table, v_projection
  ) using p_pk, p_precondition, p_table;
  get diagnostics v_affected = row_count;
  return v_affected;
end $_$;

alter function kizunasync._apply_delete(text, uuid, jsonb) owner to kizunasync_rls;

-- That was the last ownership transfer: the role owns its helpers and needs no
-- right to create anything else in the schema.
revoke create on schema kizunasync from kizunasync_rls;

-- MARK: - Rejection shape + HLC apply

create or replace function kizunasync._rejected(p_mutation_id uuid, p_reason text, p_server_row jsonb)
returns jsonb language sql immutable set search_path to '' as $$
  select jsonb_build_object(
    'mutation_id', p_mutation_id::text,
    'reason', p_reason,
    'server_row', coalesce(p_server_row, 'null'::jsonb),
    'verdict', 'rejected'
  );
$$;

-- SECURITY DEFINER + pinned search_path + rpc gate (aligned with its ledger-writing
-- peers): it locks, reads, and merges the private _row_hlc ledger, so it runs as
-- the definer (postgres) and must never be reachable outside pull/push. The
-- user-row touches it delegates (_apply_upsert for an insert, _apply_update_masked
-- otherwise, and _render_user_row) still enforce the caller's RLS. _decide_mutation
-- calls it only for a row the caller holds locked or a pk no row carries yet, so
-- the stamps it compares are never those of a row the caller cannot write.
create or replace function kizunasync._apply_hlc(p_mutation_id uuid, p_op text, p_table text, p_pk uuid, p_columns jsonb, p_hlc text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_max_skew_ms integer;
  v_hlc      text;
  v_stored   jsonb;
  v_winners  jsonb := '{}'::jsonb;
  v_win_hlc  jsonb := '{}'::jsonb;
  v_col      text;
  v_val      jsonb;
  v_prior    text;
  v_current  jsonb;
  v_affected integer;
begin
  perform kizunasync._require_rpc_context();
  if p_hlc is null then
    raise exception 'kizunasync.push(): hlc-mode table "%" mutation carries no hlc (fail loud)', p_table
      using errcode = 'feature_not_supported';
  end if;

  -- Clamp the physical component to now + maxSkew, so a far-future HLC cannot poison the column.
  -- push publishes the configured tolerance once per request; an unset GUC means
  -- this ran outside push, which the rpc gate above already refuses.
  v_max_skew_ms := nullif(current_setting('kizunasync.hlc_max_skew_ms', true), '')::integer;
  if v_max_skew_ms is null then
    raise exception 'kizunasync._apply_hlc: push did not publish hlc_max_skew_ms'
      using errcode = '42501';
  end if;
  v_hlc := kizunasync._clamp_hlc(p_hlc, clock_timestamp(), v_max_skew_ms);

  v_stored := kizunasync._row_hlc_lock(p_table, p_pk);

  for v_col, v_val in select key, value from jsonb_each(p_columns)
  loop
    v_prior := v_stored ->> v_col;
    if v_prior is null or kizunasync._compare_hlc(v_hlc, v_prior) > 0 then
      v_winners := v_winners || jsonb_build_object(v_col, v_val);
      v_win_hlc := v_win_hlc || jsonb_build_object(v_col, v_hlc);
    end if;
  end loop;

  if v_winners = '{}'::jsonb then
    v_current := kizunasync._render_user_row(p_table, p_pk);
    return kizunasync._rejected(p_mutation_id, 'SUPERSEDED', v_current);
  end if;

  v_current := kizunasync._render_user_row(p_table, p_pk);
  -- Only an insert goes through the upsert: its synthesized insert tuple would
  -- hold every column an update does not name to NOT NULL, CHECK, and the INSERT
  -- policy, and would create a missing row.
  if p_op = 'insert' then
    perform kizunasync._apply_upsert(p_table, p_pk, v_winners);
  else
    v_affected := kizunasync._apply_update_masked(p_table, p_pk, v_winners);
    if v_affected = 0 then
      return kizunasync._rejected(p_mutation_id, 'RLS_DENIED', v_current);
    end if;
  end if;
  perform kizunasync._journal_overwrites(
    p_table, p_pk, p_mutation_id, v_winners, v_current, 'hlc'
  );

  perform kizunasync._row_hlc_merge(p_table, p_pk, v_win_hlc);

  return jsonb_build_object('mutation_id', p_mutation_id::text, 'verdict', 'applied');
end $$;

-- MARK: - Per-mutation decision
--
-- No ownership probe and no bucket comparison: every user-row touch goes through
-- the kizunasync_rls-owned helpers, which run under the caller's RLS. A write the
-- caller's policy forbids surfaces as insufficient_privilege (insert/upsert WITH
-- CHECK) or zero affected rows (update/delete USING) → RLS_DENIED; a genuine
-- class-23 integrity failure (user CHECK/FK/not-null or a validation trigger in
-- that class, docs/guides/validate-writes.md), a class-22 data exception (a value
-- its column type refuses), or a validation trigger's bare `raise exception`
-- (P0001) → CONSTRAINT. Both roll back only this mutation's write
-- (D-rejection-reasons). Pack internals raise only coded errors
-- (tests/apply-block-errcodes.test.ts), so a P0001 is always the application's.
-- The insufficient_privilege arm answers RLS_DENIED for any 42501 raised inside
-- the unit, the pack's own included: the rpc gate and _apply_hlc's check that
-- push published its skew tolerance. Neither fires under push, which sets both
-- before the first mutation, so a 42501 there is the caller's policy.
-- server_row is the RLS-rendered row: non-null only when the caller may read it.
--
-- RLS_DENIED stays the ROW-policy refusal. A COLUMN-privilege refusal is its own
-- reason, COLUMN_DENIED, decided from the caller's role before any apply runs, so
-- a denied mutation leaves no side effect rather than raising a 42501 the apply
-- layer would have to guess at. The whole mutation is rejected: the pack never
-- applies the permitted subset of a mutation's columns.
--
-- The privilege a column needs follows the apply path the op takes, in either
-- conflict mode: _apply_upsert (an `insert`) runs `insert … on conflict do
-- update`, so it needs INSERT on id and on the written columns plus UPDATE on the
-- set columns; _apply_update_masked (an `update`) needs UPDATE on the written
-- columns; _apply_delete needs table-level DELETE.

-- MARK: - column-privilege-gate
-- Every column this mutation would write, checked against the caller's role
-- before the first apply. The upsert primitive runs `insert … on conflict do
-- update`, so an insert, in either conflict mode, needs INSERT on the written
-- columns AND on id, on top of the UPDATE the masked update needs. Transforms are
-- UPDATEs of their own columns.
create or replace function kizunasync._column_write_denied(p_table text, p_op text, p_columns jsonb, p_transforms jsonb)
returns boolean language plpgsql stable security definer set search_path to '' as $$
declare
  v_has_transforms boolean := p_op = 'update' and p_transforms <> '{}'::jsonb;
  v_updatable      text[];
  v_insertable     text[];
  v_denied         boolean;
begin
  perform kizunasync._require_rpc_context();
  if p_op = 'delete' then
    v_denied := not has_table_privilege(
      kizunasync._caller_role(), ('public.' || quote_ident(p_table))::regclass, 'DELETE'
    );
  else
    v_updatable := kizunasync._writable_columns(p_table, 'UPDATE');
    v_denied := exists (
      select 1 from jsonb_object_keys(p_columns) as k
      where k <> 'id' and not (k = any(v_updatable))
    );
    if not v_denied and v_has_transforms then
      v_denied := exists (
        select 1 from jsonb_object_keys(p_transforms) as k
        where not (k = any(v_updatable))
      );
    end if;
    if not v_denied and p_op = 'insert' then
      v_insertable := kizunasync._writable_columns(p_table, 'INSERT');
      v_denied := not ('id' = any(v_insertable))
        or exists (
          select 1 from jsonb_object_keys(p_columns) as k
          where k <> 'id' and not (k = any(v_insertable))
        );
    end if;
  end if;
  return v_denied;
end $$;

create or replace function kizunasync._decide_mutation(p_mutation jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $_$
declare
  v_mutation_id   uuid  := (p_mutation ->> 'mutation_id')::uuid;
  v_table         text  := p_mutation ->> 'table';
  v_pk            uuid  := (p_mutation ->> 'pk')::uuid;
  v_op            text  := p_mutation ->> 'op';
  v_columns       jsonb := coalesce(p_mutation -> 'columns', '{}'::jsonb);
  v_precondition  jsonb := p_mutation -> 'precondition';
  v_transforms    jsonb := coalesce(p_mutation -> 'transforms', '{}'::jsonb);
  v_hlc           text  := p_mutation ->> 'hlc';
  v_conflict_mode text;
  v_locked        jsonb;
  v_row           jsonb;
  v_affected      integer;
  v_hlc_verdict   jsonb;
  v_has_transforms boolean;
  v_denied        boolean;
  v_exists        boolean;
  v_queued_delete boolean;
  v_removed_from  text;
  v_message       text;
begin
  perform kizunasync._require_rpc_context();
  select conflict_mode into v_conflict_mode
    from kizunasync._config where table_name = v_table;
  if not found then
    raise exception 'kizunasync.push(): unknown table "%", not in kizunasync._config', v_table
      using errcode = 'feature_not_supported';
  end if;

  v_has_transforms := v_op = 'update' and v_transforms <> '{}'::jsonb;
  v_denied := kizunasync._column_write_denied(v_table, v_op, v_columns, v_transforms);

  -- The row an insert or update writes, locked under the caller's RLS until the
  -- push commits: a writer that holds it makes this push wait, and every check
  -- below decides on what that writer committed.
  if v_op <> 'delete' then
    v_locked := kizunasync._lock_user_row(v_table, v_pk);
  end if;

  -- After the lock, so a delete that committed while this push waited is seen. The
  -- row is deleted when its latest change is a removal: a change this transaction
  -- queued decides first (a queued delete becomes a tombstone only at commit, and
  -- only this caller can have queued it), then the pk's newest tombstone when it
  -- is newer than every changelog row of the pk. A write that moved the row to
  -- another bucket value leaves a tombstone followed by a newer upsert, so a moved
  -- row is decided like any other. A committed removal answers DELETE_WINS only to
  -- a caller who holds a grant for the bucket value it removed the row from
  -- (D-tombstone-delivery); to anyone else the pk is RLS_DENIED, so a verdict
  -- never confirms a deleted pk the caller never received.
  select p.op = 'delete' into v_queued_delete
    from kizunasync._change_pending p
   where p.table_name = v_table and p.pk = v_pk
   order by p.id desc
   limit 1;
  if v_queued_delete then
    return kizunasync._rejected(v_mutation_id, 'DELETE_WINS', null);
  end if;
  if v_queued_delete is null then
    select t.bucket_value into v_removed_from
      from kizunasync._tombstones t
     where t.table_name = v_table and t.pk = v_pk
       and not exists (select 1 from kizunasync._changelog cl where cl.table_name = t.table_name and cl.pk = t.pk and cl.seq > t.seq)
     order by t.seq desc
     limit 1;
    if found then
      if exists (
        select 1 from kizunasync._bucket_grants g
         where g.user_id = auth.uid() and g.table_name = v_table and g.bucket_value = v_removed_from
      ) then
        return kizunasync._rejected(v_mutation_id, 'DELETE_WINS', null);
      end if;
      return kizunasync._rejected(v_mutation_id, 'RLS_DENIED', null);
    end if;
  end if;

  -- The current row as the caller's SELECT policy renders it (null when hidden):
  -- the precondition compare target and the server_row on any rejection. The
  -- projection carries only the columns the caller's role may SELECT, so a
  -- server_row never reveals one it may not read. The locked row is that same
  -- projection, so a precondition compared against it holds until the commit.
  v_row := coalesce(v_locked, kizunasync._render_user_row(v_table, v_pk));

  if v_denied then
    return kizunasync._rejected(v_mutation_id, 'COLUMN_DENIED', v_row);
  end if;

  -- One unit: a rejection raised anywhere below rolls back every write this mutation made.
  begin
    -- Inside the unit, so an expected value its column type refuses is this
    -- mutation's CONSTRAINT. A key naming no column the caller may read never
    -- matches: the rendered row has no such cell.
    if v_precondition is not null and exists (
      select 1
      from jsonb_each(v_precondition) as pc(col, val)
      where (coalesce(v_row, '{}'::jsonb) -> pc.col) is distinct from kizunasync._normalize_cell(v_table, pc.col, pc.val)
    ) then
      raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'PRECONDITION', v_row)::text;
    end if;

    if v_op = 'delete' then
      v_affected := kizunasync._apply_delete(v_table, v_pk, v_precondition);
      if v_affected = 0 then
        -- The delete may have waited on a writer of the row: a delete that
        -- committed meanwhile wins for a caller who holds a grant for the bucket
        -- value it removed the row from, and a precondition the committed write
        -- broke answers against the fresh row. A tombstone a move-out left is
        -- followed by a newer changelog row, so it is no delete. Anyone else falls
        -- through to RLS_DENIED with the row it can render, none for a deleted one.
        select t.bucket_value into v_removed_from
          from kizunasync._tombstones t
         where t.table_name = v_table and t.pk = v_pk
           and not exists (select 1 from kizunasync._changelog cl where cl.table_name = t.table_name and cl.pk = t.pk and cl.seq > t.seq)
         order by t.seq desc
         limit 1;
        if found and exists (
          select 1 from kizunasync._bucket_grants g
           where g.user_id = auth.uid() and g.table_name = v_table and g.bucket_value = v_removed_from
        ) then
          raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'DELETE_WINS', null)::text;
        end if;
        v_row := kizunasync._render_user_row(v_table, v_pk);
        if v_row is not null and v_precondition is not null and exists (
          select 1
          from jsonb_each(v_precondition) as pc(col, val)
          where (v_row -> pc.col) is distinct from kizunasync._normalize_cell(v_table, pc.col, pc.val)
        ) then
          raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'PRECONDITION', v_row)::text;
        end if;
        raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row)::text;
      end if;
      return jsonb_build_object('mutation_id', v_mutation_id::text, 'verdict', 'applied');
    end if;

    if v_conflict_mode = 'hlc' and v_columns <> '{}'::jsonb then
      -- No _row_hlc read for a row the caller could not lock, so a verdict never
      -- reveals the stamps of a row it cannot write. An insert may still create a
      -- pk no row carries yet; the existence check runs as this function's owner,
      -- past RLS. A push inserting the same pk holds that pk's _row_hlc
      -- placeholder until it commits, so the check runs again once the lock is
      -- ours, and a pk that exists by then is decided like a row that existed
      -- before: locked, or refused with no row when the caller cannot lock it.
      if v_locked is null then
        if v_op <> 'insert' then
          raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row)::text;
        end if;
        execute format('select exists (select 1 from %I.%I where id = $1)', 'public', v_table) into v_exists using v_pk;
        if v_exists then
          raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row)::text;
        end if;
        perform kizunasync._row_hlc_lock(v_table, v_pk);
        execute format('select exists (select 1 from %I.%I where id = $1)', 'public', v_table) into v_exists using v_pk;
        if v_exists then
          v_locked := kizunasync._lock_user_row(v_table, v_pk);
          if v_locked is null then
            raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', null)::text;
          end if;
          v_row := v_locked;
        end if;
      end if;
      v_hlc_verdict := kizunasync._apply_hlc(v_mutation_id, v_op, v_table, v_pk, v_columns, v_hlc);
      if (v_hlc_verdict ->> 'verdict') = 'rejected' and not v_has_transforms then
        raise exception using errcode = 'KZM01', message = v_hlc_verdict::text;
      end if;
      if (v_hlc_verdict ->> 'verdict') = 'rejected' and (v_hlc_verdict ->> 'reason') is distinct from 'SUPERSEDED' then
        raise exception using errcode = 'KZM01', message = v_hlc_verdict::text;
      end if;
    elsif v_op = 'insert' then
      perform kizunasync._apply_upsert(v_table, v_pk, v_columns);
      perform kizunasync._journal_overwrites(
        v_table, v_pk, v_mutation_id, v_columns, v_row, v_conflict_mode
      );
      return jsonb_build_object('mutation_id', v_mutation_id::text, 'verdict', 'applied');
    elsif v_columns <> '{}'::jsonb then
      v_affected := kizunasync._apply_update_masked(v_table, v_pk, v_columns);
      if v_affected = 0 then
        raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row)::text;
      end if;
      perform kizunasync._journal_overwrites(
        v_table, v_pk, v_mutation_id, v_columns, v_row, v_conflict_mode
      );
    elsif not v_has_transforms then
      raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row)::text;
    end if;

    if v_has_transforms then
      v_affected := kizunasync._apply_transforms(v_table, v_pk, v_transforms);
      if v_affected = 0 then
        raise exception using errcode = 'KZM01', message = kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row)::text;
      end if;
      return jsonb_build_object(
        'mutation_id', v_mutation_id::text,
        'verdict', 'applied',
        'server_row', kizunasync._render_user_row(v_table, v_pk)
      );
    end if;

    return jsonb_build_object('mutation_id', v_mutation_id::text, 'verdict', 'applied');
  exception
    when sqlstate 'KZM01' then
      get stacked diagnostics v_message = message_text;
      return v_message::jsonb;
    when insufficient_privilege then
      return kizunasync._rejected(v_mutation_id, 'RLS_DENIED', v_row);
    when integrity_constraint_violation or data_exception or raise_exception then
      return kizunasync._rejected(v_mutation_id, 'CONSTRAINT', v_row);
  end;
end $_$;

-- MARK: - Mutation processor

-- SECURITY DEFINER + pinned search_path + rpc gate, aligned with the ledger
-- writers it drives (_lookup_verdict / _record_verdict touch the private verdict
-- ledger). The user-row decision it delegates still enforces the caller's RLS.
--
-- A replay never applies. Another user gets RLS_DENIED with no row and records
-- nothing, so a mutation id read from a pulled conflict reveals no verdict. The
-- owner gets the recorded kind and reason, and a server_row the verdict carried
-- is rendered again under the owner's current RLS, since the ledger keeps no row
-- copy; a table without a _config row renders no row. A rejection carries the
-- missing row as null, while an applied verdict leaves server_row out, since the
-- wire's applied verdict carries a server_row only as column values.
create or replace function kizunasync._process_mutation(p_mutation jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_mutation_id uuid := (p_mutation ->> 'mutation_id')::uuid;
  v_recorded    record;
  v_row         jsonb;
  v_verdict     jsonb;
begin
  perform kizunasync._require_rpc_context();
  select * into v_recorded from kizunasync._lookup_verdict(v_mutation_id);
  if v_recorded.verdict is not null then
    if v_recorded.user_id is distinct from auth.uid() then
      return kizunasync._rejected(v_mutation_id, 'RLS_DENIED', null);
    end if;

    if not v_recorded.verdict ? 'server_row' then
      return v_recorded.verdict;
    end if;

    if exists (select 1 from kizunasync._config c where c.table_name = v_recorded.table_name) then
      v_row := kizunasync._render_user_row(v_recorded.table_name, v_recorded.pk);
    end if;
    if v_row is null and v_recorded.verdict ->> 'verdict' = 'applied' then
      return v_recorded.verdict - 'server_row';
    end if;
    return v_recorded.verdict || jsonb_build_object('server_row', v_row);
  end if;

  v_verdict := kizunasync._decide_mutation(p_mutation);

  perform kizunasync._record_verdict(v_mutation_id, p_mutation ->> 'table', (p_mutation ->> 'pk')::uuid, v_verdict);

  return v_verdict;
end $$;

-- MARK: - Client registry writer

create or replace function kizunasync._register_client(
  p_session uuid,
  p_user uuid,
  p_schema_version integer,
  p_cursor text default null,
  p_last_mutation_id uuid default null,
  p_client_id uuid default null
) returns void
language plpgsql security definer set search_path to '' as $$
declare
  -- The request's client identity when it carries one; the JWT session otherwise,
  -- which is what a client that predates the wire key keeps registering under.
  v_client_id   uuid := coalesce(p_client_id, p_session);
  v_max_clients constant integer := 100;
begin
  -- _clients grants clients nothing and this DEFINER writes it as its owner, so
  -- self-check the caller: a client may only be registered for the JWT's own
  -- user. Without this any authenticated user could forge or hijack another
  -- user's registry row.
  if p_user is distinct from auth.uid() then
    raise exception 'register_client: caller % may not register a client for user %', auth.uid(), p_user
      using errcode = '42501';
  end if;
  -- A request client_id is the caller's own durable identity (D-client-identity) and needs
  -- no session match. Without one, the JWT session_id claim is the only identity
  -- offered (D-client-identity, the fallback), so it must match.
  if p_client_id is null
     and (p_session is null or p_session is distinct from kizunasync._jwt_session_id()) then
    raise exception 'register_client: session must match the JWT session_id claim'
      using errcode = '42501';
  end if;

  insert into kizunasync._clients (
    client_id, user_id, cursor, last_mutation_id, schema_version, last_seen
  )
  values (
    v_client_id, p_user, coalesce(p_cursor, '0'), p_last_mutation_id, p_schema_version, now()
  )
  on conflict (client_id) do update set
    user_id          = excluded.user_id,
    cursor           = coalesce(p_cursor, kizunasync._clients.cursor),
    last_mutation_id = coalesce(p_last_mutation_id, kizunasync._clients.last_mutation_id),
    schema_version   = excluded.schema_version,
    last_seen        = now()
  where kizunasync._clients.user_id = excluded.user_id;

  -- A caller-chosen client_id can collide with a row another user owns. The
  -- conflict arm skips it, and the write fails loud rather than silently missing.
  if not found then
    raise exception 'register_client: client % is registered to another user', v_client_id
      using errcode = '42501';
  end if;

  -- MARK: - clients-per-user-cap
  -- A user keeps at most v_max_clients registrations, this one included, so an
  -- app that mints a client id per launch cannot grow the registry without
  -- bound. The least recently seen go first.
  delete from kizunasync._clients c
   where c.user_id = p_user
     and c.client_id in (
       select r.client_id
         from kizunasync._clients r
        where r.user_id = p_user
          and r.client_id <> v_client_id
        order by r.last_seen desc, r.client_id
       offset v_max_clients - 1
     );

  -- One doorbell per transaction, like the trackers ring one per table.
  if current_setting('kizunasync.doorbell_clients', true) is distinct from '1' then
    perform set_config('kizunasync.doorbell_clients', '1', true);
    perform realtime.send(jsonb_build_object('t', '_clients'), 'changed', 'kizunasync:clients', true);
  end if;
end $$;

-- Attach D-conflict-journal-visibility journal rows whose winner_seq is in the delivered page and whose
-- pk is already present in rows. Empty result is NULL so the envelope omits conflicts.
-- A journal entry names a column, and loser_value is that column's overwritten
-- value, so an entry for a column the delivered row does not carry is dropped: the
-- conflict channel never reveals what the projection withheld.
create or replace function kizunasync._conflicts_for_page(p_rows jsonb)
returns jsonb language sql stable security definer set search_path to '' as $$
  select case
    when coalesce(jsonb_array_length(p_rows), 0) = 0 then null
    else (
      select case when count(*) = 0 then null else jsonb_agg(item order by (item->>'table'), (item->>'pk'), (item->>'column_name')) end
      from (
        -- winner_seq rides along as the decimal string every seq on the wire uses
        -- (DR:cursor-and-sequence-decimal-string-grammar): it is the changelog seq of the winning write, which is what lets
        -- a client tie the conflict to the row it just applied in this page.
        select jsonb_build_object(
          'column_name', j.column_name,
          'conflict_mode', j.conflict_mode,
          'loser_value', j.loser_value,
          'pk', j.pk::text,
          'table', j.table_name,
          'winner_mutation_id', j.winner_mutation_id::text,
          'winner_seq', j.winner_seq::text
        ) as item
        from kizunasync._conflict_journal j
        where j.winner_seq is not null
          and exists (
            select 1
            from jsonb_array_elements(p_rows) r
            where (r ->> 'seq')::bigint = j.winner_seq
              and r ->> 'table' = j.table_name
              and (r ->> 'pk')::uuid = j.pk
              and (r -> 'row') ? j.column_name
          )
      ) matched
    )
  end;
$$;

create or replace function kizunasync._pull_envelope(
  p_cursor text,
  p_has_more boolean,
  p_rows jsonb,
  p_tombstones jsonb
) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_conflicts jsonb;
begin
  v_conflicts := kizunasync._conflicts_for_page(p_rows);
  if v_conflicts is null then
    return jsonb_build_object(
      'cursor', p_cursor,
      'has_more', p_has_more,
      'rows', coalesce(p_rows, '[]'::jsonb),
      'signal', null,
      'tombstones', coalesce(p_tombstones, '[]'::jsonb)
    );
  end if;
  return jsonb_build_object(
    'conflicts', v_conflicts,
    'cursor', p_cursor,
    'has_more', p_has_more,
    'rows', coalesce(p_rows, '[]'::jsonb),
    'signal', null,
    'tombstones', coalesce(p_tombstones, '[]'::jsonb)
  );
end;
$$;

-- MARK: - Pull engine

create or replace function kizunasync._pull_gate(
  p_buckets jsonb,
  p_cursor text,
  p_schema_version integer,
  out envelope jsonb,
  out bucket_tables text[]
) returns record language plpgsql set search_path to '' as $$
declare
  -- The checkpoint the transfer started from: a continuation's start, a checkpoint's own high-water.
  v_checkpoint    bigint := coalesce(kizunasync._cursor_start(p_cursor), kizunasync._cursor_high_water(p_cursor));
  v_min_schema    integer;
  v_policy_table  text;
  v_policy_column text;
  v_reap_horizon  bigint;
begin
  perform kizunasync._require_rpc_context();
  select coalesce(array_agg(distinct b ->> 'table'), array[]::text[])
    into bucket_tables
  from jsonb_array_elements(p_buckets) as b;

  -- 1. RESET_REQUIRED gate (schema handshake gates everything). A null version is stale.
  v_min_schema := kizunasync._min_schema_version(bucket_tables);
  if p_schema_version is null or p_schema_version < v_min_schema then
    envelope := jsonb_build_object(
      'cursor', p_cursor,
      'has_more', false,
      'rows', '[]'::jsonb,
      'signal', jsonb_build_object('type', 'RESET_REQUIRED'),
      'tombstones', '[]'::jsonb
    );
    return;
  end if;

  -- MARK: - pull-policy
  -- Pull policy: a table provisioned with a bucket column must be pulled with a
  -- bucket that names that column. Tombstones carry only the stored bucket
  -- snapshot and never replay RLS, so an unscoped pull could not receive
  -- deletes without leaking every deleted pk; refusing is the only loud option.
  select b ->> 'table', c.bucket_column into v_policy_table, v_policy_column
  from jsonb_array_elements(p_buckets) as b
  join kizunasync._config c on c.table_name = b ->> 'table'
  where c.bucket_column is not null
    and not (coalesce(b -> 'params', '{}'::jsonb) ? c.bucket_column)
  limit 1;
  if v_policy_table is not null then
    raise exception 'kizunasync.pull(): table "%" is bucketed on "%": the pull bucket must name that column', v_policy_table, v_policy_column
      using errcode = 'KZL01';
  end if;

  -- Column policy: a pulled table must render its pk, and a bucketed one must
  -- render the column the bucket scopes on. Either missing from the caller's
  -- readable projection makes the page unkeyable or unscopable rather than
  -- merely narrower, so the pull refuses. A further param on a column the caller
  -- may not read is not refused: the rendered row lacks that column, so the param
  -- matches no row and the page carries none of them.
  select c.table_name, col into v_policy_table, v_policy_column
  from kizunasync._config c,
       unnest(array['id', c.bucket_column]) as col
  where c.table_name = any(bucket_tables)
    and col is not null
    and not (col = any(kizunasync._readable_columns(c.table_name)))
  order by c.table_name, col
  limit 1;
  if v_policy_table is not null then
    raise exception 'kizunasync.pull(): table "%": column "%" is not readable by role "%"',
      v_policy_table, v_policy_column, kizunasync._caller_role()
      using errcode = 'KZL02';
  end if;

  -- 2. CHECKPOINT_EXPIRED gate: the checkpoint the transfer started from
  --    predates the oldest retained tombstone. A transfer from '0' never
  --    expires. One from a checkpoint expires as soon as a reap passes that
  --    checkpoint, even between two of its pages, because the reap may have
  --    removed tombstones the transfer has not delivered yet.
  v_reap_horizon := kizunasync._reap_horizon();
  if v_checkpoint > 0 and v_checkpoint < v_reap_horizon then
    envelope := jsonb_build_object(
      'cursor', p_cursor,
      'has_more', false,
      'rows', '[]'::jsonb,
      'signal', jsonb_build_object('type', 'CHECKPOINT_EXPIRED'),
      'tombstones', '[]'::jsonb
    );
  end if;
end $$;

create or replace function kizunasync._pull_horizon(p_high_water bigint, p_snap pg_snapshot)
returns bigint language plpgsql set search_path to '' as $$
begin
  perform kizunasync._require_rpc_context();

  -- MARK: - visibility-horizon
  -- 3. The horizon (D-visibility-horizon): the largest seq visible in the pull's
  --    snapshot across changelog and tombstones, never below the incoming
  --    high-water. kizunasync._stamp_change draws every seq at commit, one
  --    committing transaction at a time, and PostgreSQL makes a commit visible
  --    before it releases the stamp's lock, so the seqs a snapshot sees form a
  --    prefix apart from numbers an aborted transaction consumed: no later commit
  --    can land at or below this value, and an open transaction, which has drawn
  --    nothing, holds nothing back. The snapshot predicate keeps the horizon and
  --    _pull_candidates on the same snapshot. Two scalar subqueries on purpose:
  --    each is a backward scan of its seq index that stops at the first visible
  --    row.
  return greatest(
    p_high_water,
    coalesce((select max(seq) from kizunasync._changelog where pg_visible_in_snapshot(xid, p_snap)), 0),
    coalesce((select max(seq) from kizunasync._tombstones where pg_visible_in_snapshot(xid, p_snap)), 0)
  );
end $$;

create or replace function kizunasync._pull_candidates(
  p_buckets jsonb,
  p_bucket_tables text[],
  p_snap pg_snapshot,
  p_cursor text,
  p_new_high_water bigint
) returns table (seq bigint, table_name text, pk uuid, deleted_at timestamptz)
language plpgsql set search_path to '' as $$
declare
  v_high_water   bigint := kizunasync._cursor_high_water(p_cursor);
  -- The pack returns flat cursors and still delivers the holes of a composite one.
  v_holes        bigint[] := kizunasync._cursor_holes(p_cursor);
  -- The lowest seq the stream can hold, below the high-water only for a lower hole.
  v_floor        bigint;
  v_label_tables text[];
  v_labels       text[];
begin
  perform kizunasync._require_rpc_context();
  v_floor := least(v_high_water, (select min(h) - 1 from unnest(v_holes) as h));

  -- The bucket values the request names on each bucketed table, which
  -- _pull_impl has already normalized through the column type, so they spell the
  -- labels track_change wrote.
  select coalesce(array_agg(r.table_name), array[]::text[]), coalesce(array_agg(r.bucket_value), array[]::text[])
    into v_label_tables, v_labels
  from (
    select distinct c.table_name, b -> 'params' ->> c.bucket_column as bucket_value
    from jsonb_array_elements(p_buckets) as b
    join kizunasync._config c on c.table_name = b ->> 'table'
    where c.bucket_column is not null
  ) r;

  -- 4. The stream, unrendered: the latest changelog row per (table, pk) of each
  --    requested table and every tombstone of a requested bucket value the
  --    caller holds a grant for, above the cursor's high-water or in its holes.
  --    A bucketed table contributes only the rows and tombstones labeled with a
  --    requested value, one range of _changelog_bucket_idx and one of
  --    _tombstones_bucket_idx per value; an unbucketed table contributes every
  --    row and tombstone of the table. A changelog candidate carries a null
  --    deleted_at, which is how _pull_page tells the two apart. The horizon cap
  --    keeps the stream inside the prefix the horizon read from this same
  --    snapshot (D-visibility-horizon), so no page carries a seq the returned
  --    cursor does not cover.
  return query
  with entries as (
    select cl.seq, cl.table_name, cl.pk
    from unnest(v_label_tables, v_labels) as r(table_name, bucket_value)
    join kizunasync._changelog cl on cl.table_name = r.table_name and cl.bucket_value = r.bucket_value
    where cl.seq > v_floor
      and cl.seq <= p_new_high_water
      and (cl.seq > v_high_water or cl.seq = any(v_holes))
      and pg_visible_in_snapshot(cl.xid, p_snap)
    union all
    select cl.seq, cl.table_name, cl.pk
    from kizunasync._config c
    join kizunasync._changelog cl on cl.table_name = c.table_name
    where c.table_name = any(p_bucket_tables)
      and c.bucket_column is null
      and cl.seq > v_floor
      and cl.seq <= p_new_high_water
      and (cl.seq > v_high_water or cl.seq = any(v_holes))
      and pg_visible_in_snapshot(cl.xid, p_snap)
  )
  select latest.seq, latest.table_name, latest.pk, null::timestamptz
  from (
    select distinct on (e.table_name, e.pk) e.seq, e.table_name, e.pk
    from entries e
    order by e.table_name, e.pk, e.seq desc
  ) latest
  union all
  select t.seq, t.table_name, t.pk, t.deleted_at
  from unnest(v_label_tables, v_labels) as r(table_name, bucket_value)
  join kizunasync._tombstones t on t.table_name = r.table_name and t.bucket_value = r.bucket_value
  where t.seq > v_floor
    and t.seq <= p_new_high_water
    and (t.seq > v_high_water or t.seq = any(v_holes))
    and pg_visible_in_snapshot(t.xid, p_snap)
    -- The key folds a null bucket value into '', which only the snapshot tells
    -- apart from the empty string.
    and kizunasync._tombstone_in_buckets(t.table_name, t.bucket_snapshot, p_buckets)
    -- Only a bucket value the caller received a live row from: a value it never
    -- saw reveals no deleted pk (D-tombstone-delivery).
    and exists (
      select 1
        from kizunasync._bucket_grants g
       where g.user_id = auth.uid()
         and g.table_name = t.table_name
         and g.bucket_value = t.bucket_value
    )
  union all
  select t.seq, t.table_name, t.pk, t.deleted_at
  from kizunasync._config c
  join kizunasync._tombstones t on t.table_name = c.table_name
  where c.table_name = any(p_bucket_tables)
    and c.bucket_column is null
    and t.seq > v_floor
    and t.seq <= p_new_high_water
    and (t.seq > v_high_water or t.seq = any(v_holes))
    and pg_visible_in_snapshot(t.xid, p_snap)
    and exists (
      select 1
        from kizunasync._bucket_grants g
       where g.user_id = auth.uid()
         and g.table_name = t.table_name
         and g.bucket_value = t.bucket_value
    );
end $$;

create or replace function kizunasync._pull_page(
  p_buckets jsonb,
  p_bucket_tables text[],
  p_snap pg_snapshot,
  p_cursor text,
  p_new_high_water bigint,
  p_limit integer
) returns jsonb language plpgsql set search_path to '' as $$
declare
  v_readable       jsonb;
  v_bucket_columns jsonb;
  v_max_scan       integer;
  v_candidate      record;
  v_row            jsonb;
  v_deliverable    boolean;
  v_rows           jsonb[] := array[]::jsonb[];
  v_tombstones     jsonb[] := array[]::jsonb[];
  v_grant_tables   text[] := array[]::text[];
  v_grant_values   text[] := array[]::text[];
  v_entries        integer := 0;
  v_scanned        integer := 0;
  v_capped         boolean := false;
  v_last_seq       bigint;
  v_last_scanned   bigint;
begin
  perform kizunasync._require_rpc_context();

  -- Column privileges are per ROLE, so the readable projection of a table is
  -- one probe per requested table, not one per rendered row.
  select
      coalesce(jsonb_object_agg(c.table_name, kizunasync._readable_columns(c.table_name)), '{}'::jsonb),
      coalesce(jsonb_object_agg(c.table_name, c.bucket_column), '{}'::jsonb)
    into v_readable, v_bucket_columns
  from kizunasync._config c
  where c.table_name = any(p_bucket_tables);

  select s.max_pull_scan into v_max_scan from kizunasync._settings s;

  -- 5. The page is a prefix of the stream in (seq, table, pk) order, rows and
  --    tombstones counted together. The loop renders a candidate's current row
  --    only when the page reaches it, withholds a row when the caller's RLS
  --    hides it (a null render) or no bucket entry of its table matches, and
  --    delivers it once however many entries match. It stops at limit + 1
  --    entries: the extra one only proves there is more. Every row the page
  --    carries grants the caller its bucket value, '' on an unbucketed table
  --    (D-tombstone-delivery).
  for v_candidate in
    select *
    from kizunasync._pull_candidates(
      p_buckets => p_buckets,
      p_bucket_tables => p_bucket_tables,
      p_snap => p_snap,
      p_cursor => p_cursor,
      p_new_high_water => p_new_high_water
    )
    order by seq, table_name, pk::text
  loop
    -- MARK: - pull-scan-cap
    -- The page also stops once it has examined max_pull_scan candidates, the
    -- entries it withholds included. A candidate past the cap proves there is more,
    -- and the next page continues from the last candidate this one examined.
    if v_scanned >= v_max_scan then
      v_capped := true;
      exit;
    end if;
    v_scanned := v_scanned + 1;
    v_last_scanned := v_candidate.seq;
    v_row := kizunasync._render_user_row_projected(
      v_candidate.table_name,
      v_candidate.pk,
      array(select jsonb_array_elements_text(v_readable -> v_candidate.table_name))
    );
    v_deliverable := exists (
      select 1
      from jsonb_array_elements(p_buckets) as b
      where b ->> 'table' = v_candidate.table_name
        and kizunasync._row_matches_params(v_row, b -> 'params')
    );
    continue when v_candidate.deleted_at is null and not v_deliverable;
    -- MARK: - tombstone-delivery
    -- A tombstone is delivered only when its row is not deliverable to the
    -- caller: a row that moved to another requested value, or was recreated
    -- where the caller sees it, rides the stream as a row, and a client applies a
    -- page's rows before its tombstones, so sending both would delete it. A row
    -- the caller cannot see, or that left every requested value, gets the tombstone.
    continue when v_candidate.deleted_at is not null and v_deliverable;
    v_entries := v_entries + 1;
    exit when v_entries > p_limit;
    v_last_seq := v_candidate.seq;
    if v_candidate.deleted_at is null then
      v_rows := array_append(v_rows, jsonb_build_object(
        'pk', v_candidate.pk::text, 'row', v_row, 'seq', v_candidate.seq::text, 'table', v_candidate.table_name
      ));
      v_grant_tables := array_append(v_grant_tables, v_candidate.table_name);
      v_grant_values := array_append(v_grant_values, coalesce(v_row ->> (v_bucket_columns ->> v_candidate.table_name), ''));
    else
      v_tombstones := array_append(v_tombstones, jsonb_build_object(
        'deleted_at', v_candidate.deleted_at, 'pk', v_candidate.pk::text,
        'seq', v_candidate.seq::text, 'table', v_candidate.table_name
      ));
    end if;
  end loop;

  if cardinality(v_grant_tables) > 0 then
    perform kizunasync._record_bucket_grants(v_grant_tables, v_grant_values);
  end if;

  -- 6. A remaining stream of at most limit entries, an exact fit included,
  --    closes the checkpoint at the horizon, unless the scan cap stopped the
  --    page first. A longer one continues by keyset from the seq of this page's
  --    last entry, and a capped one from the seq of the last candidate it
  --    examined, which can be a withheld entry: the stream has no ties, so every
  --    candidate the page leaves out has a larger seq. The continuation token
  --    keeps the checkpoint the transfer started from, which the expiry gate
  --    reads.
  if v_entries <= p_limit and not v_capped then
    return kizunasync._pull_envelope(
      p_cursor => kizunasync._encode_cursor(p_new_high_water, array[]::bigint[]),
      p_has_more => false,
      p_rows => to_jsonb(v_rows),
      p_tombstones => to_jsonb(v_tombstones)
    );
  end if;
  return kizunasync._pull_envelope(
    p_cursor => kizunasync._encode_continuation(
      coalesce(kizunasync._cursor_start(p_cursor), kizunasync._cursor_high_water(p_cursor)),
      case when v_capped then v_last_scanned else v_last_seq end
    ),
    p_has_more => true,
    p_rows => to_jsonb(v_rows),
    p_tombstones => to_jsonb(v_tombstones)
  );
end $$;

-- UTC for the whole pull: the request values it normalizes, the rows it matches
-- and renders, and the grant values it records all spell a timestamptz the way
-- the capture triggers labeled it.
create or replace function kizunasync._pull_impl(buckets jsonb, cursor text, schema_version integer, "limit" integer default 500)
returns jsonb language plpgsql set search_path to '' set timezone to 'UTC' as $$
declare
  v_high_water      bigint := kizunasync._cursor_high_water(cursor);
  -- MARK: - default-page-limit
  v_limit           integer := coalesce("limit", 500);
  -- MARK: - pull-bucket-cap
  v_max_buckets     constant integer := 64;
  v_snap            pg_snapshot := pg_current_snapshot();
  v_signal          jsonb;
  v_bucket_tables   text[];
  v_buckets         jsonb;
  v_new_high_water  bigint;
begin
  perform kizunasync._require_rpc_context();
  -- The request schema requires limit >= 1: a page that holds no entry
  -- cannot advance the cursor.
  if v_limit < 1 then
    raise exception 'kizunasync.pull(): limit must be at least 1'
      using errcode = 'invalid_parameter_value';
  end if;
  -- Each bucket entry is a range the candidate read scans, so one pull names a bounded number of them.
  if jsonb_array_length(buckets) > v_max_buckets then
    raise exception 'kizunasync.pull(): a pull names at most % bucket entries', v_max_buckets
      using errcode = 'invalid_parameter_value';
  end if;

  select g.envelope, g.bucket_tables into v_signal, v_bucket_tables
  from kizunasync._pull_gate(buckets, cursor, schema_version) as g;
  if v_signal is not null then
    return v_signal;
  end if;

  -- The bucket column's requested value, cast through the column type once, so
  -- '...UPPER...' finds the lowercase label a uuid column wrote and the rendered
  -- row matches it. A value the type refuses fails the pull with its class-22 error.
  select coalesce(jsonb_agg(
    case
      when c.bucket_column is null then e.bucket
      else jsonb_set(
        e.bucket, array['params', c.bucket_column],
        kizunasync._normalize_cell(c.table_name, c.bucket_column, e.bucket -> 'params' -> c.bucket_column)
      )
    end
    order by e.ord
  ), '[]'::jsonb)
    into v_buckets
  from jsonb_array_elements(buckets) with ordinality as e(bucket, ord)
  left join kizunasync._config c on c.table_name = e.bucket ->> 'table';

  v_new_high_water := kizunasync._pull_horizon(v_high_water, v_snap);

  return kizunasync._pull_page(
    p_buckets => v_buckets,
    p_bucket_tables => v_bucket_tables,
    p_snap => v_snap,
    p_cursor => cursor,
    p_new_high_water => v_new_high_water,
    p_limit => v_limit
  );
end $$;

-- MARK: - Push engine

create or replace function kizunasync._push_guard(batch jsonb, schema_version integer)
returns jsonb language plpgsql security invoker set search_path to '' as $$
declare
  v_uuid_pattern    constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_atomic          boolean := coalesce((batch ->> 'atomic')::boolean, false);
  v_mutations       jsonb := coalesce(batch -> 'mutations', '[]'::jsonb);
  v_min_schema      integer;
  v_mutation_tables text[];
  v_hlc_tables      text[];
  v_mutation        jsonb;
  v_position        bigint;
  v_problem         text;
  v_mutation_count  integer;
  v_max_batch       integer;
  v_require_atomic  boolean;
  v_max_skew_ms     integer;
  v_pull_only       text;
begin
  perform kizunasync._require_rpc_context();

  -- One read of the deployment config per push: the policy guards below use the
  -- first two, and _apply_hlc clamps every hlc-mode write to the third through
  -- the transaction-local GUC published here.
  select s.max_batch_size, s.require_atomic, s.hlc_max_skew_ms
    into v_max_batch, v_require_atomic, v_max_skew_ms
  from kizunasync._settings s;
  perform set_config('kizunasync.hlc_max_skew_ms', v_max_skew_ms::text, true);

  select coalesce(array_agg(distinct m ->> 'table'), array[]::text[])
    into v_mutation_tables
  from jsonb_array_elements(v_mutations) as m;

  -- Schema gate (D-schema-version-handshake decided): a stale-schema push is gated BEFORE any
  -- mutation and returns a typed RESET_REQUIRED signal: symmetric with
  -- _pull_impl (the client soft-blocks and prompts update), never a fabricated
  -- verdict. The outbox stays queued; the retry after update carries the new
  -- schema_version. A null version is stale.
  v_min_schema := kizunasync._min_schema_version(v_mutation_tables);
  if schema_version is null or schema_version < v_min_schema then
    return jsonb_build_object('signal', jsonb_build_object('type', 'RESET_REQUIRED'));
  end if;

  -- Batch shape (push-request.schema.json): a mutation the decision layer cannot
  -- read refuses the whole batch with 22023 before any mutation runs. Past this
  -- point it would fail the push halfway through the batch, or reach the apply
  -- block and pass for the application's own CONSTRAINT.
  select coalesce(array_agg(c.table_name), array[]::text[])
    into v_hlc_tables
  from kizunasync._config c
  where c.table_name = any(v_mutation_tables)
    and c.conflict_mode = 'hlc';

  for v_mutation, v_position in
    select e.value, e.ordinality from jsonb_array_elements(v_mutations) with ordinality as e
  loop
    v_problem := case
      when jsonb_typeof(v_mutation) <> 'object' then 'is not an object'
      when not coalesce((v_mutation ->> 'mutation_id') ~* v_uuid_pattern, false) then 'mutation_id is not a uuid'
      when not coalesce((v_mutation ->> 'op') in ('insert', 'update', 'delete'), false) then 'op is not insert, update, or delete'
      when jsonb_typeof(v_mutation -> 'table') is distinct from 'string' then 'table is not a string'
      when not coalesce((v_mutation ->> 'pk') ~* v_uuid_pattern, false) then 'pk is not a uuid'
      when coalesce(jsonb_typeof(v_mutation -> 'transforms'), 'null') not in ('null', 'object') then 'transforms is not an object'
      when (v_mutation ->> 'op') <> 'update' and coalesce(v_mutation -> 'transforms', 'null'::jsonb) not in ('null'::jsonb, '{}'::jsonb)
        then 'transforms ride only an update'
      when (v_mutation ->> 'table') = any(v_hlc_tables) and jsonb_typeof(v_mutation -> 'hlc') is distinct from 'string'
        then format('table "%s" resolves by hlc and the mutation carries no hlc', v_mutation ->> 'table')
    end;

    if v_problem is null and jsonb_typeof(v_mutation -> 'transforms') = 'object' then
      select case
          when coalesce(t.spec ->> 'op', '') not in ('increment', 'arrayUnion', 'arrayRemove')
            then format('transform on "%s" is not increment, arrayUnion, or arrayRemove', t.col)
          when t.spec ->> 'op' = 'increment' then format('increment on "%s" needs a numeric by', t.col)
          else format('%s on "%s" needs a non-empty values array', t.spec ->> 'op', t.col)
        end
        into v_problem
      from jsonb_each(v_mutation -> 'transforms') as t(col, spec)
      where case
          when t.spec ->> 'op' = 'increment' then not coalesce(
            jsonb_typeof(t.spec -> 'by') = 'number'
              or (jsonb_typeof(t.spec -> 'by') = 'string' and (t.spec ->> 'by') ~ '^-?[0-9]+(\.[0-9]+)?$'),
            false
          )
          when t.spec ->> 'op' in ('arrayUnion', 'arrayRemove') then coalesce(
            jsonb_array_length(case when jsonb_typeof(t.spec -> 'values') = 'array' then t.spec -> 'values' end),
            0
          ) = 0
          else true
        end
      limit 1;
    end if;

    if v_problem is not null then
      raise exception 'kizunasync.push(): mutation % of the batch is malformed: %', v_position, v_problem
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- Policy guards (server deployment config, NOT protocol). Permissive by default.

  -- (A) pull-only: any mutation targeting a 'pull-only' table aborts the push.
  select c.table_name into v_pull_only
  from kizunasync._config c
  where c.table_name = any(v_mutation_tables)
    and c.sync_mode = 'pull-only'
  limit 1;
  if v_pull_only is not null then
    raise exception 'kizunasync.push(): table "%" is pull-only (sync_mode), pushes are rejected', v_pull_only
      using errcode = 'KZP01';
  end if;

  -- (B) max_batch_size: NULL = unlimited.
  v_mutation_count := jsonb_array_length(v_mutations);
  if v_max_batch is not null and v_mutation_count > v_max_batch then
    raise exception 'kizunasync.push(): batch of % mutations exceeds max_batch_size %', v_mutation_count, v_max_batch
      using errcode = 'KZP02';
  end if;

  -- (C) require_atomic: a non-atomic push is rejected when set.
  if coalesce(v_require_atomic, false) and not v_atomic then
    raise exception 'kizunasync.push(): require_atomic is set, non-atomic push rejected'
      using errcode = 'KZP03';
  end if;

  return null;
end $$;

create or replace function kizunasync._push_impl(batch jsonb, last_mutation_id uuid, schema_version integer)
returns jsonb language plpgsql security invoker set search_path to '' as $$
declare
  v_atomic      boolean := coalesce((batch ->> 'atomic')::boolean, false);
  v_mutations   jsonb := coalesce(batch -> 'mutations', '[]'::jsonb);
  v_mutation    jsonb;
  v_signal      jsonb;
  v_verdicts    jsonb := '[]'::jsonb;
  v_verdict     jsonb;
  v_aborted     boolean := false;
  v_offender_id text;
  v_reason      text;
  v_server_row  jsonb;
begin
  perform kizunasync._require_rpc_context();
  v_signal := kizunasync._push_guard(batch, schema_version);
  if v_signal is not null then
    return v_signal;
  end if;

  -- Non-atomic (the default): per-mutation verdicts, request order.
  if not v_atomic then
    for v_mutation in select * from jsonb_array_elements(v_mutations)
    loop
      v_verdict := kizunasync._process_mutation(v_mutation);
      v_verdicts := v_verdicts || jsonb_build_array(v_verdict);
    end loop;
    return jsonb_build_object('verdicts', v_verdicts);
  end if;

  -- Atomic (D-atomic-batch-abort): all-or-nothing. The first reject stashes the offender and
  -- RAISEs a sentinel that rolls the whole sub-block back.
  begin
    for v_mutation in select * from jsonb_array_elements(v_mutations)
    loop
      v_verdict := kizunasync._process_mutation(v_mutation);
      if (v_verdict ->> 'verdict') = 'rejected' then
        v_offender_id := v_verdict ->> 'mutation_id';
        v_reason      := v_verdict ->> 'reason';
        v_server_row  := v_verdict -> 'server_row';
        raise exception 'kizunasync.push(): atomic batch aborted by mutation % (%)', v_offender_id, v_reason
          using errcode = 'KZA01';  -- sentinel: caught below, not a real error
      end if;
      v_verdicts := v_verdicts || jsonb_build_array(v_verdict);
    end loop;
  exception
    when sqlstate 'KZA01' then
      v_aborted := true;
  end;

  if v_aborted then
    return jsonb_build_object(
      'batch', jsonb_build_object(
        'offender_mutation_id', v_offender_id,
        'outcome', 'aborted',
        'reason', v_reason,
        'server_row', coalesce(v_server_row, 'null'::jsonb)
      )
    );
  end if;

  return jsonb_build_object('verdicts', v_verdicts);
end $$;

-- MARK: - Public RPC wrappers
--
-- DEFINER (owned by postgres) so clients need zero SELECT on bookkeeping tables
-- and zero EXECUTE on internals; auth.uid() still comes from the JWT. This layer
-- does NOT authorize user rows: the kizunasync_rls-owned read/write helpers do,
-- under the caller's own RLS (a non-bypassrls definer with inherited jwt claims).
-- The bucket column only scopes which rows a pull selects, always under that RLS.

-- `client_id` is a named argument, not a key inside another argument: PostgREST
-- maps each top-level key of the request body to one argument and refuses a body
-- key that names none. It defaults to null, so a request without the key resolves
-- to the same function and registers under the JWT session instead.

-- MARK: - pull-request-shape
create or replace function kizunasync.pull(
  buckets jsonb,
  cursor text,
  schema_version integer,
  "limit" integer default 500,
  client_id uuid default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_result  jsonb;
  v_session uuid := kizunasync._jwt_session_id();
  v_tables  text[];
begin
  perform set_config('kizunasync.rpc', '1', true);
  v_result := kizunasync._pull_impl(buckets, cursor, schema_version, "limit");
  -- A page that carries a signal registers nothing. Otherwise either identity is
  -- enough to register: a request client_id needs no session, and a session with
  -- no client_id still falls back to it (D-client-identity).
  if coalesce(v_result -> 'signal', 'null'::jsonb) = 'null'::jsonb
     and (v_session is not null or client_id is not null) then
    select coalesce(array_agg(distinct b ->> 'table'), array[]::text[])
      into v_tables from jsonb_array_elements(buckets) as b;
    if exists (
      select 1 from kizunasync._config
      where table_name = any(v_tables) and register_clients
    ) then
      perform kizunasync._register_client(
        v_session, auth.uid(), schema_version, v_result ->> 'cursor', null, client_id
      );
    end if;
  end if;
  return v_result;
end $$;

-- MARK: - push-request-shape
create or replace function kizunasync.push(
  batch jsonb,
  last_mutation_id uuid,
  schema_version integer,
  client_id uuid default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_result        jsonb;
  v_session       uuid := kizunasync._jwt_session_id();
  v_tables        text[];
  v_last_accepted uuid;
begin
  perform set_config('kizunasync.rpc', '1', true);
  v_result := kizunasync._push_impl(batch, last_mutation_id, schema_version);
  -- A response that carries a signal registers nothing. Otherwise either identity
  -- is enough to register: a request client_id needs no session, and a session
  -- with no client_id still falls back to it (D-client-identity).
  if coalesce(v_result -> 'signal', 'null'::jsonb) = 'null'::jsonb
     and (v_session is not null or client_id is not null) then
    select coalesce(array_agg(distinct m ->> 'table'), array[]::text[])
      into v_tables from jsonb_array_elements(coalesce(batch -> 'mutations', '[]'::jsonb)) as m;
    if exists (
      select 1 from kizunasync._config
      where table_name = any(v_tables) and register_clients
    ) then
      -- The watermark is what the server accepted, not what the request claimed:
      -- a rejected or rolled-back mutation must not move it.
      select (verdict ->> 'mutation_id')::uuid into v_last_accepted
      from jsonb_array_elements(coalesce(v_result -> 'verdicts', '[]'::jsonb))
        with ordinality as accepted(verdict, ord)
      where verdict ->> 'verdict' = 'applied'
      order by accepted.ord desc
      limit 1;

      perform kizunasync._register_client(
        v_session, auth.uid(), schema_version, null, v_last_accepted, client_id
      );
    end if;
  end if;
  return v_result;
end $$;

-- MARK: - Retention

-- MARK: - tombstone-reaping
create or replace function kizunasync.reap_tombstones() returns bigint
language plpgsql security definer set search_path to '' as $$
declare
  v_claims      jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_default_ttl integer;
  v_reaped_max  bigint;
begin
  -- Cron, a migration, or an operator: a call with no JWT, or one whose role is
  -- service_role (the Data API on a service key). Every other claim set is refused.
  if v_claims is not null
     and coalesce(v_claims ->> 'role', '') is distinct from 'service_role'
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: reap_tombstones is not a client RPC'
      using errcode = '42501';
  end if;

  select s.tombstone_ttl_days into v_default_ttl from kizunasync._settings s;

  -- The TTL is the table's own when it declares one, the project default when it
  -- declares none, and the project default again for a table `kizunasync sync --remove`
  -- has dropped from _config: nothing joins those rows away into permanence.
  with expired as (
    delete from kizunasync._tombstones t
    where t.deleted_at < now() - make_interval(days => coalesce(
      (select c.tombstone_ttl_days from kizunasync._config c where c.table_name = t.table_name),
      v_default_ttl
    ))
    returning t.seq
  )
  select max(seq) into v_reaped_max from expired;

  -- An undeclared table's changelog has no reader left, and its per-row HLC
  -- high-water is dead the moment the declaration goes (a push to an undeclared
  -- table is refused before it can write one).
  delete from kizunasync._changelog cl
  where not exists (select 1 from kizunasync._config c where c.table_name = cl.table_name)
    and cl.arrived_at < now() - make_interval(days => v_default_ttl);

  delete from kizunasync._row_hlc h
  where not exists (select 1 from kizunasync._config c where c.table_name = h.table_name);

  -- Stamped on every run, so an operator can tell "nothing expired" from "the job
  -- never ran". The watermark still moves only with a reaped tombstone: it is what
  -- expires a client checkpoint, and no changelog row can resurrect a deleted row.
  update kizunasync._reap_state
    set reaped_seq = greatest(reaped_seq, coalesce(v_reaped_max, reaped_seq)),
        reaped_at = now()
    where id;

  return coalesce(v_reaped_max, 0);
end $$;

-- MARK: - changelog-compaction
--
-- The floor is the lowest cursor among the clients seen within
-- _settings.client_ttl_days: a client silent past the TTL is stale and stops
-- holding history back (prune_clients deletes it on the same knob). A
-- registration still at cursor '0' has pulled nothing yet and holds nothing
-- back. When no live client is registered at all, the floor is the sequence
-- high-water, so a project that never turned the registry on still compacts its
-- superseded rows instead of keeping every one of them forever. The floor never
-- sits below the reap horizon: a checkpoint under it answers CHECKPOINT_EXPIRED
-- and rehydrates, so it needs none of that history.
--
-- A row is superseded by a newer changelog row of its (table, pk), or by a newer
-- tombstone: the row is gone, and its changelog entry could only be withheld.
-- A conflict-journal row whose winning changelog row is gone goes as well,
-- since pull attaches a journal row only beside its winner. The return value
-- counts changelog rows only.
create or replace function kizunasync.compact_changelog() returns bigint
language plpgsql security definer set search_path to '' as $$
declare
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_floor   bigint;
  v_deleted bigint;
begin
  if v_claims is not null
     and coalesce(v_claims ->> 'role', '') is distinct from 'service_role'
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: compact_changelog is not a client RPC'
      using errcode = '42501';
  end if;
  select greatest(
      coalesce(
        (select min(kizunasync._cursor_high_water(c.cursor))
           from kizunasync._clients c
          where c.last_seen >= now() - make_interval(days => s.client_ttl_days)
            and c.cursor <> '0'),
        (select last_value from kizunasync._change_seq)
      ),
      kizunasync._reap_horizon()
    )
    into v_floor
  from kizunasync._settings s;

  with superseded as (
    delete from kizunasync._changelog cl
    where cl.seq <= v_floor
      and (
        exists (
          select 1 from kizunasync._changelog newer
          where newer.table_name = cl.table_name
            and newer.pk = cl.pk
            and newer.seq > cl.seq
        )
        or exists (
          select 1 from kizunasync._tombstones t
          where t.table_name = cl.table_name
            and t.pk = cl.pk
            and t.seq > cl.seq
        )
      )
    returning 1
  )
  select count(*) into v_deleted from superseded;

  delete from kizunasync._conflict_journal j
  where j.winner_seq is not null
    and not exists (
      select 1 from kizunasync._changelog cl
      where cl.table_name = j.table_name
        and cl.pk = j.pk
        and cl.seq = j.winner_seq
    );

  return v_deleted;
end $$;

-- MARK: - client-pruning
--
-- The registry is a retention aid, so a client that has been silent longer than
-- _settings.client_ttl_days stops counting: its row goes, and the compaction floor
-- moves with it. A pruned client that comes back registers again on its next pull.
-- Verdicts recorded longer ago than the same TTL go as well, so a mutation
-- replayed after that is decided again. Bucket grants go only with their user:
-- one whose user is missing from auth.users is deleted, and no grant expires by
-- age. The return value counts clients only.
create or replace function kizunasync.prune_clients() returns bigint
language plpgsql security definer set search_path to '' as $$
declare
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_deleted bigint;
begin
  if v_claims is not null
     and coalesce(v_claims ->> 'role', '') is distinct from 'service_role'
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: prune_clients is not a client RPC'
      using errcode = '42501';
  end if;

  with pruned as (
    delete from kizunasync._clients c
    using kizunasync._settings s
    where c.last_seen < now() - make_interval(days => s.client_ttl_days)
    returning 1
  )
  select count(*) into v_deleted from pruned;

  delete from kizunasync._verdicts v
  using kizunasync._settings s
  where v.recorded_at < now() - make_interval(days => s.client_ttl_days);

  delete from kizunasync._bucket_grants g
  where not exists (select 1 from auth.users u where u.id = g.user_id);

  return v_deleted;
end $$;

-- MARK: - job-scheduling
--
-- The single writer of the three cron jobs, so every schedule in the database
-- comes from _settings and an `upgrade` re-apply keeps a customized one. Returns
-- what it applied, including on a database without pg_cron, where the functions
-- stay callable by hand and nothing is scheduled.
create or replace function kizunasync._schedule_jobs() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_claims   jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_settings kizunasync._settings;
  v_has_cron boolean;
begin
  if v_claims is not null
     and coalesce(v_claims ->> 'role', '') is distinct from 'service_role'
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: _schedule_jobs is not a client RPC'
      using errcode = '42501';
  end if;

  select * into v_settings from kizunasync._settings;
  v_has_cron := exists (select 1 from pg_extension where extname = 'pg_cron');

  if v_has_cron then
    perform cron.unschedule('kizunasync-reap-tombstones')
      where exists (select 1 from cron.job where jobname = 'kizunasync-reap-tombstones');
    perform cron.unschedule('kizunasync-compact-changelog')
      where exists (select 1 from cron.job where jobname = 'kizunasync-compact-changelog');
    perform cron.unschedule('kizunasync-prune-clients')
      where exists (select 1 from cron.job where jobname = 'kizunasync-prune-clients');
    perform cron.schedule('kizunasync-reap-tombstones', v_settings.reap_schedule, 'select kizunasync.reap_tombstones()');
    perform cron.schedule('kizunasync-compact-changelog', v_settings.compact_schedule, 'select kizunasync.compact_changelog()');
    perform cron.schedule('kizunasync-prune-clients', v_settings.client_prune_schedule, 'select kizunasync.prune_clients()');
  end if;

  return jsonb_build_object(
    'jobs', jsonb_build_object(
      'kizunasync-compact-changelog', v_settings.compact_schedule,
      'kizunasync-prune-clients', v_settings.client_prune_schedule,
      'kizunasync-reap-tombstones', v_settings.reap_schedule
    ),
    'pg_cron', v_has_cron
  );
end $$;

-- MARK: - job-status
--
-- What an operator needs to see about the three jobs, from a schema the Data API
-- does not expose and must not: `cron` stays unexposed, so this DEFINER function
-- is the whole read surface. One row per pack job that is actually scheduled,
-- carrying its latest run; a job that has never run reports its schedule with a
-- null run. No rows at all where pg_cron is absent, which is the same answer
-- _schedule_jobs() gives with "pg_cron": false.
create or replace function kizunasync.jobs_status()
returns table (
  jobname text,
  schedule text,
  active boolean,
  last_start timestamptz,
  last_status text,
  last_message text
)
language plpgsql stable security definer set search_path to '' as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  -- The same guard as the maintenance functions: the operator surface reads this
  -- over the Data API on a service-role key, so a service_role claim set passes
  -- and every other one is refused with 42501. EXECUTE is granted to service_role
  -- alone.
  if v_claims is not null
     and coalesce(v_claims ->> 'role', '') is distinct from 'service_role'
     and current_setting('kizunasync.rpc', true) is distinct from '1' then
    raise exception 'kizunasync: jobs_status is not a client RPC'
      using errcode = '42501';
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;

  return query
    select
      j.jobname::text,
      j.schedule::text,
      j.active,
      run.start_time,
      run.status::text,
      run.return_message::text
    from cron.job j
    left join lateral (
      select d.start_time, d.status, d.return_message
      from cron.job_run_details d
      where d.jobid = j.jobid
      order by d.start_time desc
      limit 1
    ) run on true
    where j.jobname in (
      'kizunasync-reap-tombstones',
      'kizunasync-compact-changelog',
      'kizunasync-prune-clients'
    )
    order by j.jobname;
end $$;

-- MARK: - Attachment confirm + vacuum
--
-- Confirm and vacuum are SECURITY DEFINER and bypass the attachments RLS, so each
-- authorizes the caller itself. Confirm records metadata only for the uploader: the
-- Storage object must exist and carry the caller as its owner, and the path's owner
-- segment must be the caller too. An object uploaded with the service key has no
-- owner_id and no user can confirm it. The recorded hash, size, and media type are
-- what a peer's download is verified against, so once a row carries a hash they
-- never change.

create or replace function kizunasync.attachment_confirm(
  p_bucket text,
  p_path text,
  p_sha256 text,
  p_size bigint,
  p_media_type text,
  p_table text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_owner    uuid;
  v_written  integer;
  v_existing kizunasync.attachments;
begin
  begin
    v_owner := (storage.foldername(p_path))[1]::uuid;
  exception when others then
    raise exception 'attachment_confirm: malformed object path %', p_path
      using errcode = '22023';
  end;

  if p_sha256 is null or p_sha256 !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'attachment_confirm: sha256 must be 64 hex characters, got %', p_sha256
      using errcode = '22023';
  end if;
  if p_size is null or p_size < 0 then
    raise exception 'attachment_confirm: size must be zero or more, got %', p_size
      using errcode = '22023';
  end if;
  if p_table is not null
     and not exists (select 1 from kizunasync._config c where c.table_name = p_table) then
    raise exception 'attachment_confirm: table % is not synced', p_table
      using errcode = '22023';
  end if;

  if v_owner is distinct from auth.uid() then
    raise exception 'attachment_confirm: caller % is not the owner (%) of %', auth.uid(), v_owner, p_path
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = p_bucket and o.name = p_path and o.owner_id = auth.uid()::text
  ) then
    raise exception 'attachment_confirm: caller % has uploaded no object % in bucket %', auth.uid(), p_path, p_bucket
      using errcode = '42501';
  end if;

  -- A recorded row takes the call only when it is the caller's and its hash, if
  -- any, matches with the same size and media type; otherwise it stays as it is.
  insert into kizunasync.attachments as a
    (id, bucket_id, object_path, sha256, size, media_type, created_by, table_name)
  values (gen_random_uuid(), p_bucket, p_path, lower(p_sha256), p_size, p_media_type, v_owner, p_table)
  on conflict (bucket_id, object_path) do update
    set sha256 = excluded.sha256,
        size = excluded.size,
        media_type = excluded.media_type,
        table_name = coalesce(a.table_name, excluded.table_name),
        updated_at = now()
    where a.created_by = excluded.created_by
      and (
        a.sha256 is null
        or (a.sha256 = excluded.sha256
            and a.size is not distinct from excluded.size
            and a.media_type is not distinct from excluded.media_type)
      );
  get diagnostics v_written = row_count;
  if v_written = 1 then
    return;
  end if;

  select * into v_existing
  from kizunasync.attachments a
  where a.bucket_id = p_bucket and a.object_path = p_path;
  if v_existing.created_by is distinct from v_owner then
    raise exception 'attachment_confirm: row for % is owned by %, not the caller', p_path, v_existing.created_by
      using errcode = '42501';
  end if;
  raise exception 'attachment_confirm: % is confirmed with other metadata', p_path
    using errcode = '23514';
end;
$$;

-- The row goes only once its object is gone from Storage, and only the caller's
-- own: created_by decides, so a path of any shape is matched, never parsed.
create or replace function kizunasync.attachment_vacuum(p_bucket text, p_path text)
returns void
language sql security definer set search_path = '' as $$
  delete from kizunasync.attachments a
   where a.bucket_id = p_bucket
     and a.object_path = p_path
     and a.created_by = auth.uid()
     and not exists (
       select 1 from storage.objects o where o.bucket_id = p_bucket and o.name = p_path
     );
$$;

-- MARK: - attachment-metadata
--
-- Integrity metadata for an object the caller did not upload. The owner reads its
-- own row through RLS; a peer reaches it only through the table the confirm
-- recorded, when the caller's own SELECT policy shows it that table's row, keyed
-- by the path's pk segment, and the row carries this exact object path.
-- _render_user_row decides visibility under the NOBYPASSRLS kizunasync_rls role,
-- so a peer verifies the bytes it is already allowed to see, and nobody else
-- learns the row exists. A row confirmed without a table gives peers nothing, and
-- a row of another table carrying the same pk and path is never consulted.
create or replace function kizunasync.attachment_metadata(p_bucket_id text, p_object_path text)
returns table (sha256 text, size bigint, media_type text, created_at timestamptz, updated_at timestamptz)
language plpgsql stable security definer set search_path to '' as $$
declare
  v_visible boolean := false;
  v_table   text;
  v_pk      uuid;
  v_row     jsonb;
begin
  if exists (
    select 1 from kizunasync.attachments a
    where a.bucket_id = p_bucket_id
      and a.object_path = p_object_path
      and a.created_by = auth.uid()
  ) then
    v_visible := true;
  else
    begin
      -- The object key is owner/pk/upload, the same shape attachment_confirm
      -- checks. A key of any other shape belongs to no synced row, so the peer
      -- branch cannot apply and the caller gets nothing.
      v_pk := (storage.foldername(p_object_path))[2]::uuid;
    exception when others then
      return;
    end;

    select a.table_name into v_table
    from kizunasync.attachments a
    join kizunasync._config c on c.table_name = a.table_name
    where a.bucket_id = p_bucket_id and a.object_path = p_object_path;

    if v_table is not null then
      v_row := kizunasync._render_user_row(v_table, v_pk);
      v_visible := v_row is not null and exists (
        select 1
        from jsonb_each_text(v_row) as carried(column_name, column_value)
        where carried.column_value = p_object_path
      );
    end if;
  end if;

  if not v_visible then
    return;
  end if;

  return query
    select a.sha256, a.size, a.media_type, a.created_at, a.updated_at
    from kizunasync.attachments a
    where a.bucket_id = p_bucket_id and a.object_path = p_object_path;
end $$;

-- MARK: - Grants
--
-- Bookkeeping tables: no SELECT/DML for authenticated (privacy + integrity).
-- pull/push are SECURITY DEFINER and read/write bookkeeping as the owner.
-- Direct INSERT into _changelog/_tombstones stays revoked (triggers DEFINER).
-- Sequence USAGE revoked so clients cannot burn or forge seq numbers.
--
-- EXECUTE: only the five public RPCs (pull, push, attachment_confirm,
-- attachment_metadata, attachment_vacuum). Internals are not executable by
-- authenticated even with the GUC set via set_config: the GUC remains
-- defense-in-depth for roles that may hold EXECUTE. attachment_* authorize the
-- caller themselves.

grant usage on schema kizunasync to authenticated, service_role;

revoke all on all tables in schema kizunasync from public, anon, authenticated;
revoke all on all sequences in schema kizunasync from public, anon, authenticated;
revoke all on all routines in schema kizunasync from public, anon, authenticated;

-- The kizunasync_rls-owned apply helpers call the rpc-context gate; the blanket
-- revoke above strips it from `authenticated`, and the role inherits that, so grant
-- EXECUTE back to the role explicitly. This is invisible to the lockdown audit
-- (which checks `authenticated`, not `kizunasync_rls`, and authenticated does not
-- inherit the role's privileges) and never widens the client-callable surface.
grant execute on function kizunasync._require_rpc_context() to kizunasync_rls;

-- Same shape for the readable-column projection: _render_user_row is owned by
-- kizunasync_rls and builds its select list from it. The other two column-privilege
-- helpers are reached only from postgres-owned DEFINER functions and stay revoked.
grant execute on function kizunasync._readable_columns(text) to kizunasync_rls;

-- And for the typed comparison: _apply_delete, owned by kizunasync_rls, compares
-- its precondition through it.
grant execute on function kizunasync._normalize_cell(text, text, jsonb) to kizunasync_rls;

-- Inspector / service role (read-only operational surface).
grant select on kizunasync._changelog to service_role;
grant select on kizunasync._tombstones to service_role;
grant select on kizunasync._config to service_role;
grant select on kizunasync._settings to service_role;
grant select on kizunasync._reap_state to service_role;
grant select on kizunasync._clients to service_role;
grant select on kizunasync._provisions to service_role;
grant select on kizunasync._verdicts to service_role;
grant select on kizunasync._row_hlc to service_role;
grant select on kizunasync._conflict_journal to service_role;
grant select on kizunasync._bucket_grants to service_role;

-- The operator surface reads this table like the other bookkeeping ones: the
-- sync inspector lists attachment rows over a service connection. The owner-scoped
-- policies above govern every client read. It is granted before the client grant
-- below: the blanket revoke above takes authenticated's entry out of the table's
-- privileges on a re-apply, and a grant appends an entry, so this order is the
-- one a fresh and a re-applied install both end with.
grant select on kizunasync.attachments to service_role;

-- Attachments metadata stays client-owned under RLS. Confirm and vacuum
-- (DEFINER) are the only writers; a direct INSERT/UPDATE would mint hashes
-- the peer RPC would then trust.
grant select on kizunasync.attachments to authenticated;

-- Public RPC surface only (no blanket EXECUTE on internals).
grant execute on function kizunasync.pull(jsonb, text, integer, integer, uuid) to authenticated;
grant execute on function kizunasync.push(jsonb, uuid, integer, uuid) to authenticated;
grant execute on function kizunasync.attachment_confirm(text, text, text, bigint, text, text) to authenticated;
grant execute on function kizunasync.attachment_metadata(text, text) to authenticated;
grant execute on function kizunasync.attachment_vacuum(text, text) to authenticated;

-- Maintenance is an operator action: `kizunasync jobs` runs these on a service or
-- superuser connection, and cron runs the three of them on its own schedule. No
-- client role is granted any of them, and each refuses a request whose JWT role
-- is not service_role, so the grant widens the operator surface only.
grant execute on function kizunasync.reap_tombstones() to service_role;
grant execute on function kizunasync.compact_changelog() to service_role;
grant execute on function kizunasync.prune_clients() to service_role;
grant execute on function kizunasync._schedule_jobs() to service_role;
grant execute on function kizunasync.jobs_status() to service_role;

-- No ALTER DEFAULT PRIVILEGES here: per PostgreSQL's own documented behavior, a
-- per-schema default-privileges entry is ADDED to the built-in defaults, it
-- cannot SUBTRACT from them, so it cannot revoke the built-in PUBLIC-execute
-- default new functions get (a schema-scoped revoke leaves freshly created
-- functions' proacl null, i.e. still PUBLIC-executable). A role-global
-- default-privileges entry CAN subtract it, but only by mutating an unledgered,
-- schema-unscoped Postgres setting that leaks into every other schema in the
-- customer's database. Neither is acceptable, so there is no default-ACL mechanism:
-- every function above is locked down by the explicit `revoke all on all
-- routines in schema kizunasync ...` earlier in this Grants section, which runs
-- after every function in this file is created. A future migration that adds a
-- kizunasync function AFTER that point must carry its own explicit `revoke
-- execute ... from public` (or an equivalent blanket revoke): the lockdown
-- audit test (tests/rpc-privilege-lockdown.test.ts) enforces that discipline.

-- MARK: - Realtime doorbell RLS
--
-- broadcast-from-database writes a contentless kizunasync:<table> signal into
-- realtime.messages. Authenticated clients RECEIVE it (select policy). The
-- SECURITY DEFINER trackers emit it via realtime.send: they do not need an
-- INSERT policy for `authenticated`. Scope: broadcast-extension rows on a
-- kizunasync:% topic only. No supabase_realtime publication change.

drop policy if exists "kizunasync wakeup receive" on realtime.messages;
create policy "kizunasync wakeup receive" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'kizunasync:%');

-- MARK: - Background schedule
--
-- The statement below is Supabase's documented install for pg_cron
-- (https://supabase.com/docs/guides/cron/install). `if not exists` leaves an
-- extension the dashboard already enabled untouched. It grants nothing on the
-- `cron` schema: on the Supabase image an event trigger gives `postgres` what it
-- needs on every `create extension` and keeps `cron.job` read-only on purpose,
-- and _schedule_jobs() changes jobs only through cron.schedule() and
-- cron.unschedule().
--
-- _schedule_jobs() carries its own guard, so the pack installs where the
-- extension is absent (the functions stay callable by hand or by
-- `kizunasync`). The schedules come from _settings, so re-applying the pack
-- reinstates the operator's own timings instead of overwriting them.
--
-- The extension is shared infrastructure, not a pack object: it is not
-- ledgered and `kizunasync deprovision` never drops it, because the rest of
-- the customer's database may schedule jobs of its own on it. Creation is
-- attempted once and every refusal is absorbed, since each one means the same
-- thing, that this server will not give us cron, which the guard below
-- already handles: 0A000 when the server does not carry the extension, 58P01
-- when its control file is missing, 42501 when the role may not create one,
-- 55000 when the library is not in shared_preload_libraries, and P0001 for
-- pg_cron's own "can only create extension in database postgres" outside the
-- database cron runs in. The local Supabase image raises 0A000 for an
-- unavailable name and P0001 on any database other than postgres.
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception
  when undefined_file or feature_not_supported or insufficient_privilege
    or object_not_in_prerequisite_state or raise_exception then
    null;
end $$;

do $$
begin
  perform kizunasync._schedule_jobs();
end $$;

-- MARK: - Provisions ledger seed
--
-- One row per object `kizunasync deprovision` must remove, with the function identity
-- args (object_args) so the DROP targets the exact overload. Tables/sequence are
-- intentionally NOT ledgered for drop here in the example posture (they hold the
-- engine's own bookkeeping); the pack ledgers the functions, the cross-schema
-- realtime policies, and the cron jobs: the objects a deprovision unwinds.
--
-- `unique (object_kind, object_name)` admits one row per function NAME, and the
-- DROP names the function, so the pack carries no overloaded function: every
-- signature above has a name of its own and a row of its own here.
--
-- On a conflict the seed refreshes each row's object_args and pack_version from
-- this file.

insert into kizunasync._provisions (object_kind, object_name, content_hash, pack_version, object_args)
values
  ('function', 'kizunasync._is_cron_schedule',     md5('_is_cron_schedule'),     '0.2.6-alpha.1', 'p_schedule text'),
  ('function', 'kizunasync.track_change',          md5('track_change'),          '0.2.6-alpha.1', null),
  ('function', 'kizunasync.track_delete',          md5('track_delete'),          '0.2.6-alpha.1', null),
  ('function', 'kizunasync._stamp_change',         md5('_stamp_change'),         '0.2.6-alpha.1', null),
  ('function', 'kizunasync._seed_changelog',       md5('_seed_changelog'),       '0.2.6-alpha.1', 'p_table text'),
  ('function', 'kizunasync._relabel_changelog',    md5('_relabel_changelog'),    '0.2.6-alpha.1', 'p_table text'),
  ('function', 'kizunasync._clamp_hlc',            md5('_clamp_hlc'),            '0.2.6-alpha.1', 'p_hlc text, p_now timestamp with time zone, p_max_skew_ms integer'),
  ('function', 'kizunasync._compare_hlc',          md5('_compare_hlc'),          '0.2.6-alpha.1', 'p_a text, p_b text'),
  ('function', 'kizunasync._cursor_high_water',    md5('_cursor_high_water'),    '0.2.6-alpha.1', 'p_cursor text'),
  ('function', 'kizunasync._cursor_holes',         md5('_cursor_holes'),         '0.2.6-alpha.1', 'p_cursor text'),
  ('function', 'kizunasync._cursor_start',         md5('_cursor_start'),         '0.2.6-alpha.1', 'p_cursor text'),
  ('function', 'kizunasync._encode_cursor',        md5('_encode_cursor'),        '0.2.6-alpha.1', 'p_high_water bigint, p_holes bigint[]'),
  ('function', 'kizunasync._encode_continuation',  md5('_encode_continuation'),  '0.2.6-alpha.1', 'p_start bigint, p_high_water bigint'),
  ('function', 'kizunasync._jwt_session_id',       md5('_jwt_session_id'),       '0.2.6-alpha.1', null),
  ('function', 'kizunasync._min_schema_version',   md5('_min_schema_version'),   '0.2.6-alpha.1', 'p_tables text[]'),
  ('function', 'kizunasync._reap_horizon',         md5('_reap_horizon'),         '0.2.6-alpha.1', null),
  ('function', 'kizunasync._caller_role',          md5('_caller_role'),          '0.2.6-alpha.1', null),
  ('function', 'kizunasync._readable_columns',     md5('_readable_columns'),     '0.2.6-alpha.1', 'p_table text'),
  ('function', 'kizunasync._writable_columns',     md5('_writable_columns'),     '0.2.6-alpha.1', 'p_table text, p_privilege text'),
  ('function', 'kizunasync._normalize_cell',       md5('_normalize_cell'),       '0.2.6-alpha.1', 'p_table text, p_column text, p_value jsonb'),
  ('function', 'kizunasync._render_user_row',      md5('_render_user_row'),      '0.2.6-alpha.1', 'p_table text, p_pk uuid'),
  ('function', 'kizunasync._render_user_row_projected', md5('_render_user_row_projected'), '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_columns text[]'),
  ('function', 'kizunasync._lock_user_row',        md5('_lock_user_row'),        '0.2.6-alpha.1', 'p_table text, p_pk uuid'),
  ('function', 'kizunasync._row_matches_params',   md5('_row_matches_params'),   '0.2.6-alpha.1', 'p_row jsonb, p_params jsonb'),
  ('function', 'kizunasync._tombstone_in_buckets', md5('_tombstone_in_buckets'), '0.2.6-alpha.1', 'p_table text, p_snapshot jsonb, p_buckets jsonb'),
  ('function', 'kizunasync._require_rpc_context',  md5('_require_rpc_context'),  '0.2.6-alpha.1', null),
  ('function', 'kizunasync._lookup_verdict',       md5('_lookup_verdict'),       '0.2.6-alpha.1', 'p_mutation_id uuid, OUT verdict jsonb, OUT user_id uuid, OUT table_name text, OUT pk uuid'),
  ('function', 'kizunasync._record_verdict',       md5('_record_verdict'),       '0.2.6-alpha.1', 'p_mutation_id uuid, p_table text, p_pk uuid, p_verdict jsonb'),
  ('function', 'kizunasync._record_bucket_grants', md5('_record_bucket_grants'), '0.2.6-alpha.1', 'p_tables text[], p_bucket_values text[]'),
  ('function', 'kizunasync._row_hlc_lock',         md5('_row_hlc_lock'),         '0.2.6-alpha.1', 'p_table text, p_pk uuid'),
  ('function', 'kizunasync._row_hlc_merge',        md5('_row_hlc_merge'),        '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_column_hlc jsonb'),
  ('function', 'kizunasync._journal_overwrites',   md5('_journal_overwrites'),   '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_mutation_id uuid, p_applied jsonb, p_prior jsonb, p_conflict_mode text'),
  ('function', 'kizunasync._apply_upsert',         md5('_apply_upsert'),         '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_columns jsonb'),
  ('function', 'kizunasync._apply_update_masked',  md5('_apply_update_masked'),  '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_columns jsonb'),
  ('function', 'kizunasync._apply_increment',      md5('_apply_increment'),      '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_column text, p_by numeric'),
  ('function', 'kizunasync._apply_array_union',    md5('_apply_array_union'),    '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_column text, p_values jsonb'),
  ('function', 'kizunasync._apply_array_remove',   md5('_apply_array_remove'),   '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_column text, p_values jsonb'),
  ('function', 'kizunasync._apply_transforms',     md5('_apply_transforms'),     '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_transforms jsonb'),
  ('function', 'kizunasync._conflicts_for_page',   md5('_conflicts_for_page'),   '0.2.6-alpha.1', 'p_rows jsonb'),
  ('function', 'kizunasync._pull_envelope',        md5('_pull_envelope'),        '0.2.6-alpha.1', 'p_cursor text, p_has_more boolean, p_rows jsonb, p_tombstones jsonb'),
  ('function', 'kizunasync._apply_delete',         md5('_apply_delete'),         '0.2.6-alpha.1', 'p_table text, p_pk uuid, p_precondition jsonb'),
  ('function', 'kizunasync._rejected',             md5('_rejected'),             '0.2.6-alpha.1', 'p_mutation_id uuid, p_reason text, p_server_row jsonb'),
  ('function', 'kizunasync._apply_hlc',            md5('_apply_hlc'),            '0.2.6-alpha.1', 'p_mutation_id uuid, p_op text, p_table text, p_pk uuid, p_columns jsonb, p_hlc text'),
  ('function', 'kizunasync._column_write_denied',  md5('_column_write_denied'),  '0.2.6-alpha.1', 'p_table text, p_op text, p_columns jsonb, p_transforms jsonb'),
  ('function', 'kizunasync._decide_mutation',      md5('_decide_mutation'),      '0.2.6-alpha.1', 'p_mutation jsonb'),
  ('function', 'kizunasync._process_mutation',     md5('_process_mutation'),     '0.2.6-alpha.1', 'p_mutation jsonb'),
  ('function', 'kizunasync._register_client',      md5('_register_client'),      '0.2.6-alpha.1', 'p_session uuid, p_user uuid, p_schema_version integer, p_cursor text, p_last_mutation_id uuid, p_client_id uuid'),
  ('function', 'kizunasync._pull_gate',            md5('_pull_gate'),            '0.2.6-alpha.1', 'p_buckets jsonb, p_cursor text, p_schema_version integer, OUT envelope jsonb, OUT bucket_tables text[]'),
  ('function', 'kizunasync._pull_horizon',         md5('_pull_horizon'),         '0.2.6-alpha.1', 'p_high_water bigint, p_snap pg_snapshot'),
  ('function', 'kizunasync._pull_candidates',      md5('_pull_candidates'),      '0.2.6-alpha.1', 'p_buckets jsonb, p_bucket_tables text[], p_snap pg_snapshot, p_cursor text, p_new_high_water bigint'),
  ('function', 'kizunasync._pull_page',            md5('_pull_page'),            '0.2.6-alpha.1', 'p_buckets jsonb, p_bucket_tables text[], p_snap pg_snapshot, p_cursor text, p_new_high_water bigint, p_limit integer'),
  ('function', 'kizunasync._pull_impl',            md5('_pull_impl'),            '0.2.6-alpha.1', 'buckets jsonb, cursor text, schema_version integer, "limit" integer'),
  ('function', 'kizunasync._push_guard',           md5('_push_guard'),           '0.2.6-alpha.1', 'batch jsonb, schema_version integer'),
  ('function', 'kizunasync._push_impl',            md5('_push_impl'),            '0.2.6-alpha.1', 'batch jsonb, last_mutation_id uuid, schema_version integer'),
  ('function', 'kizunasync.pull',                  md5('pull'),                  '0.2.6-alpha.1', 'buckets jsonb, cursor text, schema_version integer, "limit" integer, client_id uuid'),
  ('function', 'kizunasync.push',                  md5('push'),                  '0.2.6-alpha.1', 'batch jsonb, last_mutation_id uuid, schema_version integer, client_id uuid'),
  ('function', 'kizunasync.reap_tombstones',       md5('reap_tombstones'),       '0.2.6-alpha.1', null),
  ('function', 'kizunasync.compact_changelog',     md5('compact_changelog'),     '0.2.6-alpha.1', null),
  ('function', 'kizunasync.prune_clients',         md5('prune_clients'),         '0.2.6-alpha.1', null),
  ('function', 'kizunasync._schedule_jobs',        md5('_schedule_jobs'),        '0.2.6-alpha.1', null),
  ('function', 'kizunasync.jobs_status',           md5('jobs_status'),           '0.2.6-alpha.1', null),
  ('function', 'kizunasync.attachment_confirm',    md5('attachment_confirm'),    '0.2.6-alpha.1', 'p_bucket text, p_path text, p_sha256 text, p_size bigint, p_media_type text, p_table text'),
  ('function', 'kizunasync.attachment_metadata',   md5('attachment_metadata'),   '0.2.6-alpha.1', 'p_bucket_id text, p_object_path text'),
  ('function', 'kizunasync.attachment_vacuum',     md5('attachment_vacuum'),     '0.2.6-alpha.1', 'p_bucket text, p_path text'),
  ('policy',   'realtime.messages.kizunasync wakeup receive', md5('kizunasync wakeup receive'), '0.2.6-alpha.1', null),
  ('cron',     'kizunasync-reap-tombstones',       md5('reap-cron'),             '0.2.6-alpha.1', null),
  -- Intentionally no default-privileges grant to authenticated: new functions
  -- must not become Data-API-callable. Deprovision has nothing to unwind here.
  ('cron',     'kizunasync-compact-changelog',     md5('compact-cron'),          '0.2.6-alpha.1', null),
  ('cron',     'kizunasync-prune-clients',         md5('prune-cron'),            '0.2.6-alpha.1', null),
  -- The RLS-enforcing owner role. deprovision drops it AFTER the functions it owns
  -- (the ledger's kind order places 'role' after 'function'); the DROP first runs
  -- `drop owned by` so the EXECUTE grants the role holds are cleared.
  ('role',     'kizunasync_rls',                   md5('kizunasync_rls'),        '0.2.6-alpha.1', null)
on conflict (object_kind, object_name) do update
  set object_args = excluded.object_args,
      pack_version = excluded.pack_version;
