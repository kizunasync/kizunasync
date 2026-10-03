-- Kizuna example fixture (local-dev / demo ONLY: NOT part of the installable
-- pack). This is the SINGLE demo migration: the todos table the example apps
-- sync, shared by every visitor through RLS that keeps a registered user's
-- rows writable only by their owner, with a soft-delete (archived_at) column,
-- two abuse caps (100 todos and 300 writes per minute per visitor), an hourly
-- reaper that keeps visitor accounts temporary, the storage bucket and image
-- policies, three demo accounts, and the per-project Kizuna provisioning (the
-- kizunasync._config row + change-capture triggers on public.todos) that a
-- real app would instead get from `kizunasync init`.
--
-- Depends on 0001_kizuna_init.sql (the kizunasync schema, trackers, and
-- _config table).
--
-- ⚠️ If you `db push` to a real project, SKIP this file: these are demo
-- fixtures, not product schema.

-- MARK: - todos table

create table public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  likes integer not null default 0,
  version integer not null default 0,
  labels text[] not null default '{}',
  image_path text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint todos_title_length check (char_length(title) <= 50)
);

comment on column public.todos.archived_at is
  'App-level soft delete: null = live, a timestamp = archived. A normal synced column, never a tombstone, so the row keeps merging under column-LWW and a restore is setting this back to null.';

-- The cascade FK on user_id is what makes reaping a visitor sufficient: one
-- delete on auth.users takes their todos with it.

create index todos_user_id_idx on public.todos (user_id);
create index todos_updated_at_idx on public.todos (updated_at);

-- Server-stamped updated_at for the demo table. The engine's pull cursor
-- reads the fenced changelog, not this column.
create or replace function public.todos_touch_updated_at()
returns trigger language plpgsql set search_path to '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger todos_touch_updated_at
  before update on public.todos
  for each row execute function public.todos_touch_updated_at();

-- A trigger fires without EXECUTE on its function (Postgres checks it when the
-- trigger is created), so no API role needs it. `create function` grants EXECUTE
-- to PUBLIC and a platform's default privileges grant the API roles by name, so
-- every trigger function in this file revokes all three.
revoke execute on function public.todos_touch_updated_at() from public, anon, authenticated;

-- MARK: - Fixed owner
--
-- A todo keeps the user_id it was inserted with. The column stays UPDATE-granted
-- because push applies an insert as an upsert whose `do update set` names every
-- written column, so this trigger is what refuses a change: 23514, which push
-- answers as that write's own CONSTRAINT rejection (D-rejection-reasons). An
-- update that writes the same user_id back passes. `create or replace` lets this
-- section install the trigger on a todos table that lacks it.

create or replace function public.todos_keep_user_id()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'todos.user_id cannot be reassigned' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace trigger todos_keep_user_id
  before update on public.todos
  for each row execute function public.todos_keep_user_id();

revoke execute on function public.todos_keep_user_id() from public, anon, authenticated;

-- MARK: - Title length
--
-- A title holds at most 50 code points. The example clients cap the input at 50
-- UTF-16 units, and 50 units never hold more than 50 code points, so the check
-- refuses only a write that bypassed the form: 23514, which push answers as that
-- write's own CONSTRAINT rejection (D-rejection-reasons). The create table above
-- declares the check; this block adds it to a todos table that lacks it.

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.todos'::regclass
       and conname = 'todos_title_length'
  ) then
    alter table public.todos
      add constraint todos_title_length check (char_length(title) <= 50);
  end if;
end $$;

-- MARK: - Grants

-- Table grants for the API roles (PostgREST needs the table-level GRANT in
-- addition to RLS: this PG17/CLI stack ships no default DML privileges).
grant select, insert, update, delete on public.todos to authenticated;
grant all on public.todos to service_role;

-- MARK: - Row level security
--
-- SELECT: every row, to every signed-in visitor. INSERT: only as yourself.
-- UPDATE/DELETE: your own rows and any row an anonymous visitor owns, so the
-- board is collectively editable. A REGISTERED user's rows (mary's, which the
-- demo shows you may read but not write) stay writable by that user alone.
--
-- auth.uid() is wrapped in a scalar subquery so the planner caches it once per
-- statement instead of re-evaluating per row (todos_user_id_idx already exists).

