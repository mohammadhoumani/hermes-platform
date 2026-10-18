-- Hermes Platform v2: RPCs.
--  * create_project: for signed-in users (atomic project + start_project order).
--  * platform_*: machine RPCs for the bridge and plugin. SECURITY DEFINER, search_path = '',
--    every one checks the write key stored in platform_private.keys (name = 'write'). Granted to anon only.
-- Idempotent (create or replace). No key values here.

-- ---------------------------------------------------------------------------
-- Key check (internal)
-- ---------------------------------------------------------------------------
create or replace function platform_private.check_write_key(k text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if k is null or k is distinct from (select kk.value from platform_private.keys kk where kk.name = 'write') then
    raise exception 'platform: wrong write key' using errcode = '28000';
  end if;
end;
$$;
revoke all on function platform_private.check_write_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_project (signed-in users)
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
-- platform_take_orders: claim queued orders (oldest first)
-- ---------------------------------------------------------------------------
create or replace function public.platform_take_orders(write_key text, max_rows integer default 5)
returns table (order_id bigint, project_id uuid, kind text, text text)
language plpgsql security definer set search_path = '' as $$
begin
  perform platform_private.check_write_key(write_key);
  return query
    with claimed as (
      update public.orders o
         set status = 'taken'
       where o.id in (
         select q.id from public.orders q
          where q.status = 'queued'
          order by q.id
          limit least(greatest(coalesce(max_rows, 5), 1), 20)
          for update skip locked)
      returning o.id as oid, o.project_id as pid, o.kind as k, o.text as t
    )
    select c.oid, c.pid, c.k, c.t from claimed c order by c.oid;
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_update_order
-- ---------------------------------------------------------------------------
create or replace function public.platform_update_order(
  write_key text, order_id bigint, status text, note text default null, run_id text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  kind_of text;
begin
  perform platform_private.check_write_key(write_key);
  if status is null or status not in ('queued', 'taken', 'running', 'waiting', 'done', 'failed') then
    raise exception 'platform: unknown order status' using errcode = '22023';
  end if;

  update public.orders o
     set status = platform_update_order.status,
         note   = coalesce(left(platform_update_order.note, 1000), o.note),
         run_id = coalesce(left(platform_update_order.run_id, 200), o.run_id)
   where o.id = platform_update_order.order_id
   returning o.kind into kind_of;

  if not found then
    raise exception 'platform: order not found' using errcode = 'P0002';
  end if;

  if kind_of = 'change_request' then
    update public.change_requests c
       set status = case platform_update_order.status
                      when 'running' then 'in_progress'
                      when 'waiting' then 'in_progress'
                      when 'done'    then 'done'
                      when 'failed'  then 'failed'
                      else 'open' end
     where c.order_id = platform_update_order.order_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_set_project: whitelisted keys only; unknown keys are an error
-- ---------------------------------------------------------------------------
create or replace function public.platform_set_project(write_key text, project_id uuid, fields jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  allowed text[] := array['status', 'phase', 'repo_url', 'staging_url', 'production_url', 'brd_markdown', 'brd_approved_at'];
  bad text;
begin
  perform platform_private.check_write_key(write_key);
  if jsonb_typeof(fields) is distinct from 'object' then
    raise exception 'platform: fields must be a JSON object' using errcode = '22023';
  end if;
  select k into bad from jsonb_object_keys(fields) as k where k <> all (allowed) limit 1;
  if bad is not null then
    raise exception 'platform: field not allowed: %', bad using errcode = '22023';
  end if;

  update public.projects p set
    status          = case when fields ? 'status'          then fields ->> 'status'          else p.status end,
    phase           = case when fields ? 'phase'           then fields ->> 'phase'           else p.phase end,
    repo_url        = case when fields ? 'repo_url'        then fields ->> 'repo_url'        else p.repo_url end,
    staging_url     = case when fields ? 'staging_url'     then fields ->> 'staging_url'     else p.staging_url end,
    production_url  = case when fields ? 'production_url'  then fields ->> 'production_url'  else p.production_url end,
    brd_markdown    = case when fields ? 'brd_markdown'    then fields ->> 'brd_markdown'    else p.brd_markdown end,
    brd_approved_at = case when fields ? 'brd_approved_at' then (fields ->> 'brd_approved_at')::timestamptz else p.brd_approved_at end
  where p.id = platform_set_project.project_id;

  if not found then
    raise exception 'platform: project not found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_map_session: link a Hermes session to a project.
-- Also back-fills events that arrived before the mapping (the plugin can be faster than the bridge),
-- including events of sub-agents whose sub_start was seen while the parent was still unmapped.
-- ---------------------------------------------------------------------------
create or replace function public.platform_map_session(
  write_key text, session_id text, project_id uuid, parent_session_id text default null, role text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform platform_private.check_write_key(write_key);
  if session_id is null or length(session_id) = 0 then
    raise exception 'platform: session_id is required' using errcode = '22023';
  end if;

  insert into public.project_sessions as ps (session_id, project_id, parent_session_id, role)
  values (platform_map_session.session_id, platform_map_session.project_id,
          platform_map_session.parent_session_id, left(platform_map_session.role, 60))
  on conflict on constraint project_sessions_pkey do update
    set project_id        = excluded.project_id,
        parent_session_id = coalesce(excluded.parent_session_id, ps.parent_session_id),
        role              = coalesce(excluded.role, ps.role);

  -- children seen earlier through orphan sub_start events
  with recursive d(child, parent, child_role) as (
    select e.payload ->> 'child', e.payload ->> 'parent', nullif(e.payload ->> 'role', '')
      from public.events e
     where e.project_id is null and e.type = 'sub_start'
       and e.payload ->> 'parent' = platform_map_session.session_id
       and coalesce(e.payload ->> 'child', '') <> ''
    union
    select e.payload ->> 'child', e.payload ->> 'parent', nullif(e.payload ->> 'role', '')
      from public.events e
      join d on e.payload ->> 'parent' = d.child
     where e.project_id is null and e.type = 'sub_start'
       and coalesce(e.payload ->> 'child', '') <> ''
  )
  insert into public.project_sessions (session_id, project_id, parent_session_id, role)
  select d.child, platform_map_session.project_id, d.parent, left(d.child_role, 60) from d
  on conflict on constraint project_sessions_pkey do nothing;

  update public.events e
     set project_id = ps.project_id
    from public.project_sessions ps
   where e.project_id is null
     and e.session_id = ps.session_id
     and ps.project_id = platform_map_session.project_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_ingest: store plugin events, resolve each one to a project through project_sessions.
-- sub_start: the child session inherits the parent's project automatically.
-- Events of unmapped sessions are kept with project_id = null and attached later by platform_map_session.
-- ---------------------------------------------------------------------------
create or replace function public.platform_ingest(write_key text, events jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  ev     jsonb;
  etype  text;
  sid    text;
  child  text;
  parent text;
  pid    uuid;
  stored integer := 0;
begin
  perform platform_private.check_write_key(write_key);
  if jsonb_typeof(events) is distinct from 'array' or jsonb_array_length(events) > 500 then
    raise exception 'platform: events must be a JSON array of at most 500 items' using errcode = '22023';
  end if;

  for ev in select j.value from jsonb_array_elements(events) with ordinality as j(value, n) order by j.n loop
    continue when jsonb_typeof(ev) is distinct from 'object' or length(ev::text) >= 20000;
    etype := left(coalesce(ev ->> 'type', ''), 64);
    continue when etype = '';

    sid    := nullif(ev ->> 'sid', '');
    child  := nullif(ev ->> 'child', '');
    parent := nullif(ev ->> 'parent', '');
    pid    := null;

    if etype = 'sub_start' and child is not null then
      select ps.project_id into pid from public.project_sessions ps where ps.session_id = parent;
      if pid is not null then
        insert into public.project_sessions (session_id, project_id, parent_session_id, role)
        values (child, pid, parent, left(nullif(ev ->> 'role', ''), 60))
        on conflict (session_id) do nothing;
      else
        select ps.project_id into pid from public.project_sessions ps where ps.session_id = child;
      end if;
      sid := child;
    else
      sid := coalesce(sid, child, parent);
      select ps.project_id into pid from public.project_sessions ps where ps.session_id = sid;
      if pid is null and parent is not null then  -- e.g. sub_stop of an unmapped child
        select ps.project_id into pid from public.project_sessions ps where ps.session_id = parent;
      end if;
    end if;

    insert into public.events (project_id, session_id, type, payload)
    values (pid, coalesce(sid, ''), etype, ev);
    stored := stored + 1;
  end loop;

  -- housekeeping: drop events nobody could ever see
  if random() < 0.02 then
    delete from public.events e where e.project_id is null and e.created_at < now() - interval '7 days';
  end if;
  return stored;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: machine RPCs are callable by anon only (the bridge uses the publishable key + write key)
-- ---------------------------------------------------------------------------
revoke all on function public.platform_take_orders(text, integer)                         from public, anon, authenticated;
revoke all on function public.platform_update_order(text, bigint, text, text, text)       from public, anon, authenticated;
revoke all on function public.platform_set_project(text, uuid, jsonb)                     from public, anon, authenticated;
revoke all on function public.platform_map_session(text, text, uuid, text, text)          from public, anon, authenticated;
revoke all on function public.platform_ingest(text, jsonb)                                from public, anon, authenticated;
grant execute on function public.platform_take_orders(text, integer)                      to anon;
grant execute on function public.platform_update_order(text, bigint, text, text, text)    to anon;
grant execute on function public.platform_set_project(text, uuid, jsonb)                  to anon;
grant execute on function public.platform_map_session(text, text, uuid, text, text)       to anon;
grant execute on function public.platform_ingest(text, jsonb)                             to anon;
