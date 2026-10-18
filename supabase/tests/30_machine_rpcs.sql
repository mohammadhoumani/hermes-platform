-- Machine RPCs: write key required, anon-only execute, ingest maps sub-agents to the parent's project.
begin;

-- Wrong or missing key is rejected by every RPC (28000)
select t.as_anon();
select t.throws($$select * from public.platform_take_orders('wrong', 5)$$, '28000', 'take_orders rejects a wrong key');
select t.throws($$select * from public.platform_take_orders(null, 5)$$, '28000', 'take_orders rejects a null key');
select t.throws($$select public.platform_update_order('wrong', 1, 'done')$$, '28000', 'update_order rejects a wrong key');
select t.throws($$select public.platform_set_project('wrong', gen_random_uuid(), '{}'::jsonb)$$, '28000', 'set_project rejects a wrong key');
select t.throws($$select public.platform_map_session('wrong', 's', gen_random_uuid())$$, '28000', 'map_session rejects a wrong key');
select t.throws($$select public.platform_ingest('wrong', '[]'::jsonb)$$, '28000', 'ingest rejects a wrong key');
select t.throws($$select public.platform_ingest('', '[]'::jsonb)$$, '28000', 'ingest rejects an empty key');
-- the key is not a column anyone can read
select t.throws($$select value from platform_private.keys$$, '42501', 'anon cannot read the key table');
reset role;

-- Signed-in users cannot call machine RPCs at all, even with the right key
select t.as_user(t.alice_id());
select t.throws($$select public.platform_ingest('w-test', '[]'::jsonb)$$, '42501', 'authenticated users cannot execute ingest');
select t.throws($$select * from public.platform_take_orders('w-test', 5)$$, '42501', 'authenticated users cannot execute take_orders');
select t.throws($$select public.platform_set_project('w-test', gen_random_uuid(), '{}'::jsonb)$$, '42501', 'authenticated users cannot execute set_project');
select t.throws($$select public.platform_update_order('w-test', 1, 'done')$$, '42501', 'authenticated users cannot execute update_order');
select t.throws($$select public.platform_map_session('w-test', 's', gen_random_uuid())$$, '42501', 'authenticated users cannot execute map_session');
reset role;

-- take_orders: claims queued orders once, oldest first
select t.as_anon();
select t.eq((select count(*) from public.platform_take_orders('w-test', 1)), 1::bigint, 'take_orders claims at most max_rows');
select t.eq((select count(*) from public.platform_take_orders('w-test', 10)), 1::bigint, 'second call claims the remaining order only');
select t.eq((select count(*) from public.platform_take_orders('w-test', 10)), 0::bigint, 'nothing is claimed twice');
reset role;
select t.eq((select count(*) from public.orders where status = 'taken'), 2::bigint, 'claimed orders are marked taken');

-- take_orders returns project, kind and text
insert into public.orders (project_id, user_id, kind, text)
  select id, owner_id, 'message', 'second thing' from public.projects where name = 'Alice Calculator';
select t.as_anon();
select t.eq((select kind || '/' || text from public.platform_take_orders('w-test', 5)), 'message/second thing', 'take_orders returns kind and text');
reset role;

-- update_order
select t.as_anon();
select public.platform_update_order('w-test', t.first_order(), 'running', 'working on it', 'run-1');
reset role;
select t.eq((select status || '|' || note || '|' || run_id from public.orders order by id limit 1), 'running|working on it|run-1', 'update_order sets status, note and run id');
select t.as_anon();
select t.throws($$select public.platform_update_order('w-test', t.first_order(), 'exploded')$$, '22023', 'update_order rejects unknown status');
select t.throws($$select public.platform_update_order('w-test', 999999, 'done')$$, 'P0002', 'update_order reports a missing order');
reset role;

-- set_project: whitelist
select t.as_anon();
select public.platform_set_project('w-test', t.project_id('Alice Calculator'),
  '{"status":"awaiting_brd_approval","phase":"discovery","repo_url":"https://example.test/alice/calc","brd_markdown":"# BRD\nBR-01"}'::jsonb);
reset role;
select t.eq((select status || '|' || phase || '|' || repo_url from public.projects where name = 'Alice Calculator'),
  'awaiting_brd_approval|discovery|https://example.test/alice/calc', 'set_project updates the whitelisted fields');
select t.ok((select brd_markdown like '# BRD%' from public.projects where name = 'Alice Calculator'), 'set_project stores the BRD');
select t.ok((select updated_at > created_at from public.projects where name = 'Alice Calculator'), 'projects.updated_at moves forward');
select t.as_anon();
select t.throws($$select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"owner_id":"00000000-0000-0000-0000-000000000001"}'::jsonb)$$, '22023', 'set_project refuses owner_id', 'owner_id');
select t.throws($$select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"slug":"x"}'::jsonb)$$, '22023', 'set_project refuses slug');
select t.throws($$select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"status":"banana"}'::jsonb)$$, '23514', 'set_project refuses an unknown status');
select t.throws($$select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"phase":"nope"}'::jsonb)$$, '23514', 'set_project refuses an unknown phase');
select t.throws($$select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"staging_url":"javascript:alert(1)"}'::jsonb)$$, '23514', 'set_project refuses non-http URLs');
select t.throws($$select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '[]'::jsonb)$$, '22023', 'set_project needs a JSON object');
select t.throws($$select public.platform_set_project('w-test', gen_random_uuid(), '{"status":"qa"}'::jsonb)$$, 'P0002', 'set_project reports a missing project');
select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"repo_url":null}'::jsonb);
reset role;
select t.ok((select repo_url is null from public.projects where name = 'Alice Calculator'), 'set_project can clear a field with null');

