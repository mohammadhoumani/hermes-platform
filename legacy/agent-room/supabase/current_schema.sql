-- Snapshot (2026-10-18) of the LIVE Supabase project hermes-agent-room (ref dzqvokssnvsfhixswhtf).
-- Reference only: this is what the current bridge, plugin and legacy website talk to.
-- Keys live in agent_room.keys / agent_room.command_keys (values NOT included here).

-- Tables (private schema agent_room, not exposed to the API; reached only via the RPCs below)
--   agent_room.keys          (name text, value text)            -- 'write', 'read'
--   agent_room.command_keys  (name text, value text)            -- 'send'
--   agent_room.events        (id bigint, created_at timestamptz default now(), event jsonb)
--   agent_room.commands      (id bigint, created_at timestamptz default now(), updated_at timestamptz default now(),
--                             kind text default 'message', text text default '', status text default 'queued',
--                             run_id text, note text)

CREATE OR REPLACE FUNCTION public.agent_room_ingest(write_key text, events jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
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
  if random() < 0.02 then
    delete from agent_room.events where created_at < now() - interval '30 days';
  end if;
  return stored;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agent_room_my_commands(send_key text, max_rows integer DEFAULT 20)
 RETURNS TABLE(id bigint, created_at timestamp with time zone, kind text, text text, status text, note text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  if send_key is null or send_key is distinct from (select c.value from agent_room.command_keys c where c.name = 'send') then
    raise exception 'agent_room: wrong send key' using errcode = '28000';
  end if;
  return query
    select t.id, t.created_at, t.kind, t.text, t.status, t.note from (
      select c.id, c.created_at, c.kind, c.text, c.status, c.note from agent_room.commands c
      order by c.id desc limit least(greatest(coalesce(max_rows, 20), 1), 100)
    ) t order by t.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agent_room_read(read_key text, after_id bigint DEFAULT 0, max_rows integer DEFAULT 1000)
 RETURNS TABLE(id bigint, event jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  n integer := least(greatest(coalesce(max_rows, 1000), 1), 5000);
begin
  if read_key is null or read_key is distinct from (select k.value from agent_room.keys k where k.name = 'read') then
    raise exception 'agent_room: wrong read key' using errcode = '28000';
  end if;
  if coalesce(after_id, 0) <= 0 then
    return query select t.id, t.event from (select e.id, e.event from agent_room.events e order by e.id desc limit n) t order by t.id;
  else
    return query select e.id, e.event from agent_room.events e where e.id > after_id order by e.id limit n;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agent_room_send(send_key text, message text, kind text DEFAULT 'message'::text)
 RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  new_id bigint;
  k text := coalesce(kind, 'message');
begin
  if send_key is null or send_key is distinct from (select c.value from agent_room.command_keys c where c.name = 'send') then
    raise exception 'agent_room: wrong send key' using errcode = '28000';
  end if;
  if k not in ('project', 'message', 'approve_once', 'deny', 'stop') then
    raise exception 'agent_room: unknown kind' using errcode = '22023';
  end if;
  if k in ('project', 'message') and length(trim(coalesce(message, ''))) = 0 then
    raise exception 'agent_room: empty message' using errcode = '22023';
  end if;
  if length(coalesce(message, '')) > 4000 then
    raise exception 'agent_room: message too long (4000 characters max)' using errcode = '22023';
  end if;
  if (select count(*) from agent_room.commands c where c.created_at > now() - interval '10 minutes') >= 40 then
    raise exception 'agent_room: too many orders, wait a few minutes' using errcode = '54000';
  end if;
  insert into agent_room.commands (kind, text) values (k, coalesce(message, '')) returning id into new_id;
  return new_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agent_room_take(write_key text, max_rows integer DEFAULT 5)
 RETURNS TABLE(id bigint, kind text, text text) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  if write_key is null or write_key is distinct from (select k.value from agent_room.keys k where k.name = 'write') then
    raise exception 'agent_room: wrong write key' using errcode = '28000';
  end if;
  return query
    update agent_room.commands c set status = 'taken', updated_at = now()
    where c.id in (
      select q.id from agent_room.commands q where q.status = 'queued'
      order by q.id limit least(greatest(coalesce(max_rows, 5), 1), 20)
      for update skip locked
    )
    returning c.id, c.kind, c.text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agent_room_update(write_key text, command_id bigint, new_status text, new_note text DEFAULT NULL::text, new_run_id text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  if write_key is null or write_key is distinct from (select k.value from agent_room.keys k where k.name = 'write') then
    raise exception 'agent_room: wrong write key' using errcode = '28000';
  end if;
  update agent_room.commands c
    set status = left(coalesce(new_status, c.status), 20),
        note = coalesce(left(new_note, 1000), c.note),
        run_id = coalesce(new_run_id, c.run_id),
        updated_at = now()
  where c.id = command_id;
end;
$function$;
