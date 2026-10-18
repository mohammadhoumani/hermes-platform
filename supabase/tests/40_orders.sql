-- Orders: kinds, text limits, ownership, rate limit. create_project RPC.
begin;
select t.as_user(t.alice_id());

-- Every allowed kind works on her own project
select t.eq(t.affected(format($$insert into public.orders (project_id, kind, text) select id, %L, 'hello' from public.projects$$, k)), 1::bigint, 'alice can order kind ' || k)
  from unnest(array['message', 'request_brd_changes', 'change_request', 'start_project']) as k;
select t.eq(t.affected(format($$insert into public.orders (project_id, kind) select id, %L from public.projects$$, k)), 1::bigint, 'kind ' || k || ' may have empty text')
  from unnest(array['approve_brd', 'stop', 'resume']) as k;

-- Rejections
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'format_disk', 'x' from public.projects$$, '23514', 'unknown kind is rejected');
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'message', '' from public.projects$$, '23514', 'empty message is rejected');
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'message', '   ' from public.projects$$, '23514', 'blank message is rejected');
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'start_project', '' from public.projects$$, '23514', 'empty start_project is rejected');
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'message', repeat('x', 4001) from public.projects$$, '23514', 'text over 4000 characters is rejected');
select t.eq(t.affected($$insert into public.orders (project_id, kind, text) select id, 'message', repeat('x', 4000) from public.projects$$), 1::bigint, 'text of exactly 4000 characters is accepted');
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'message', null from public.projects$$, '23502', 'null text is rejected');

-- Cannot order on someone else's project, cannot forge user or status
-- bob targets alice's project (found as superuser because bob cannot see it)
create temp table ids as select (select id from public.projects where name = 'Alice Calculator') as alice_project;
grant select on ids to authenticated;
select t.as_user(t.bob_id());
select t.throws($$insert into public.orders (project_id, kind, text) select alice_project, 'message', 'into alice''s project' from ids$$, '42501', 'bob cannot order on alice''s project');
select t.throws($$insert into public.orders (project_id, kind, text) select alice_project, 'stop', '' from ids$$, '42501', 'bob cannot stop alice''s project');
select t.throws($$insert into public.orders (project_id, kind, text, user_id) select alice_project, 'message', 'x', auth.uid() from ids$$, '42501', 'user_id and status cannot be set by hand (column not granted)');
select t.throws($$insert into public.orders (project_id, kind, text, status) select id, 'message', 'x', 'done' from public.projects$$, '42501', 'status cannot be forced to done');
reset role;

-- Team owners cannot order on other people's projects either
select t.as_user(t.owner_id());
select t.throws($$insert into public.orders (project_id, kind, text) select alice_project, 'message', 'x' from ids$$, '42501', 'team owner cannot order on a project they do not own');
reset role;

-- Rate limit: 40 per 10 minutes per user
select t.eq((select count(*) from public.orders where user_id = t.alice_id()), 9::bigint, 'alice has 9 orders so far (start_project + 8 above)');
select t.as_user(t.alice_id());
select t.eq(t.affected($$insert into public.orders (project_id, kind, text) select p.id, 'message', 'bulk ' || g from public.projects p, generate_series(1, 31) g$$), 31::bigint, 'orders up to the limit (40) are accepted');
select t.throws($$insert into public.orders (project_id, kind, text) select id, 'message', 'one too many' from public.projects$$, '54000', 'the 41st order in 10 minutes is rejected', 'Too many orders');
reset role;

-- Another user is not affected
select t.as_user(t.bob_id());
select t.eq(t.affected($$insert into public.orders (project_id, kind, text) select id, 'message', 'bob is fine' from public.projects$$), 1::bigint, 'the limit is per user: bob can still order');
reset role;

-- The window moves: after 10 minutes the limit is gone
update public.orders set created_at = now() - interval '11 minutes' where user_id = t.alice_id();
select t.as_user(t.alice_id());
select t.eq(t.affected($$insert into public.orders (project_id, kind, text) select id, 'message', 'later' from public.projects$$), 1::bigint, 'orders older than 10 minutes do not count');
reset role;

-- change_request orders are mirrored to change_requests, and the machine updates their status
select t.eq((select count(*) from public.change_requests where user_id = t.alice_id()), 1::bigint, 'a change_request order creates a change request row');
select t.as_anon();
select public.platform_update_order('w-test', t.change_request_order(t.alice_id()), 'running');
reset role;
select t.eq((select status from public.change_requests where user_id = t.alice_id()), 'in_progress', 'change request follows the order status');
select t.as_user(t.alice_id());
select t.eq(t.count($$select 1 from public.change_requests$$), 1::bigint, 'alice can read her change request');
reset role;
select t.as_user(t.bob_id());
select t.eq(t.count($$select 1 from public.change_requests$$), 0::bigint, 'bob cannot read alice''s change request');
reset role;
rollback;

-- create_project RPC
begin;
select t.as_user(t.alice_id());
select t.ok(public.create_project('  My Cool App!! ', 'An app that does cool things') is not null, 'create_project returns the new id');
select t.ok((select slug ~ '^my-cool-app-[0-9a-f]{6}$' from public.projects where name = 'My Cool App!!'), 'slug is made from the name');
select t.eq((select count(*) from public.orders o join public.projects p on p.id = o.project_id where p.name = 'My Cool App!!' and o.kind = 'start_project' and o.text = 'An app that does cool things'), 1::bigint, 'a start_project order is created with the idea');
select t.eq((select status from public.projects where name = 'My Cool App!!'), 'queued', 'new projects start queued');
select t.ok((select owner_id = t.alice_id() from public.projects where name = 'My Cool App!!'), 'the caller owns the new project');
select t.throws($$select public.create_project('', 'idea')$$, '22023', 'create_project needs a name');
select t.throws($$select public.create_project('x', '  ')$$, '22023', 'create_project needs an idea');
select t.throws($$select public.create_project(repeat('x', 121), 'idea')$$, '22023', 'create_project limits the name length');
select t.throws($$select public.create_project('x', repeat('x', 4001))$$, '22023', 'create_project limits the idea length');
select t.ok(public.create_project('!!!', 'symbols only name') is not null, 'create_project copes with a name that has no letters');
select t.ok(public.create_project('My Cool App!!', 'same name twice') is not null, 'two projects may have the same name');
reset role;
select t.as_anon();
select t.throws($$select public.create_project('x', 'y')$$, '42501', 'anon cannot create projects');
reset role;
rollback;
