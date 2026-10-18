-- Owners remove (and restore) a member's access. A removed person sees and does nothing.
begin;

-- A second owner, to check that owners cannot be removed, and a third member with a finished project.
insert into public.invites (email, role) values ('dave@example.test', 'owner'), ('carol@example.test', 'member');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d4', 'dave@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'carol@example.test');
insert into auth.sessions (user_id) values (t.alice_id()), (t.alice_id()), (t.bob_id());

-- Alice has a finished project and a running one.
select t.as_user(t.alice_id());
select public.create_project('Alice Second', 'A second project');
reset role;
select public.platform_set_project('w-test', t.project_id('Alice Calculator'), '{"status":"released","phase":"release"}'::jsonb);

-- Who may call what
select t.as_user(t.alice_id());
select t.throws($$select * from public.team_members()$$, '42501', 'member cannot list the team', 'Only owners');
select t.throws(format($$select public.remove_member(%L)$$, t.bob_id()), '42501', 'member cannot remove anyone', 'Only owners');
select t.throws(format($$select public.restore_member(%L)$$, t.bob_id()), '42501', 'member cannot restore anyone', 'Only owners');
select t.throws(format($$update public.profiles set disabled_at = now() where id = %L$$, t.alice_id()), '42501', 'nobody can set disabled_at by hand (column not granted)');
reset role;
select t.as_anon();
select t.throws(format($$select public.remove_member(%L)$$, t.bob_id()), '42501', 'anon cannot call remove_member');
select t.throws($$select * from public.team_members()$$, '42501', 'anon cannot call team_members');
reset role;

-- The owner sees the team with emails
select t.as_user(t.owner_id());
select t.eq(t.count($$select 1 from public.team_members()$$), 5::bigint, 'owner sees all five people');
select t.eq((select email from public.team_members() where id = t.alice_id()), 'alice@example.test', 'team list carries the email');
select t.eq((select project_count from public.team_members() where id = t.alice_id()), 2::bigint, 'team list carries the project count');
select t.ok((select bool_and(disabled_at is null) from public.team_members()), 'nobody is removed yet');

-- Things an owner may not do
select t.throws(format($$select public.remove_member(%L)$$, t.owner_id()), '22023', 'owner cannot remove themselves', 'your own access');
select t.throws($$select public.remove_member('00000000-0000-0000-0000-0000000000d4')$$, '22023', 'owner cannot remove another owner', 'Owners cannot be removed');
select t.throws($$select public.remove_member('00000000-0000-0000-0000-00000000ffff')$$, 'P0002', 'unknown person is a clear error', 'not found');

-- Remove Alice
select public.remove_member(t.alice_id());
select public.remove_member(t.alice_id());  -- a second call changes nothing
select t.ok((select disabled_at is not null from public.team_members() where id = t.alice_id()), 'alice is marked removed');
select t.eq((select disabled_by from public.profiles where id = t.alice_id()), t.owner_id(), 'it records who removed her');
select t.eq(t.count($$select 1 from public.orders where kind = 'stop' and text = 'Access removed by a team owner.'$$), 1::bigint,
            'only her running project got a stop order (the released one did not, and the second call added none)');
select t.eq((select p.name from public.orders o join public.projects p on p.id = o.project_id where o.kind = 'stop'), 'Alice Second', 'the stop order is for the running project');
select t.eq((select o.user_id from public.orders o where o.kind = 'stop'), t.owner_id(), 'the stop order is signed by the owner who removed her');
select t.eq(t.count($$select 1 from public.projects where owner_id = $$ || quote_literal(t.alice_id())), 2::bigint, 'the owner still sees her projects (nothing is deleted)');
reset role;
select t.ok((select banned_until is not null from auth.users where id = t.alice_id()), 'her login is banned');
select t.eq((select count(*) from auth.sessions where user_id = t.alice_id()), 0::bigint, 'her sessions are gone');
select t.eq((select count(*) from auth.sessions where user_id = t.bob_id()), 1::bigint, 'other people keep their sessions');
select t.ok((select banned_until is null from auth.users where id = t.bob_id()), 'other people are not banned');

