-- Agent Room: Supabase setup
-- Paste all of this into Supabase > SQL Editor > New query, then press Run.
-- Safe to run again: it keeps your events and your keys.
--
-- What it makes:
--   agent_room.events  the event log (private schema, not reachable from the API)
--   agent_room.keys    a WRITE key (for the Hermes server) and a READ key (for the website)
--   public.agent_room_ingest(write_key, events)  used by the Hermes plugin to add events
--   public.agent_room_read(read_key, after_id, max_rows)  used by the website to read events
-- The last statement shows your two keys. Copy them.

create schema if not exists agent_room;

create table if not exists agent_room.events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event      jsonb not null
);
create index if not exists events_created_at_idx on agent_room.events (created_at);

create table if not exists agent_room.keys (
  name  text primary key check (name in ('write', 'read')),
  value text not null
);

insert into agent_room.keys (name, value) values
  ('write', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  ('read',  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

-- Nobody reaches the tables directly. Only the two functions below can.
alter table agent_room.events enable row level security;
alter table agent_room.keys   enable row level security;
revoke all on schema agent_room from public;
revoke all on all tables in schema agent_room from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema agent_room from anon';
    execute 'revoke all on all tables in schema agent_room from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema agent_room from authenticated';
    execute 'revoke all on all tables in schema agent_room from authenticated';
  end if;
end $$;

-- Add a batch of events (a JSON array, up to 500). Returns how many were stored.
create or replace function public.agent_room_ingest(write_key text, events jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  stored integer;
begin
  if write_key is null or write_key is distinct from (select k.value from agent_room.keys k where k.name = 'write') then
    raise exception 'agent_room: wrong write key' using errcode = '28000';
  end if;
  if jsonb_typeof(events) is distinct from 'array' or jsonb_array_length(events) > 500 then
    raise exception 'agent_room: events must be a JSON array of at most 500 items' using errcode = '22023';
  end if;
  insert into agent_room.events (event)
  select e from jsonb_array_elements(events) as e
  where jsonb_typeof(e) = 'object' and length(e::text) < 20000;
  get diagnostics stored = row_count;
  -- Keep the log small: now and then, drop events older than 30 days.
  if random() < 0.02 then
    delete from agent_room.events where created_at < now() - interval '30 days';
  end if;
  return stored;
end;
$$;

-- Read events after a given id (oldest first).
-- after_id <= 0 means "the latest max_rows events", used when the page first opens.
create or replace function public.agent_room_read(read_key text, after_id bigint default 0, max_rows integer default 1000)
returns table (id bigint, event jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n integer := least(greatest(coalesce(max_rows, 1000), 1), 5000);
begin
  if read_key is null or read_key is distinct from (select k.value from agent_room.keys k where k.name = 'read') then
    raise exception 'agent_room: wrong read key' using errcode = '28000';
  end if;
  if coalesce(after_id, 0) <= 0 then
    return query
      select t.id, t.event from (
        select e.id, e.event from agent_room.events e order by e.id desc limit n
      ) t order by t.id;
  else
    return query
      select e.id, e.event from agent_room.events e where e.id > after_id order by e.id limit n;
  end if;
end;
$$;

revoke all on function public.agent_room_ingest(text, jsonb) from public;
revoke all on function public.agent_room_read(text, bigint, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.agent_room_ingest(text, jsonb) to anon';
    execute 'grant execute on function public.agent_room_read(text, bigint, integer) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.agent_room_read(text, bigint, integer) to authenticated';
  end if;
end $$;

-- Tell the API about the new functions.
notify pgrst, 'reload schema';

-- Your keys. Copy both.
select name as key, value from agent_room.keys order by name desc;
