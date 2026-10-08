-- Kizuna example fixture: hardening for the PUBLIC demo project ONLY. Additive
-- to 0002_example.sql (local-dev / demo fixture, NOT part of the installable
-- pack).
--
-- This file is NEVER applied by `supabase db reset` (it lives outside
-- supabase/migrations/, on purpose) and is NEVER applied by CI or the local
-- dev stack. The maintainer applies it, once, to the public kizunasync.com
-- demo Supabase project only, through the Supabase Management API.
--
-- What 0002_example.sql leaves open on a project the whole internet can
-- reach: the shared password is public, the storage bucket accepts uploads
-- from any visitor, and a visitor's own account lasts until it has been idle
-- for a day. This file closes those, and schedules the pack's own retention jobs
-- where pg_cron is available. It narrows no visibility: the shared board is the
-- public demo's point, so 0002_example.sql's todos policies are the ones the
-- public project runs.
--
-- ⚠️ If you `db push` to a real (non-demo) project, SKIP this file too.

-- MARK: - pg_cron
--
-- The same block as 0001_kizuna_init.sql: Supabase's documented create, no grant
-- on the `cron` schema, and every refusal class absorbed there means the same
-- thing here, this server will not give us cron (0A000/feature_not_supported,
-- 58P01/undefined_file, 42501/insufficient_privilege, 55000/object_not_in_prerequisite_state,
-- P0001/raise_exception). Not ledgered: shared infrastructure, not a pack object.

do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception
  when undefined_file or feature_not_supported or insufficient_privilege
    or object_not_in_prerequisite_state or raise_exception then
    null;
end $$;

-- 0001 and 0002_example.sql schedule nothing on a project that lacks pg_cron
-- when they run, so re-run the pack's scheduler when the extension is present.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform kizunasync._schedule_jobs();
  end if;
end $$;

-- MARK: - Demo accounts: only mary survives, with no usable password
--
-- The fixture password ('kizunasync-demo') is public in this repository: a login
-- account seeded with it must not exist on a reachable server. mary's row
-- stays (the demo's RLS-refusal story needs a registered owner to read), but
-- with no password anyone can authenticate with.

delete from auth.users where email in ('samuel@kizunasync.local', 'david@kizunasync.local');

update auth.users set encrypted_password = null
where id = '11111111-1111-4111-8111-111111111111'::uuid;

-- The demos' RLS-refusal probe needs a registered owner's row that no visitor
-- may write. With mary's password gone, nothing else can create it on this
-- project, so it is seeded here.
insert into public.todos (id, user_id, title, done)
values (
  'bbbbbbbb-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111',
  'Mary''s row: you may read it, not write it',
  false
)
on conflict (id) do nothing;

-- MARK: - Storage: no upload surface on the demo project
--
-- 0002_example.sql's bucket and its "any editor of the referenced todo" write policies are
-- fine for a two-pane local demo; on a public one they are an open upload
-- endpoint. Drop the whole surface: with these four policies and the writable
-- helper gone, storage.objects RLS denies by default and the bucket is
-- unreachable to anon/authenticated either way.

drop policy if exists "Anyone can read todo images." on storage.objects;
drop policy if exists "Editors of a todo can upload its image." on storage.objects;
drop policy if exists "Editors of a todo can update its image." on storage.objects;
drop policy if exists "Editors of a todo can delete its image." on storage.objects;
drop function if exists public.todo_image_writable(text);

-- The pack's owner-only policies are the only attachment-metadata policies; this
-- drop keeps a demo database that carries any other in line with them.
drop policy if exists "todos attachment metadata is readable by all authenticated." on kizunasync.attachments;

-- The bucket row stays: direct deletes on Storage tables are guarded by
-- Supabase (storage.protect_delete()) and the demo has no reason to bypass
-- that guard. Flipping it private is enough: after the drops above, no policy
-- admits a read.
update storage.buckets set public = false where id = 'todos';

-- MARK: - Helper reach
--
-- 0002_example.sql's grant of EXECUTE on the anonymity probe to `authenticated`
-- stays: the shared-board UPDATE and DELETE policies call
-- public.todo_owner_is_anonymous(uuid) as the querying user, so revoking it
-- would refuse every write on this project. (0002_example.sql's other caller,
-- public.todo_image_writable, is dropped above with the upload surface.)

-- The row/write caps are trigger functions: Postgres checks EXECUTE at
-- trigger CREATION, not when a visitor's DML fires the trigger, so the caps
-- keep enforcing on every insert/update/delete with EXECUTE revoked. These
-- revokes repeat 0002_example.sql's, so this file closes the direct-RPC
-- surface on its own.
revoke execute on function public.todos_enforce_row_cap() from public, anon, authenticated;
revoke execute on function public.todos_enforce_write_cap() from public, anon, authenticated;

-- Supabase provisions a platform event-trigger function that the security
-- advisor flags as executable by anon/authenticated. Guarded: the local
-- stack may not carry it.
do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- MARK: - Reaper: shorter visitor lifetime
--
-- 0002_example.sql reaps an anonymous visitor idle for a day; on a public demo a
-- visitor with no todos is reaped after an idle hour, and every visitor after six
-- idle hours. Activity is the latest of creation, sign-in, token refresh, and sync:
-- an open tab keeps refreshing and syncing, and reaping it mid-visit strands both
-- panes on a deleted user. The cascade FK from 0002_example.sql still takes their
-- todos with them.

create or replace function public.reap_demo_visitors() returns integer
language plpgsql set search_path = '' as $$
declare
  v_reaped integer;
begin
  with last_activity as (
    select
      u.id,
      greatest(
        u.created_at,
        coalesce(u.last_sign_in_at, u.created_at),
        coalesce(r.refreshed_at, u.created_at),
        coalesce(c.seen_at, u.created_at)
      ) as active_at
    from auth.users u
    left join (
      select user_id, max(coalesce(updated_at, created_at)) as refreshed_at
      from auth.refresh_tokens
      group by user_id
    ) r on r.user_id = u.id::text
    left join (
      select user_id, max(last_seen) as seen_at
      from kizunasync._clients
      group by user_id
    ) c on c.user_id = u.id
    where u.is_anonymous
  ), gone as (
    delete from auth.users u
     using last_activity a
     where u.id = a.id
       and (
         a.active_at < now() - interval '6 hours'
         or (
           a.active_at < now() - interval '1 hour'
           and not exists (select 1 from public.todos t where t.user_id = u.id)
         )
       )
    returning 1
  )
  select count(*) into v_reaped from gone;

  delete from public.demo_write_counters where minute < now() - interval '1 day';

  return v_reaped;
end $$;

revoke all on function public.reap_demo_visitors() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('kizunasync-demo-reap-visitors')
      where exists (select 1 from cron.job where jobname = 'kizunasync-demo-reap-visitors');
    perform cron.schedule('kizunasync-demo-reap-visitors', '*/15 * * * *', 'select public.reap_demo_visitors()');
  end if;
end $$;

comment on function public.reap_demo_visitors() is
  'Demo reaper (public project): deletes an anonymous visitor idle for 1 hour with no todos, and any anonymous visitor idle for 6 hours. Activity is the latest of created_at, last_sign_in_at, a refresh token, and a kizunasync._clients last_seen.';
