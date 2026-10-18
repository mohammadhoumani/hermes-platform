-- Fixtures, committed once. Fake emails and the fake write key 'w-test' only.
-- Lookups usable while acting as anon/authenticated (security definer: they read tables the caller cannot).
create or replace function t.project_id(project_name text) returns uuid language sql security definer stable as $$
  select id from public.projects where name = project_name order by created_at limit 1 $$;
create or replace function t.first_order() returns bigint language sql security definer stable as $$
  select min(id) from public.orders $$;
create or replace function t.change_request_order(uid uuid) returns bigint language sql security definer stable as $$
  select order_id from public.change_requests where user_id = uid order by id limit 1 $$;

begin;
insert into platform_private.keys (name, value) values ('write', 'w-test') on conflict (name) do update set value = excluded.value;

-- 0004 already invited the first owner. Invite the others.
insert into public.invites (email, role) values ('alice@example.test', 'member'), ('bob@example.test', 'member');

-- Sign-ups (fire the invite trigger and create profiles)
insert into auth.users (id, email) values
  (t.owner_id(), 'mhmdhoumani04@gmail.com'),
  (t.alice_id(), 'alice@example.test'),
  (t.bob_id(),   'bob@example.test');

-- Alice and Bob each create a project through the RPC, exactly as the web app does.
select t.as_user(t.alice_id());
select public.create_project('Alice Calculator', 'A tip calculator that splits the bill');
reset role;
select t.as_user(t.bob_id());
select public.create_project('Bob Kanban', 'A kanban board for small teams');
reset role;

-- The bridge maps sessions and the plugin sends events (as the machine, with the write key).
select public.platform_map_session('w-test', 'sess-alice', (select id from public.projects where name = 'Alice Calculator'), null, 'orchestrator');
select public.platform_map_session('w-test', 'sess-bob',   (select id from public.projects where name = 'Bob Kanban'), null, 'orchestrator');
select public.platform_ingest('w-test', '[
  {"type":"turn_start","sid":"sess-alice","text":"hello from alice"},
  {"type":"turn_start","sid":"sess-bob","text":"hello from bob"}
]'::jsonb);
commit;
