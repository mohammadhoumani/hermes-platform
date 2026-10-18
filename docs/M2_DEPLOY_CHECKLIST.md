# Deploy checklist: Vercel, Supabase, security

Use this together with `docs/M2_RUNBOOK.md`. Each box is something you can check by looking at a screen or running one command.
Nothing here needs a secret key. If you ever see a step that asks for the `service_role` key, stop: the web app does not use it.

## Vercel project settings

| Setting | Value | Why |
| --- | --- | --- |
| Project | A new project (not the old Agent Room one) | The old site keeps its address until you decide otherwise. |
| Framework Preset | Next.js | |
| Root Directory | `apps/web` | The app lives there. |
| Include source files outside of the Root Directory in the Build Step | ON | The build copies the installer files from `hermes/` into the website (`/pkg`). If this is off the build fails with "hermes/skills" not found. |
| Node.js Version | 22.x | The repository needs Node 22.12 or newer (`.nvmrc`). |
| Install Command | from `apps/web/vercel.json`: `cd ../.. && npm ci` | Installs the whole workspace from the lock file. Leave the override off. |
| Build Command | from `apps/web/vercel.json`: `npm run build` | Runs `prebuild` (makes `/pkg`) and then `next build`. |
| Output Directory | default | |
| Git branch for Production | `main` | |
| Automatically expose System Environment Variables | ON (default) | `get_v2.sh` learns its own address from `VERCEL_PROJECT_PRODUCTION_URL`. If you use another domain, set `HERMES_PLATFORM_PKG_BASE=https://your-domain/pkg` and redeploy. |

- [ ] Open `https://<YOUR-SITE>/login`: the sign-in page loads.
- [ ] Open `https://<YOUR-SITE>/projects` while signed out: you are sent to the sign-in page.
- [ ] Open `https://<YOUR-SITE>/pkg/SHA256SUMS` while signed out: it shows 13 lines of text.
- [ ] In the browser developer tools (Network tab), the response headers of `/login` include `strict-transport-security`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy`, `permissions-policy` and `cross-origin-opener-policy`.

## Environment variables

Set these in Vercel, **Settings**, **Environment Variables**.

| Name | Production | Preview | Value | Secret? |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | yes | Project URL, `https://xxxx.supabase.co` | No (it is in the browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | yes | The publishable key (`sb_publishable_...`) | No (in the browser; the database rules protect the data) |
| `HERMES_PLATFORM_PKG_BASE` | only if needed | no | `https://your-domain/pkg` when the site is on a custom domain | No |

Must **not** exist:

- [ ] `HERMES_TEST_MODE` (test mode. Production builds ignore it, but keep it out anyway).
- [ ] Any `service_role` or `secret` key. The web app never uses one (a unit test checks the source for this).
- [ ] The Hermes write key. It lives only in the database (`platform_private.keys`) and on the VM (`~/.hermes/platform/config.json`, mode 600).

## Supabase Auth settings

In the dashboard under **Authentication**.

| Where | Setting | Value |
| --- | --- | --- |
| URL Configuration | Site URL | `https://<YOUR-SITE>` |
| URL Configuration | Redirect URLs | `https://<YOUR-SITE>/auth/callback` (add `http://localhost:3000/auth/callback` only for development) |
| Sign In / Providers | Email | ON |
| Sign In / Providers | Allow new users to sign up | ON. (The database trigger refuses every email that is not invited, so this is safe.) |
| Sign In / Providers | Confirm email | ON |
| Sign In / Providers | Allow anonymous sign-ins | OFF |
| Sign In / Providers | Every other provider (Google, GitHub, phone...) | OFF |
| Sign In / Providers | Minimum password length | 8 or more (the website asks for 8) |
| Sign In / Providers | Secure email change / secure password change | ON |
| Sessions | Refresh token rotation | ON (default) |
| Sessions | JWT expiry | 3600 seconds (default) |
| Emails | SMTP Settings | Your own sender is recommended. The built-in sender allows only a few emails per hour, which is enough for the first tests but not for a team. |
| Attack Protection | CAPTCHA | Optional. Turn it on if strangers start trying the sign-up page. |
| Attack Protection | Leaked password protection | ON if your plan has it |
| Project Settings, Data API | Exposed schemas | `public` only. `platform_private` must **not** be listed. |
| Project Settings, Data API | Max rows | 1000 (default) |

- [ ] Sign up with a not-invited email: the page says "This email is not on the invite list".
- [ ] Sign up with an invited email: the confirmation email arrives and the link lands on the projects page.
- [ ] "Forgot password" email: the link opens the reset page.
- [ ] After **Remove access** on the Team page, that person's next sign-in shows "Your access has been removed".

## Database checks (run in the SQL Editor after the five migrations)

Each query has an expected result. Do not run anything that prints the value of `platform_private.keys`.

1. Row level security is on for every table the web app can reach. Expected: **no rows**.

   ```sql
   select n.nspname, c.relname
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'platform_private') and c.relkind = 'r' and not c.relrowsecurity;
   ```

2. Which functions can the public (not signed in) call? Expected: the five `platform_...` functions
   (`platform_ingest`, `platform_map_session`, `platform_set_project`, `platform_take_orders`,
   `platform_update_order`) and the old `agent_room_...` ones. Nothing else.

   ```sql
   select routine_name from information_schema.routine_privileges
   where grantee = 'anon' and routine_schema = 'public' order by 1;
   ```

3. Every new function that runs with extra rights pins its search path. Expected: **no rows**.

   ```sql
   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'platform_private') and p.prosecdef
     and p.proname not like 'agent\_room\_%'
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
   ```

4. The write key exists (this prints only a number, never the key). Expected: **1**.

   ```sql
   select count(*) from platform_private.keys where name = 'write';
   ```

5. Live updates are on for the three tables. Expected: `events`, `orders`, `projects`.

   ```sql
   select tablename from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public' order by 1;
   ```

6. The first owner exists after you signed up. Expected: one row, role `owner`.

   ```sql
   select p.role, p.disabled_at from public.profiles p
   join auth.users u on u.id = p.id where lower(u.email) = 'mhmdhoumani04@gmail.com';
   ```

7. Open **Advisors**, then **Security Advisor** in the dashboard. Expected: no red items for the tables listed above.
   Warnings about the old `agent_room` part are not new.

## RLS and security checklist

What protects the data, and how to see that it works.

| Rule | How it is enforced | How to check |
| --- | --- | --- |
| Nobody reads data without signing in | No table grant for `anon` | The PowerShell test in the runbook, Part 1, step 8 |
| A member sees only their own projects, events and orders | Row level security on every table | `supabase/tests/10_rls_isolation.sql` (runs in `npm run test:db`) |
| Owners see all projects, but only the project owner can send orders to it | Policies `projects_select`, `orders_insert` | `10_rls_isolation.sql`, `40_orders.sql` |
| Sign-up needs an invite | Trigger `platform_require_invite` on `auth.users` | `20_invites_and_signup.sql` |
| Only owners manage invites and members | Policies and `remove_member` check the role | `20_invites_and_signup.sql`, `60_member_removal.sql` |
| A removed member sees and does nothing, even with a still valid login | `platform_is_active()` in the policies, plus a ban on the login | `60_member_removal.sql` |
| Only the VM writes events, sessions and project status | Machine RPCs check the write key | `30_machine_rpcs.sql` |
| The write key is never readable by the website | `platform_private.keys` has no grants and no policies | `10_rls_isolation.sql` |
| Too many orders are refused | Trigger: 40 orders per 10 minutes per person | `40_orders.sql` |
| Agent text cannot run scripts in the browser | Markdown sanitised, links limited to http, https and mailto | `apps/web/components/__tests__/markdown.test.tsx` |
| Secrets never appear in events | The plugin hides keys and tokens before sending | `hermes/tests/test_plugin.py` |
| Test mode cannot ship | The fixture code is removed from production builds | `npm run check:bundle` after `npm run build` |

Not done yet (on purpose, to keep the first release simple):

- No Content Security Policy header. The app uses inline scripts from Next.js, so a safe policy needs per-request nonces. Planned for later.
- No rate limit on the sign-in page beyond what Supabase Auth does. Turn on CAPTCHA if needed.
- The write key is one shared secret. To rotate it, change the row in `platform_private.keys` and run the installer again with `--write-key`.
