-- The minimal Supabase-managed surface a bare Postgres database needs before
-- the Kizuna pack and the example migrations apply to it.
--
-- A `create database` inside the local stack's container carries none of the
-- schemas the Supabase image seeds into `postgres`, so `0001_kizuna_init.sql`
-- fails on `schema "auth" does not exist` and the example migrations fail on
-- the storage tables and the pgcrypto helpers. Everything here exists so those
-- files apply: the shapes match what the migrations read, not what the vendor
-- ships. The one vendor behavior copied as shipped is the Storage delete guard,
-- so the tests meet the refusal a real stack raises. The roles (`anon`,
-- `authenticated`, `service_role`) are cluster-wide and are not created here.
--
-- Applied to the CLI's `kizunasync_cli_scratch` by `crates/kizunasync-cli/tests/postgres.rs`
-- and to the pack's `kizunasync_scratch` by
-- `packages/supabase-pack/scripts/rebuild-scratch.sh`, on every run: every
-- statement is idempotent.

create schema if not exists auth;

-- Where the Supabase image keeps pgcrypto: the demo seed hashes its shared
-- local password with `extensions.crypt` and `extensions.gen_salt`.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- The three claim readers the pack and the example migrations call, reading
-- `request.jwt.claims` the way the Supabase originals do.
create or replace function auth.uid() returns uuid
  language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

create or replace function auth.jwt() returns jsonb
  language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb;
$$;

create or replace function auth.role() returns text
  language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$;

-- The columns the example migrations write and read, and no others: the demo
-- seed inserts users and identities directly, `0002_example.sql` cascades `public.todos`
-- off `auth.users (id)` and reaps an `is_anonymous` user by its last sign-in,
-- token refresh, and sync.
create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  confirmation_token varchar(255),
  recovery_token varchar(255),
  email_change varchar(255),
  email_change_token_new varchar(255),
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  last_sign_in_at timestamptz,
  is_sso_user boolean not null default false,
  is_anonymous boolean not null default false
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_id text not null,
  provider text not null,
  identity_data jsonb not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  unique (provider_id, provider)
);

create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  user_id varchar(255),
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create schema if not exists storage;

-- The path splitter the pack's attachment functions and the example storage
-- policies call: every segment but the last.
create or replace function storage.foldername(name text) returns text[]
  language sql immutable
as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1];
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false,
  avif_autodetection boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text,
  user_metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now()
);

alter table storage.objects enable row level security;

-- Supabase refuses a direct delete from its Storage tables unless the
-- transaction sets storage.allow_delete_query to 'true': storage.protect_delete()
-- and its two triggers, as the local stack ships them.
create or replace function storage.protect_delete() returns trigger
  language plpgsql
as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), 'false') != 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
      using hint = 'This prevents accidental data loss from orphaned objects.',
            errcode = '42501';
  end if;
  return null;
end;
$$;

create or replace trigger protect_buckets_delete
  before delete on storage.buckets
  for each statement execute function storage.protect_delete();

create or replace trigger protect_objects_delete
  before delete on storage.objects
  for each statement execute function storage.protect_delete();

create schema if not exists realtime;

-- The pack's wakeup policy reads `realtime.topic()` and the trackers broadcast
-- through `realtime.send`, which is deliberately failure-tolerant in the
-- vendor original too: a broadcast nobody receives must not fail the write
-- that produced it.
create or replace function realtime.topic() returns text
  language sql stable
as $$
  select nullif(current_setting('realtime.topic', true), '')::text;
$$;

-- Unpartitioned, unlike the vendor table: nothing here reads the messages
-- back, so the range partitions would only add statements that can go stale.
create table if not exists realtime.messages (
  id uuid not null default gen_random_uuid(),
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

alter table realtime.messages enable row level security;

create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void
  language plpgsql
as $$
begin
  begin
    execute format('set local realtime.topic to %L', topic);
    insert into realtime.messages (payload, event, topic, private, extension)
    values (payload, event, topic, private, 'broadcast');
  exception
    when others then
      raise warning 'WarnSendingBroadcastMessage: %', sqlerrm;
  end;
end;
$$;
