-- Hermes Platform v2: core tables, constraints, triggers (invite-only sign-up, order rate limit).
-- Idempotent: safe to run more than once. No secrets in this file.
-- Row level security and grants are in 0002_rls.sql; machine RPCs in 0003_rpcs.sql.

create extension if not exists citext with schema extensions;

create schema if not exists platform_private;
revoke all on schema platform_private from public;

-- ---------------------------------------------------------------------------
-- Machine keys (private schema, never exposed through the API)
-- The operator inserts the write key later:
--   insert into platform_private.keys (name, value) values ('write', '<long random value>');
-- ---------------------------------------------------------------------------
create table if not exists platform_private.keys (
  name  text primary key,
  value text not null check (length(value) > 0)
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 80),
  role         text not null default 'member' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now()
);

create table if not exists public.invites (
  email       extensions.citext primary key
              check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role        text not null default 'member' check (role in ('owner', 'member')),
  invited_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);

create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  slug             text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  status           text not null default 'queued' check (status in (
                     'queued', 'discovery', 'awaiting_brd_approval', 'architecture', 'development',
                     'review', 'qa', 'releasing', 'released', 'paused', 'failed', 'stopped')),
  -- phase drives the progress rail; null until the run starts
  phase            text check (phase in ('discovery', 'architecture', 'development', 'review', 'qa', 'release')),
  repo_url         text check (repo_url is null or (repo_url ~* '^https?://' and length(repo_url) <= 2000)),
  staging_url      text check (staging_url is null or (staging_url ~* '^https?://' and length(staging_url) <= 2000)),
  production_url   text check (production_url is null or (production_url ~* '^https?://' and length(production_url) <= 2000)),
  brd_markdown     text check (brd_markdown is null or length(brd_markdown) <= 200000),
  brd_approved_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists projects_owner_idx on public.projects (owner_id, created_at desc);

create table if not exists public.project_sessions (
  session_id         text primary key check (length(session_id) between 1 and 200),
  project_id         uuid not null references public.projects (id) on delete cascade,
  parent_session_id  text,
  role               text check (role is null or length(role) <= 60),
  created_at         timestamptz not null default now()
);
create index if not exists project_sessions_project_idx on public.project_sessions (project_id);
create index if not exists project_sessions_parent_idx on public.project_sessions (parent_session_id);

create table if not exists public.orders (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind        text not null check (kind in (
                'start_project', 'message', 'approve_brd', 'request_brd_changes', 'change_request', 'stop', 'resume')),
  text        text not null default '' check (length(text) <= 4000),
  status      text not null default 'queued' check (status in ('queued', 'taken', 'running', 'waiting', 'done', 'failed')),
  note        text check (note is null or length(note) <= 1000),
  run_id      text check (run_id is null or length(run_id) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- only these kinds may carry an empty text
  constraint orders_text_required check (kind in ('approve_brd', 'stop', 'resume') or length(btrim(text)) > 0)
);
create index if not exists orders_project_idx on public.orders (project_id, id);
create index if not exists orders_queue_idx on public.orders (id) where status = 'queued';
create index if not exists orders_user_time_idx on public.orders (user_id, created_at desc);

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  project_id  uuid references public.projects (id) on delete cascade,
  session_id  text not null default '',
  type        text not null check (length(type) between 1 and 64),
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_project_idx on public.events (project_id, id);
create index if not exists events_session_idx on public.events (session_id) where project_id is null;

create table if not exists public.change_requests (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  order_id    bigint references public.orders (id) on delete set null,
  text        text not null check (length(btrim(text)) between 1 and 4000),
  status      text not null default 'open' check (status in ('open', 'in_progress', 'done', 'failed')),
  created_at  timestamptz not null default now()
);
create index if not exists change_requests_project_idx on public.change_requests (project_id, id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
create or replace function platform_private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function platform_private.touch_updated_at();

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function platform_private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Invite-only sign-up (emails compared with lower(); operators of the citext type are not on the empty search_path): reject emails that are not in public.invites,
-- then create the profile and stamp the invite.
-- (Two triggers: the profile row needs the auth.users row to exist first.)
-- ---------------------------------------------------------------------------
create or replace function platform_private.require_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null
     or not exists (select 1 from public.invites i where lower(i.email::text) = lower(new.email)) then
    raise exception 'This email has not been invited. Ask the team owner to invite you.'
      using errcode = '42501', hint = 'invite_required';
  end if;
  return new;
end;
$$;

create or replace function platform_private.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  inv_role text;
begin
  update public.invites i
     set accepted_at = coalesce(i.accepted_at, now())
   where lower(i.email::text) = lower(new.email)
   returning i.role into inv_role;

  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)), 80),
    coalesce(inv_role, 'member')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists platform_require_invite on auth.users;
create trigger platform_require_invite before insert on auth.users
  for each row execute function platform_private.require_invite();

drop trigger if exists platform_create_profile on auth.users;
create trigger platform_create_profile after insert on auth.users
  for each row execute function platform_private.create_profile_for_user();

-- ---------------------------------------------------------------------------
-- Orders: rate limit (40 per 10 minutes per user) and change request mirror
-- ---------------------------------------------------------------------------
create or replace function platform_private.orders_rate_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- serialise inserts of one user so two parallel requests cannot both slip under the limit
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  if (select count(*) from public.orders o
       where o.user_id = new.user_id and o.created_at > now() - interval '10 minutes') >= 40 then
    raise exception 'Too many orders. Please wait a few minutes and try again.'
      using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_rate_limit on public.orders;
create trigger orders_rate_limit before insert on public.orders
  for each row execute function platform_private.orders_rate_limit();

create or replace function platform_private.orders_mirror_change_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'change_request' then
    insert into public.change_requests (project_id, user_id, order_id, text)
    values (new.project_id, new.user_id, new.id, new.text);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_mirror_change_request on public.orders;
create trigger orders_mirror_change_request after insert on public.orders
  for each row execute function platform_private.orders_mirror_change_request();

-- ---------------------------------------------------------------------------
-- Realtime: the web app subscribes to events, orders and projects (RLS applies)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['events', 'orders', 'projects'] loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- Trigger functions are never called directly; keep them off the API surface.
revoke all on function platform_private.touch_updated_at()              from public, anon, authenticated;
revoke all on function platform_private.require_invite()                from public, anon, authenticated;
revoke all on function platform_private.create_profile_for_user()       from public, anon, authenticated;
revoke all on function platform_private.orders_rate_limit()             from public, anon, authenticated;
revoke all on function platform_private.orders_mirror_change_request() from public, anon, authenticated;