-- map_session + ingest: sub-agents inherit the parent's project
select t.as_anon();
select public.platform_map_session('w-test', 'main-1', t.project_id('Bob Kanban'), null, 'orchestrator');
select t.eq(public.platform_ingest('w-test', '[
  {"type":"turn_start","sid":"main-1","text":"build it"},
  {"type":"sub_start","parent":"main-1","child":"coder-a","role":"leaf","goal":"Task 1 on feature/x"},
  {"type":"tool_start","sid":"coder-a","tool":"terminal","summary":"git status"},
  {"type":"sub_start","parent":"coder-a","child":"helper-1","goal":"look something up"},
  {"type":"tool_start","sid":"helper-1","tool":"web_search"},
  {"type":"sub_stop","parent":"main-1","child":"coder-a","status":"completed"},
  {"type":"tool_start","sid":"unknown-session","tool":"terminal"},
  {"nonsense":true},
  "not an object",
  {"type":"","sid":"main-1"}
]'::jsonb), 7, 'ingest stores valid events and skips junk');
reset role;
select t.eq((select count(*) from public.events where payload ->> 'sid' = 'coder-a' and project_id = t.project_id('Bob Kanban')), 1::bigint, 'sub-agent event is attached to the parent''s project');
select t.eq((select count(*) from public.events where payload ->> 'sid' = 'helper-1' and project_id = t.project_id('Bob Kanban')), 1::bigint, 'grandchild event is attached too');
select t.eq((select count(*) from public.events where type in ('sub_start', 'sub_stop') and project_id = t.project_id('Bob Kanban')), 3::bigint, 'sub_start and sub_stop events are attached');
select t.eq((select project_id from public.project_sessions where session_id = 'coder-a'), t.project_id('Bob Kanban'), 'child session is mapped to the parent''s project');
select t.eq((select parent_session_id from public.project_sessions where session_id = 'helper-1'), 'coder-a', 'child session remembers its parent');
select t.ok((select project_id is null from public.events where payload ->> 'sid' = 'unknown-session'), 'events of unknown sessions are kept without a project');
select t.eq((select session_id from public.events where type = 'sub_start' and payload ->> 'child' = 'coder-a'), 'coder-a', 'sub_start is filed under the child session');

-- ... and they stay private: Alice cannot see Bob's sub-agent events, Bob can
select t.as_user(t.alice_id());
select t.eq(t.count($$select 1 from public.events where payload ->> 'sid' in ('coder-a', 'helper-1', 'main-1')$$), 0::bigint, 'alice cannot see bob''s sub-agent events');
reset role;
select t.as_user(t.bob_id());
select t.eq(t.count($$select 1 from public.events where payload ->> 'sid' in ('coder-a', 'helper-1', 'main-1')$$), 3::bigint, 'bob sees his sub-agent events');
select t.eq(t.count($$select 1 from public.events where payload ->> 'sid' = 'unknown-session'$$), 0::bigint, 'bob cannot see unmapped events');
reset role;

-- Late mapping: events that arrived before the bridge mapped the session are attached afterwards,
-- including sub-agents whose parent was unknown at the time
select t.as_anon();
select public.platform_ingest('w-test', '[
  {"type":"turn_start","sid":"late-main","text":"early event"},
  {"type":"sub_start","parent":"late-main","child":"late-child","goal":"x"},
  {"type":"sub_start","parent":"late-child","child":"late-grandchild","goal":"y"},
  {"type":"tool_start","sid":"late-grandchild","tool":"terminal"},
  {"type":"tool_start","sid":"late-child","tool":"terminal"}
]'::jsonb);
reset role;
select t.eq((select count(*) from public.events where project_id is null and session_id like 'late-%'), 5::bigint, 'early events wait without a project');
select t.as_anon();
select public.platform_map_session('w-test', 'late-main', t.project_id('Alice Calculator'), null, 'orchestrator');
reset role;
select t.eq((select count(*) from public.events where project_id = t.project_id('Alice Calculator') and session_id like 'late-%'), 5::bigint, 'late mapping attaches the earlier events, children and grandchildren');
select t.eq((select count(*) from public.project_sessions where session_id in ('late-child', 'late-grandchild')), 2::bigint, 'late mapping also maps the sub-agents');

-- limits
select t.as_anon();
select t.throws($$select public.platform_ingest('w-test', '{}'::jsonb)$$, '22023', 'ingest needs an array');
select t.throws($$select public.platform_ingest('w-test', (select jsonb_agg(jsonb_build_object('type', 'x')) from generate_series(1, 501)))$$, '22023', 'ingest refuses more than 500 events');
select t.eq(public.platform_ingest('w-test', jsonb_build_array(jsonb_build_object('type', 'big', 'text', repeat('x', 20000)))), 0, 'ingest skips oversized events');
select t.throws($$select public.platform_map_session('w-test', '', gen_random_uuid())$$, '22023', 'map_session needs a session id');
select t.throws($$select public.platform_map_session('w-test', 'zzz', gen_random_uuid())$$, '23503', 'map_session needs an existing project');
reset role;
rollback;
