-- Invite-only sign-up, profile creation, and who may manage invites.
begin;

-- Uninvited email is rejected, with a plain message
select t.throws($$insert into auth.users (email) values ('stranger@example.test')$$, '42501',
  'sign-up with a non-invited email is rejected', 'has not been invited');
select t.eq(t.count($$select 1 from auth.users where email = 'stranger@example.test'$$), 0::bigint, 'rejected sign-up leaves no user behind');
select t.throws($$insert into auth.users (email) values (null)$$, '42501', 'sign-up without an email is rejected');

-- Invited email creates a profile with the invited role; invite is stamped accepted
insert into public.invites (email, role) values ('Carol@Example.Test', 'member'), ('dave@example.test', 'owner');
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000c3', 'carol@example.test', '{"display_name":"Carol C"}'),
  ('00000000-0000-0000-0000-0000000000d4', 'dave@example.test', '{}');
select t.eq((select role from public.profiles where id = '00000000-0000-0000-0000-0000000000c3'), 'member', 'invited member gets role member (invite matched case-insensitively)');
select t.eq((select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000c3'), 'Carol C', 'display name comes from the sign-up form');
select t.eq((select role from public.profiles where id = '00000000-0000-0000-0000-0000000000d4'), 'owner', 'invited owner gets role owner');
select t.eq((select display_name from public.profiles where id = '00000000-0000-0000-0000-0000000000d4'), 'dave', 'display name falls back to the email name');
select t.ok((select accepted_at is not null from public.invites where email = 'carol@example.test'), 'invite is stamped as accepted');
select t.ok((select accepted_at is not null from public.invites where email = 'bob@example.test'), 'fixture invites were stamped accepted too');

-- The seeded first owner
select t.eq((select role from public.invites where email = 'mhmdhoumani04@gmail.com'), 'owner', 'seed: first owner invite has role owner');
select t.eq((select role from public.profiles where id = t.owner_id()), 'owner', 'seed: first owner profile has role owner');

-- Invite rules
select t.as_user(t.alice_id());
select t.eq(t.count($$select 1 from public.invites$$), 0::bigint, 'member cannot see any invites');
select t.throws($$insert into public.invites (email, role) values ('x@example.test', 'member')$$, '42501', 'member cannot create an invite');
select t.eq(t.affected($$delete from public.invites$$), 0::bigint, 'member cannot delete invites');
select t.throws($$update public.profiles set role = 'owner' where id = auth.uid()$$, '42501', 'member cannot make themselves owner');
update public.profiles set display_name = 'Alice Renamed' where id = auth.uid();
select t.eq((select display_name from public.profiles where id = auth.uid()), 'Alice Renamed', 'member can change their own display name');
select t.eq(t.affected($$update public.profiles set display_name = 'hacked' where id <> auth.uid()$$), 0::bigint, 'member cannot rename other people');
reset role;

select t.as_user(t.owner_id());
select t.eq(t.count($$select 1 from public.invites$$), 5::bigint, 'owner sees all invites');
insert into public.invites (email, role) values ('erin@example.test', 'member');
select t.eq((select invited_by from public.invites where email = 'erin@example.test'), t.owner_id(), 'invite records who invited');
select t.throws($$insert into public.invites (email, role) values ('erin@example.test', 'member')$$, '23505', 'duplicate invite (any letter case) is rejected');
select t.throws($$insert into public.invites (email, role) values ('ERIN@example.test', 'member')$$, '23505', 'duplicate invite in other letter case is rejected');
select t.throws($$insert into public.invites (email, role) values ('not-an-email', 'member')$$, '23514', 'invalid email is rejected');
select t.throws($$insert into public.invites (email, role) values ('f@example.test', 'admin')$$, '23514', 'unknown invite role is rejected');
select t.throws($$insert into public.invites (email, role, invited_by) values ('g@example.test', 'member', auth.uid())$$, '42501', 'owner cannot set invited_by by hand (column not granted)');
select t.eq(t.affected($$delete from public.invites where email = 'erin@example.test'$$), 1::bigint, 'owner can revoke a pending invite');
select t.eq(t.affected($$delete from public.invites where email = 'alice@example.test'$$), 0::bigint, 'owner cannot delete an invite that was already accepted');
select t.throws($$update public.invites set role = 'owner'$$, '42501', 'invites cannot be edited, only created or revoked');
reset role;

-- A revoked invite means sign-up is rejected again
select t.throws($$insert into auth.users (email) values ('erin@example.test')$$, '42501', 'revoked invite cannot sign up');
rollback;
