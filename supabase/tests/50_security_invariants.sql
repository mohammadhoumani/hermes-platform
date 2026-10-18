-- Guards against regressions: every table has RLS on, and only the intended functions are callable by anon.
begin;
select t.eq((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname in ('public', 'platform_private') and c.relkind = 'r' and not c.relrowsecurity), 0::bigint,
            'row level security is enabled on every table in public and platform_private');
select t.eq((select string_agg(routine_name, ',' order by routine_name) from information_schema.routine_privileges
              where grantee = 'anon' and routine_schema = 'public'),
            'platform_ingest,platform_map_session,platform_set_project,platform_take_orders,platform_update_order',
            'anon can execute exactly the five machine RPCs');
select t.eq((select count(*) from information_schema.routine_privileges
              where grantee = 'PUBLIC' and routine_schema in ('public', 'platform_private')), 0::bigint,
            'no function in public or platform_private is executable by PUBLIC');
select t.eq((select count(*) from information_schema.routine_privileges
              where grantee = 'authenticated' and routine_schema = 'public' and routine_name like 'platform\_%' and routine_name not in ('platform_is_owner', 'platform_is_active')), 0::bigint,
            'signed-in users cannot execute any machine RPC');
select t.eq((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'platform_private') and p.prosecdef
                and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')), 0::bigint,
            'every SECURITY DEFINER function pins its search_path');
select t.eq((select count(*) from pg_trigger where tgname in ('platform_require_invite', 'platform_create_profile') and not tgisinternal), 2::bigint,
            'both sign-up triggers exist on auth.users');
rollback;
