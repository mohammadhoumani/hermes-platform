-- Tiny test framework (schema "t"). Every check prints one line: "ok   - name" or "FAIL - name  detail".
-- run.sh counts those lines (tests run in rolled-back transactions, so nothing is stored in tables).
create schema if not exists t;
grant usage on schema t to public;

create or replace function t.ok(cond boolean, name text, detail text default null) returns void
language plpgsql as $$
begin
  if coalesce(cond, false) then raise notice 'ok   - %', name;
  else raise notice 'FAIL - %  %', name, coalesce(detail, ''); end if;
end $$;

create or replace function t.eq(actual anyelement, expected anyelement, name text) returns void
language plpgsql as $$
begin
  perform t.ok(actual is not distinct from expected, name, format('expected %L, got %L', expected, actual));
end $$;

-- Run a statement and expect it to fail with this SQLSTATE (and, if given, a message containing a text).
-- The statement runs inside a sub-transaction, so a failing statement leaves nothing behind.
create or replace function t.throws(sql text, expected_state text, name text, msg_like text default null) returns void
language plpgsql as $$
declare st text; msg text;
begin
  begin
    execute sql;
    perform t.ok(false, name, 'expected an error, but the statement succeeded');
    return;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
  end;
  perform t.ok(st = expected_state and (msg_like is null or msg ilike '%' || msg_like || '%'), name,
               format('expected %s%s, got %s: %s', expected_state, coalesce(' / ' || msg_like, ''), st, msg));
end $$;

-- Run a query returning one bigint/int and compare. Convenience for row counts.
create or replace function t.count(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || sql || ') q' into n; return n; end $$;

-- Run an INSERT/UPDATE/DELETE and return how many rows it touched.
create or replace function t.affected(sql text) returns bigint
language plpgsql as $$
declare n bigint;
begin execute sql; get diagnostics n = row_count; return n; end $$;

-- Act as a signed-in user (role authenticated + JWT sub claim); stay in that role until "reset role".
create or replace function t.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function t.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;

-- Fixed ids so tests can refer to people.
create or replace function t.owner_id() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000a0'::uuid $$;
create or replace function t.alice_id() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000a1'::uuid $$;
create or replace function t.bob_id()   returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000b2'::uuid $$;