alter table public.todos enable row level security;

-- authenticated cannot read auth.users.is_anonymous inside a policy; this
-- SECURITY DEFINER helper probes it on its behalf (injection-safe).
create or replace function public.todo_owner_is_anonymous(owner uuid)
returns boolean
language sql security definer set search_path = '' stable
as $$
  select coalesce((select u.is_anonymous from auth.users u where u.id = owner), false);
$$;

-- Its callers are the `to authenticated` policies below and the DEFINER
-- todo_image_writable, so `authenticated` alone executes it: for anyone else it
-- would only answer which user ids are anonymous. It lives outside the kizunasync
-- schema, where 0001_kizuna_init.sql's blanket revoke never reaches, so the
-- revoke names the built-in PUBLIC default and the API roles a platform's default
-- privileges grant by name.
revoke execute on function public.todo_owner_is_anonymous(uuid) from public, anon, service_role;
grant execute on function public.todo_owner_is_anonymous(uuid) to authenticated;

create policy "Todos are readable by every signed-in visitor."
  on public.todos for select to authenticated
  using (true);

create policy "Todos are insertable as yourself."
  on public.todos for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Anonymous-owned todos are editable by any visitor."
  on public.todos for update to authenticated
  using (user_id = (select auth.uid()) or public.todo_owner_is_anonymous(user_id))
  with check (user_id = (select auth.uid()) or public.todo_owner_is_anonymous(user_id));

create policy "Anonymous-owned todos are deletable by any visitor."
  on public.todos for delete to authenticated
  using (user_id = (select auth.uid()) or public.todo_owner_is_anonymous(user_id));

-- MARK: - Storage: the todos image bucket + shared-board write policies
--
-- Object key: `<todo-owner>/<todo-id>/<upload-id>.<ext>`. A write is
-- authorized by the REFERENCED todo's mutate-right: foldername[1] must be the
-- todo's owner and foldername[2] the todo id, so a non-owner editor of a guest
-- todo can upload into the owner's folder and into no other. Public read keeps
-- the demo simple (the real attachment design uses private buckets + signed
-- URLs).

insert into storage.buckets (id, name, public)
values ('todos', 'todos', true)
on conflict (id) do nothing;

-- The path's owner segment must be the todo's owner and its todo-id segment a
-- todo the caller may mutate. Malformed keys DENY (return false), never error.
create or replace function public.todo_image_writable(object_name text)
returns boolean
language plpgsql security definer set search_path = '' stable
as $$
declare
  segments text[] := storage.foldername(object_name);
  owner_id uuid;
  todo_id uuid;
begin
  if array_length(segments, 1) is null or array_length(segments, 1) < 2 then
    return false;
  end if;
  begin
    owner_id := segments[1]::uuid;
    todo_id := segments[2]::uuid;
  exception when others then
    return false;
  end;
  return exists (
    select 1
    from public.todos t
    where t.id = todo_id
      and t.user_id = owner_id
      and ((select auth.uid()) = t.user_id or public.todo_owner_is_anonymous(t.user_id))
  );
end;
$$;

-- Its callers are the `to authenticated` Storage policies below, so
-- `authenticated` alone executes it.
revoke execute on function public.todo_image_writable(text) from public, anon;
grant execute on function public.todo_image_writable(text) to authenticated;

create policy "Anyone can read todo images."
  on storage.objects for select
  using (bucket_id = 'todos');

create policy "Editors of a todo can upload its image."
  on storage.objects for insert to authenticated
  with check (bucket_id = 'todos' and public.todo_image_writable(name));

create policy "Editors of a todo can update its image."
  on storage.objects for update to authenticated
  using (bucket_id = 'todos' and public.todo_image_writable(name))
  with check (bucket_id = 'todos' and public.todo_image_writable(name));

create policy "Editors of a todo can delete its image."
  on storage.objects for delete to authenticated
  using (bucket_id = 'todos' and public.todo_image_writable(name));

