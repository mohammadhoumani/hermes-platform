-- User A cannot read user B's data. Owners see everything. Clients cannot write machine tables.
begin;
select t.as_user(t.alice_id());
select t.eq((select count(*) from public.projects), 1::bigint, 'alice sees exactly one project');
select t.eq((select name from public.projects), 'Alice Calculator', 'alice sees her own project');
select t.eq(t.count($$select 1 from public.projects where name = 'Bob Kanban'$$), 0::bigint, 'alice cannot read bob''s project by name');
select t.eq(t.count($$select 1 from public.events where payload ->> 'text' = 'hello from bob'$$), 0::bigint, 'alice cannot read bob''s events');
select t.eq(t.count($$select 1 from public.events where payload ->> 'text' = 'hello from alice'$$), 1::bigint, 'alice can read her own events');
select t.eq(t.count($$select 1 from public.orders where text like '%kanban%'$$), 0::bigint, 'alice cannot read bob''s orders');
select t.eq(t.count($$select 1 from public.orders where text like '%tip calculator%'$$), 1::bigint, 'alice can read her own start_project order');
select t.eq(t.count($$select 1 from public.project_sessions where session_id = 'sess-bob'$$), 0::bigint, 'alice cannot read bob''s sessions');
select t.eq(t.count($$select 1 from public.project_sessions where session_id = 'sess-alice'$$), 1::bigint, 'alice can read her own sessions');
select t.eq(t.count($$select 1 from public.change_requests$$), 0::bigint, 'alice sees no change requests yet');
select t.eq(t.count($$select 1 from public.profiles$$), 1::bigint, 'alice sees only her own profile');
select t.eq((select role from public.profiles), 'member', 'alice is a member');
reset role;

select t.as_user(t.bob_id());
select t.eq((select count(*) from public.projects), 1::bigint, 'bob sees exactly one project');
select t.eq(t.count($$select 1 from public.events where payload ->> 'text' = 'hello from alice'$$), 0::bigint, 'bob cannot read alice''s events');
reset role;

-- Team owner sees all projects, events and orders
select t.as_user(t.owner_id());
select t.eq((select count(*) from public.projects), 2::bigint, 'team owner sees both projects');
select t.eq((select count(*) from public.events), 2::bigint, 'team owner sees both events');
select t.eq((select count(*) from public.orders), 2::bigint, 'team owner sees both orders');
select t.eq((select count(*) from public.profiles), 3::bigint, 'team owner sees all profiles');
reset role;

-- Not signed in (anon) sees nothing and cannot even select
select t.as_anon();
select t.throws($$select * from public.projects$$, '42501', 'anon cannot select projects');
select t.throws($$select * from public.events$$, '42501', 'anon cannot select events');
select t.throws($$select * from public.orders$$, '42501', 'anon cannot select orders');
select t.throws($$select * from public.invites$$, '42501', 'anon cannot select invites');
select t.throws($$select * from public.profiles$$, '42501', 'anon cannot select profiles');
select t.throws($$select * from platform_private.keys$$, '42501', 'anon cannot read machine keys');
reset role;

-- Signed-in users cannot touch the machine tables or the keys
select t.as_user(t.alice_id());
select t.throws($$select * from platform_private.keys$$, '42501', 'alice cannot read machine keys');
select t.throws($$insert into public.events (session_id, type) values ('sess-alice', 'fake')$$, '42501', 'alice cannot insert events');
select t.throws($$insert into public.project_sessions (session_id, project_id) select 'x', id from public.projects$$, '42501', 'alice cannot insert sessions');
select t.throws($$insert into public.projects (owner_id, name, slug) values (auth.uid(), 'direct', 'direct-insert')$$, '42501', 'alice cannot insert projects directly');
select t.throws($$update public.projects set status = 'released'$$, '42501', 'alice cannot update projects');
select t.throws($$delete from public.projects$$, '42501', 'alice cannot delete projects');
select t.throws($$update public.orders set status = 'done'$$, '42501', 'alice cannot update orders');
select t.throws($$delete from public.orders$$, '42501', 'alice cannot delete orders');
select t.throws($$update public.events set type = 'x'$$, '42501', 'alice cannot update events');
select t.throws($$insert into public.change_requests (project_id, user_id, text) select id, auth.uid(), 'x' from public.projects$$, '42501', 'alice cannot insert change requests directly');
reset role;
rollback;
