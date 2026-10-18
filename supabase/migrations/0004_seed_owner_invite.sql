-- Hermes Platform v2: seed the first owner. The first owner signs up with this email and becomes role 'owner'.
-- Idempotent. Nothing secret here.
insert into public.invites (email, role)
values ('mhmdhoumani04@gmail.com', 'owner')
on conflict (email) do nothing;