-- Attachment metadata keeps the pack's owner-only policy: a peer who can read the
-- referencing todo verifies a download through kizunasync.attachment_metadata.

-- MARK: - Abuse caps: 100 todos and 300 writes per minute per visitor
--
-- Both caps are keyed on auth.uid(), i.e. on a VISITOR. A caller with no JWT (the
-- cron reaper, the migration itself, the db-test harness) is not a visitor and is
-- not counted: otherwise the reaper's own cascade would trip the churn cap and
-- abort the cleanup it is performing. Both raise with errcode 23514
-- (check_violation), a class-23 integrity failure: push answers the write that
-- trips a cap with its own CONSTRAINT rejection (D-rejection-reasons).

-- MARK: - Cap 1: 100 todos per visitor
--
-- SECURITY DEFINER so the count is the table's, not whatever the SELECT policy of
-- the moment happens to expose.

create or replace function public.todos_enforce_row_cap()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_visitor uuid := auth.uid();
  v_owned integer;
begin
  if v_visitor is null then
    return new;
  end if;
  select count(*) into v_owned from public.todos where user_id = v_visitor;
  if v_owned >= 100 then
    raise exception 'demo cap: 100 todos per visitor' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger todos_enforce_row_cap
  before insert on public.todos
  for each row execute function public.todos_enforce_row_cap();

revoke execute on function public.todos_enforce_row_cap() from public, anon, authenticated;

-- MARK: - Cap 2: 300 writes per minute per visitor
--
-- One bucket row per visitor per minute. The table is bookkeeping, not data: no
-- grants and no policy, so PostgREST cannot reach it and only the SECURITY
-- DEFINER trigger below writes it. Buckets are dropped by the reaper.

create table public.demo_write_counters (
  user_id uuid not null,
  minute timestamptz not null,
  count integer not null default 0,
  primary key (user_id, minute)
);

alter table public.demo_write_counters enable row level security;

-- A new table in `public` inherits Dxtm (truncate/references/trigger) for the API
-- roles from this stack's default ACL: enough for an authenticated caller to
-- truncate its own churn record away. The trigger runs as the definer and needs
-- none of it.
revoke all on public.demo_write_counters from anon, authenticated, service_role;

create or replace function public.todos_enforce_write_cap()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_visitor uuid := auth.uid();
  v_writes integer;
begin
  if v_visitor is null then
    return coalesce(new, old);
  end if;
  insert into public.demo_write_counters (user_id, minute, count)
  values (v_visitor, date_trunc('minute', now()), 1)
  on conflict (user_id, minute) do update
    set count = public.demo_write_counters.count + 1
  returning count into v_writes;
  if v_writes > 300 then
    raise exception 'demo cap: 300 writes per minute' using errcode = '23514';
  end if;
  -- BEFORE DELETE: new is null, and returning null would cancel the delete.
  return coalesce(new, old);
end $$;

create trigger todos_enforce_write_cap
  before insert or update or delete on public.todos
  for each row execute function public.todos_enforce_write_cap();

revoke execute on function public.todos_enforce_write_cap() from public, anon, authenticated;

-- MARK: - Reaper: a visitor's rows die with the visitor
--
-- SECURITY INVOKER deliberately: `create function` grants execute to PUBLIC, and
-- a DEFINER version would hand every authenticated caller a button that wipes
-- every day-old anonymous account. The revoke is the second lock: it names the
-- API roles too, since a platform's default privileges grant them EXECUTE by name.

create or replace function public.reap_demo_visitors() returns integer
language plpgsql set search_path to '' as $$
declare
  v_reaped integer;
begin
  with gone as (
    delete from auth.users
     where is_anonymous and created_at < now() - interval '24 hours'
    returning 1
  )
  select count(*) into v_reaped from gone;

  delete from public.demo_write_counters where minute < now() - interval '1 day';

  return v_reaped;
end $$;

revoke all on function public.reap_demo_visitors() from public, anon, authenticated;

