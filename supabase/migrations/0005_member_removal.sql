-- Hermes Platform v2: owners can remove a member's access (and give it back).
-- Idempotent: columns use IF NOT EXISTS, functions are CREATE OR REPLACE, policies are dropped and re-created.
--
-- How it works
--  * profiles.disabled_at marks a person whose access was removed. Nothing is deleted: their projects stay,
--    so the team does not lose work, and the access can be given back.
--  * The row level security policies below stop a disabled person from reading or writing anything
--    (except their own profile row, so the website can say "your access was removed"). This is the real lock.
--    It works at once, even if the person still holds a valid login token.
--  * remove_member() also bans the login (auth.users.banned_until) and deletes their sessions, so the token is
--    useless within a short time. That part is defence in depth: the policies do not depend on it.
--  * Their running projects get a 'stop' order, so agents do not keep working for someone who no longer has access.
--  * Owners cannot remove themselves or other owners (this prevents locking the team out by mistake).
-- Apply after 0002/0003 (it replaces platform_is_owner(), three policies and create_project). Do not re-run 0002 or 0003 alone afterwards.
-- No secrets in this file.

alter table public.profiles add column if not exists disabled_at timestamptz;
alter table public.profiles add column if not exists disabled_by uuid references auth.users (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Helpers used by the policies (SECURITY DEFINER so they can read profiles without recursion)
-- ---------------------------------------------------------------------------
create or replace function public.platform_is_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.disabled_at is null);
$$;
revoke all on function public.platform_is_active() from public, anon;
grant execute on function public.platform_is_active() to authenticated;

-- An owner whose access was removed is not an owner any more.
create or replace function public.platform_is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner' and p.disabled_at is null);
$$;
revoke all on function public.platform_is_owner() from public, anon;
grant execute on function public.platform_is_owner() to authenticated;

-- ---------------------------------------------------------------------------
-- Policies: a disabled person sees and does nothing
-- ---------------------------------------------------------------------------
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() and public.platform_is_active())
  with check (id = auth.uid() and public.platform_is_active());

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using ((owner_id = auth.uid() and public.platform_is_active()) or public.platform_is_owner());

drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.platform_is_active()
    and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );

-- profiles_select, invites_*, project_sessions_select, events_select, change_requests_select and orders_select
-- need no change: they depend on platform_is_owner() or on the projects policy above.

-- ---------------------------------------------------------------------------
-- create_project: same as 0003, plus the access check (a clear message instead of an empty result)
-- ---------------------------------------------------------------------------
create or replace function public.create_project(project_name text, idea text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid  uuid := auth.uid();
  nm   text := btrim(coalesce(project_name, ''));
  txt  text := btrim(coalesce(idea, ''));
  base text;
  pid  uuid;
begin
  if uid is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;
  if not public.platform_is_active() then
    raise exception 'Your access has been removed. Ask a team owner if this is a mistake.' using errcode = '42501';
  end if;
  if length(nm) < 1 or length(nm) > 120 then
    raise exception 'Give your project a name (1 to 120 characters).' using errcode = '22023';
  end if;
  if length(txt) < 1 or length(txt) > 4000 then
    raise exception 'Describe your idea (1 to 4000 characters).' using errcode = '22023';
  end if;
  base := trim(both '-' from regexp_replace(lower(nm), '[^a-z0-9]+', '-', 'g'));
  base := trim(both '-' from left(base, 40));
  if base = '' then base := 'project'; end if;

  insert into public.projects (owner_id, name, slug)
  values (uid, nm, base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6))
  returning id into pid;

  insert into public.orders (project_id, user_id, kind, text)
  values (pid, uid, 'start_project', txt);
  return pid;
end;
$$;
revoke all on function public.create_project(text, text) from public, anon;
grant execute on function public.create_project(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- team_members(): the list for /settings/team (owners only; reads emails from auth.users)
-- ---------------------------------------------------------------------------
create or replace function public.team_members()
returns table (
  id            uuid,
  email         text,
  display_name  text,
  role          text,
  created_at    timestamptz,
  disabled_at   timestamptz,
  project_count bigint
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.platform_is_owner() then
    raise exception 'Only owners can see the team.' using errcode = '42501';
  end if;
  return query
    select p.id, u.email::text, p.display_name, p.role, p.created_at, p.disabled_at,
           (select count(*) from public.projects pr where pr.owner_id = p.id)
      from public.profiles p
      join auth.users u on u.id = p.id
     order by p.created_at, p.id;
end;
$$;
revoke all on function public.team_members() from public, anon;
grant execute on function public.team_members() to authenticated;

-- ---------------------------------------------------------------------------
-- remove_member / restore_member (owners only)
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me     uuid := auth.uid();
  target public.profiles%rowtype;
begin
  if not public.platform_is_owner() then
    raise exception 'Only owners can remove access.' using errcode = '42501';
  end if;
  select * into target from public.profiles pr where pr.id = member_id for update;
  if not found then
    raise exception 'That person was not found.' using errcode = 'P0002';
  end if;
  if member_id = me then
    raise exception 'You cannot remove your own access.' using errcode = '22023';
  end if;
  if target.role = 'owner' then
    raise exception 'Owners cannot be removed here. Ask the person to leave the team, or change their role in the database.' using errcode = '22023';
  end if;
  if target.disabled_at is not null then
    return;  -- already removed: nothing to do
  end if;

  update public.profiles pr set disabled_at = now(), disabled_by = me where pr.id = member_id;

  -- agents stop working on their projects
  insert into public.orders (project_id, user_id, kind, text)
  select pj.id, me, 'stop', 'Access removed by a team owner.'
    from public.projects pj
   where pj.owner_id = member_id and pj.status not in ('released', 'failed', 'stopped');

  -- end their login (best effort; the policies above already lock the data)
  begin
    update auth.users u set banned_until = 'infinity' where u.id = member_id;
    delete from auth.sessions s where s.user_id = member_id;
  exception when undefined_table or undefined_column or insufficient_privilege then
    raise warning 'platform: could not end the sessions of % (the data lock still applies)', member_id;
  end;
end;
$$;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;

create or replace function public.restore_member(member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.platform_is_owner() then
    raise exception 'Only owners can give access back.' using errcode = '42501';
  end if;
  update public.profiles pr set disabled_at = null, disabled_by = null where pr.id = member_id;
  if not found then
    raise exception 'That person was not found.' using errcode = 'P0002';
  end if;
  begin
    update auth.users u set banned_until = null where u.id = member_id;
  exception when undefined_table or undefined_column or insufficient_privilege then
    raise warning 'platform: could not lift the login ban of %', member_id;
  end;
end;
$$;
revoke all on function public.restore_member(uuid) from public, anon;
grant execute on function public.restore_member(uuid) to authenticated;