-- Alice, still holding a valid token, sees and does nothing
select t.as_user(t.alice_id());
select t.eq(t.count($$select 1 from public.projects$$), 0::bigint, 'removed: no projects');
select t.eq(t.count($$select 1 from public.events$$), 0::bigint, 'removed: no events');
select t.eq(t.count($$select 1 from public.orders$$), 0::bigint, 'removed: no orders');
select t.eq(t.count($$select 1 from public.project_sessions$$), 0::bigint, 'removed: no sessions');
select t.eq(t.count($$select 1 from public.change_requests$$), 0::bigint, 'removed: no change requests');
select t.eq(t.count($$select 1 from public.invites$$), 0::bigint, 'removed: no invites');
select t.eq(t.count($$select 1 from public.profiles$$), 1::bigint, 'removed: can still read her own profile (to show the message)');
select t.ok((select disabled_at is not null from public.profiles), 'removed: her own profile says so');
select t.throws($$select public.create_project('Sneaky', 'try to start a project')$$, '42501', 'removed: cannot start a project', 'access has been removed');
select t.throws(format($$insert into public.orders (project_id, kind, text) values (%L, 'message', 'hi')$$, (select id from public.projects limit 1)), '42501', 'removed: cannot send an order');
select t.eq(t.affected($$update public.profiles set display_name = 'still me'$$), 0::bigint, 'removed: cannot even change her display name');
select t.throws($$select * from public.team_members()$$, '42501', 'removed: cannot list the team');
reset role;

-- Alice's order insert would have been allowed before: prove the check is the removal, not a typo
select t.as_user(t.bob_id());
select t.eq(t.count($$select 1 from public.projects$$), 1::bigint, 'bob still sees his project');
insert into public.orders (project_id, kind, text) select id, 'message', 'bob still works' from public.projects;
select t.eq(t.count($$select 1 from public.orders where text = 'bob still works'$$), 1::bigint, 'bob can still send orders');
reset role;

-- Restore
select t.as_user(t.owner_id());
select public.restore_member(t.alice_id());
select t.ok((select disabled_at is null from public.team_members() where id = t.alice_id()), 'alice is active again');
select t.throws($$select public.restore_member('00000000-0000-0000-0000-00000000ffff')$$, 'P0002', 'restoring an unknown person is a clear error', 'not found');
reset role;
select t.ok((select banned_until is null from auth.users where id = t.alice_id()), 'her login ban is lifted');
select t.as_user(t.alice_id());
select t.eq(t.count($$select 1 from public.projects$$), 2::bigint, 'restored: she sees her projects again');
select t.ok(public.create_project('Alice Third', 'works again') is not null, 'restored: she can start projects again');
reset role;

-- A removed owner (set by hand, since the function refuses) loses the owner powers at once
update public.profiles set disabled_at = now() where id = '00000000-0000-0000-0000-0000000000d4';
select t.as_user('00000000-0000-0000-0000-0000000000d4');
select t.eq(t.count($$select 1 from public.projects$$), 0::bigint, 'a disabled owner sees no projects');
select t.eq(t.count($$select 1 from public.invites$$), 0::bigint, 'a disabled owner sees no invites');
select t.throws($$insert into public.invites (email, role) values ('x@example.test', 'member')$$, '42501', 'a disabled owner cannot invite');
select t.throws($$select * from public.team_members()$$, '42501', 'a disabled owner cannot list the team');
reset role;

-- Pending invites stay revocable by active owners; accepted ones stay
select t.as_user(t.owner_id());
insert into public.invites (email, role) values ('pending@example.test', 'member');
select t.eq(t.affected($$delete from public.invites where email = 'pending@example.test'$$), 1::bigint, 'a pending invite can be revoked');
select t.eq(t.affected($$delete from public.invites where email = 'alice@example.test'$$), 0::bigint, 'an accepted invite cannot be deleted (use remove access)');
reset role;
rollback;