-- MARK: - Reaper schedule

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('kizunasync-demo-reap-visitors')
      where exists (select 1 from cron.job where jobname = 'kizunasync-demo-reap-visitors');
    perform cron.schedule('kizunasync-demo-reap-visitors', '23 * * * *', 'select public.reap_demo_visitors()');
  end if;
end $$;

-- MARK: - Demo tombstone retention
--
-- todos is unbucketed, so its tombstones are table-scoped: every visitor
-- receives every other visitor's deletes for the whole retention window. Two
-- days bounds that window. reap_demo_visitors() drops a visitor after a day, so
-- nothing a live visitor still needs is reaped, and a client offline longer than
-- two days rehydrates through CHECKPOINT_EXPIRED instead of missing a delete.
-- The reap/compact/prune schedules keep the pack defaults.

update kizunasync._settings set tombstone_ttl_days = 2;

-- MARK: - Demo accounts
--
-- ⚠️ LOCAL-DEV SEED: deterministic ids + a shared public password ('kizunasync-demo')
-- so the example UI can hardcode the credentials. Inserts go straight into
-- auth.users / auth.identities (the supported local-seed pattern). Drop these
-- rows if you push to a real project.

do $$
declare
  demo record;
begin
  for demo in
    select * from (values
      ('11111111-1111-4111-8111-111111111111'::uuid, 'mary@kizunasync.local'),
      ('22222222-2222-4222-8222-222222222222'::uuid, 'samuel@kizunasync.local'),
      ('33333333-3333-4333-8333-333333333333'::uuid, 'david@kizunasync.local')
    ) as t(id, email)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000', demo.id, 'authenticated', 'authenticated',
      demo.email, extensions.crypt('kizunasync-demo', extensions.gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now(),
      '', '', '', '',
      false
    )
    on conflict (id) do nothing;

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), demo.id, demo.id::text,
      jsonb_build_object('sub', demo.id::text, 'email', demo.email, 'email_verified', true),
      'email', now(), now(), now()
    )
    on conflict do nothing;
  end loop;
end $$;

-- MARK: - Per-project Kizuna provisioning for public.todos
--
-- This is what `kizunasync init` generates for a real app; here it stays a
-- hand-written demo fixture so the example apps keep working.
-- The demo and the examples pull with an EMPTY bucket so their reads stay
-- cross-account (RLS-bounded), so todos is provisioned with no bucket column and
-- its tombstones are table-scoped. register_clients = true opts the example into
-- device registration. A real app that `kizunasync init` provisions with a bucket
-- column must pull with a bucket that names it: kizunasync.pull() raises KZL01
-- for an unscoped pull of a bucketed table.

insert into kizunasync._config (
  table_name, sync_mode, bucket_column, soft_delete_column, min_schema_version, register_clients
)
values ('todos', 'read-write', null, null, 1, true)
on conflict (table_name) do update set
  sync_mode = excluded.sync_mode,
  bucket_column = excluded.bucket_column,
  register_clients = excluded.register_clients;

create trigger kizunasync_track_change
  after insert or update on public.todos
  for each row execute function kizunasync.track_change();

create trigger kizunasync_track_delete
  after delete on public.todos
  for each row execute function kizunasync.track_delete();

-- Ledger the per-project provisioning so a future deprovision is exact.
insert into kizunasync._provisions (object_kind, object_name, content_hash, pack_version)
values
  ('config',  'public.todos',                        md5('todos:read-write:'),       '0.2.6-alpha.2'),
  ('trigger', 'public.todos.kizunasync_track_change', md5('track_change'),            '0.2.6-alpha.2'),
  ('trigger', 'public.todos.kizunasync_track_delete', md5('track_delete'),            '0.2.6-alpha.2')
on conflict (object_kind, object_name) do nothing;

-- Todos written before the triggers above existed have no changelog entry, so
-- no pull would deliver them; the seed queues one for each.
select kizunasync._seed_changelog('todos');

comment on table public.demo_write_counters is
  'Demo abuse-cap bookkeeping: one write count per visitor per minute. Not user data, not exposed to PostgREST, dropped after a day by public.reap_demo_visitors().';
