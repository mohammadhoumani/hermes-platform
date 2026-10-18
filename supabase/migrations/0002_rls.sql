-- Hermes Platform v2: row level security and grants.
-- Idempotent: policies are dropped and re-created.
-- Order matters: 0005 replaces platform_is_owner() and three policies (disabled people see nothing).
-- Apply the files in order; never re-run an older file on its own after a newer one.
--
-- Rules (see docs/IMPLEMENTATION_PLAN.md section 3):
--  * A user sees a project only if they own it. Users with profiles.role = 'owner' see every project.
--  * Events, sessions, orders and change requests follow project visibility. No client inserts for events/sessions.
--  * Orders: insert only for your own project, only the allowed kinds, <= 4000 chars, rate limited (trigger).
--  * Invites: only the 'owner' role can select, insert and delete.
--  * Projects are created through public.create_project (0003), never by direct insert.

-- Helper used by policies. SECURITY DEFINER so that it can read profiles without recursing into profiles' own policies.
create or replace function public.platform_is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'owner');
$$;
revoke all on function public.platform_is_owner() from public, anon;
grant execute on function public.platform_is_owner() to authenticated;

alter table public.profiles         enable row level security;
alter table public.invites          enable row level security;
alter table public.projects         enable row level security;
alter table public.project_sessions enable row level security;
alter table public.orders           enable row level security;
alter table public.events           enable row level security;
alter table public.change_requests  enable row level security;
alter table platform_private.keys   enable row level security;  -- no policies: nobody but the definer functions

-- ---------------------------------------------------------------------------
-- Grants: start from nothing, then give exactly what the web app needs.
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.invites, public.projects, public.project_sessions,
              public.orders, public.events, public.change_requests from anon, authenticated;
revoke all on platform_private.keys from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, delete on public.invites to authenticated;
grant insert (email, role) on public.invites to authenticated;
grant select on public.projects to authenticated;
grant select on public.project_sessions to authenticated;
grant select on public.events to authenticated;
grant select on public.change_requests to authenticated;
grant select on public.orders to authenticated;
grant insert (project_id, kind, text) on public.orders to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.platform_is_owner());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select to authenticated
  using (public.platform_is_owner());

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert to authenticated
  with check (public.platform_is_owner() and invited_by = auth.uid() and accepted_at is null);

drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete to authenticated
  using (public.platform_is_owner() and accepted_at is null);

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using (owner_id = auth.uid() or public.platform_is_owner());

-- The subselects below run under the projects policy above, so visibility is inherited.
drop policy if exists project_sessions_select on public.project_sessions;
create policy project_sessions_select on public.project_sessions for select to authenticated
  using (project_id in (select p.id from public.projects p));

drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using (project_id in (select p.id from public.projects p));

drop policy if exists change_requests_select on public.change_requests;
create policy change_requests_select on public.change_requests for select to authenticated
  using (project_id in (select p.id from public.projects p));

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated
  using (project_id in (select p.id from public.projects p));

-- Insert: your own order, on a project you own yourself (even team owners cannot order on someone else's project).
drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );
