# Milestone 1 report

Milestone 1 (tasks T1 to T8 in `docs/IMPLEMENTATION_PLAN.md`) is finished. Everything ran inside the
container. No live service was contacted: no Supabase project, no Vercel, no GitHub push, no Devin,
no VM. No real keys exist anywhere in the repository (tests use fake values such as `w-test`).
`legacy/` was not changed.

## What was built, by task

### T1. Monorepo scaffold

- npm workspaces (`apps/*`), `.nvmrc` (Node 22), `.editorconfig`, a README that explains the layout.
- Every dependency is pinned to an exact version (no `^`, no `~`).
- `apps/web`: Next.js 16.4.2 (App Router, Turbopack), React 19.3.1, Tailwind CSS 4.3.3, Motion 14.3.0,
  TypeScript 6.0.3.
- Design tokens in `apps/web/styles/tokens.css`: the five brand colours, a 50 to 900 scale for each, and
  semantic tokens for light and dark themes. Dark mode follows the system and can be switched with a
  toggle stored in the `hermes-theme` cookie.
- `apps/web/lib/contrast.test.ts` reads the token file and checks every text and background pair for
  WCAG AA (4.5:1 for text, 3:1 for borders, focus rings and progress marks), in both themes.

### T2. Supabase migrations (`supabase/migrations/`)

- `0001_platform.sql`: tables (`profiles`, `invites`, `projects`, `project_sessions`, `orders`, `events`,
  `change_requests`, `platform_private.keys`), indexes, the invite-only trigger on `auth.users`, the
  order rate-limit trigger, the Realtime publication (only if it exists).
- `0002_rls.sql`: row level security on every table and column-level grants.
- `0003_rpcs.sql`: `create_project` for signed-in people and the five machine RPCs
  (`platform_take_orders`, `platform_update_order`, `platform_set_project`, `platform_map_session`,
  `platform_ingest`), all checking the write key.
- `0004_seed_owner_invite.sql`: invites `mhmdhoumani04@gmail.com` as the first owner.
- All of it can run twice without error. No key values are in the files.

### T3. Database tests (`supabase/tests/`)

- `supabase/tests/run.sh` starts a throwaway PostgreSQL 16 cluster, applies a small stub of the Supabase
  `auth` schema, applies the migrations twice, runs the SQL test files, and stops the cluster.
- 159 checks cover: user A cannot see user B's project, orders or events; owners can see the team's
  projects; a non-invited email cannot sign up and an invited one gets the right role (case does not
  matter); only owners manage invites; wrong write keys are rejected by every machine RPC;
  `platform_ingest` gives a sub-agent's events to the parent's project, and back-fills events that
  arrived before the session was mapped; unknown order kinds, empty or oversized text and the 41st order
  in 10 minutes are rejected; security invariants (RLS on, only the five machine RPCs are open to `anon`,
  every `SECURITY DEFINER` function pins its `search_path`).

### T4. Web app: shell, theme, auth

- Pages: `/login`, `/signup` (says "invite only", and turns the database's invite error into plain
  words), `/forgot-password`, `/reset-password`, and the route `/auth/callback`.
- `apps/web/proxy.ts` protects every route except the auth pages and static files, and redirects to
  `/login?next=...`. The `next` value is checked so it can only point inside the site.
  Signed-in people who open `/login` are sent to `/projects`.
- `/settings/team` (owners only): invite by email, see the list, remove a pending invite. Members see a
  plain "only owners can manage the team" message.
- Motion: pages fade in (CSS), list rows slide in when they are added after the page loaded, buttons give
  press feedback. All of it is off under `prefers-reduced-motion`.
- Plain-English messages for every state: loading, empty, error. Errors never show raw database text.

### T5. Projects and the project room

- `/projects`: cards with a status chip (plain words, colour from tokens), "New project", an empty state,
  and "Started by you" or "Started by a teammate".
- `/projects/new`: an idea box and an optional name. With no name, one is made from the first words of
  the idea. It calls the `create_project` RPC, then opens the room.
- `/projects/[id]`: the room.
  - Conversation with the agents and a reply box (`message` orders).
  - BRD panel: sanitised Markdown, with **Approve BRD** (the only approval button in the app) and
    **Ask for changes**.
  - Six-phase progress rail, activity feed, "Who is talking" 2D map, lanes for Coder 1, Coder 2 and Devin,
    release card with the repository, staging and live links, a change request box once released,
    Stop and Resume (with a confirm step for Stop).
  - Realtime for `events`, `orders` and `projects`, with a catch-up fetch when the connection comes back,
    polling while it is down, and a connection badge ("Updating live", "Reconnecting...", "Offline").
  - On a phone the BRD moves to the top while it waits for approval. No sideways scrolling at 360 px.
- Agent text is untrusted. Markdown goes through `skipHtml` and `rehype-sanitize`; only `http`, `https`
  and `mailto` links survive; images are replaced by their alt text.

### T6. Event model library (`apps/web/lib/agent-events/`)

- Pure TypeScript port of the legacy site's logic. Types for every plugin event, the new roster
  (Orchestrator, BA, Architect, Coder 1, Coder 2, Devin, Reviewer, QA, Release, GitHub), the skill to phase
  map for the eight new skills, and `applyEvent` / `replay` that produce one `ViewState` (phases, gate,
  agents, links, lanes, feed, says, stats, urls).
- JSON fixtures: a full calculator run, a discovery run that waits for the BRD, and a change request on a
  released project. `scripts/make-fixtures.mjs` regenerates them.

### T7. Skill drafts (`hermes/skills/`)

- `sdlc-orchestrator`, `sdlc-ba`, `sdlc-architect`, `sdlc-development`, `sdlc-review`, `sdlc-qa`,
  `sdlc-release`, `sdlc-change-request`, each a `SKILL.md` with YAML front matter (`name`, `description`).
- No chat-app wording. All human contact is "the user replies on the website".
- `hermes/skills/validate.mjs` checks the front matter of every skill (valid YAML, only `name` and
  `description`, name equals the folder name, description length, headings, banned words, secret-looking
  text) and `validate.test.mjs` tests the checker. The markdown lint pass covers the skills too.

### T8. This report and the screenshots

- Screenshots are in `docs/screenshots/` (see below).

## Exact commands

Run from the repository root. Node 22 is needed (`.nvmrc`).

```bash
npm install                    # install everything
npm run build                  # production build of apps/web
npm run lint                   # ESLint for apps/web, then markdownlint for the docs and skills
npm test                       # unit tests (Vitest)
npm run test:skills            # skill front matter check and its tests
npm run test:db                # SQL tests on a throwaway PostgreSQL 16 (needs PostgreSQL 16 installed)
npm run test:e2e               # Playwright tests (starts its own dev server on port 3100)
npm run screenshots            # takes the screenshots into docs/screenshots/
npm run -w apps/web check:bundle   # after a build: proves no test-mode code is in the production build
npm run test:all               # lint, unit, SQL, skills, build and Playwright together
```

To look at the site by hand without any backend, use test mode (built-in demo data, no database):

```bash
cd apps/web
cp .env.example .env.local     # keep the fake URL and key, or leave them empty
HERMES_TEST_MODE=1 npx next dev --port 3000
# then set a cookie named hermes-test-user to "owner" or "member" in the browser, and open /projects
```

Test mode only works when `NODE_ENV` is not `production`. `next build` and `next start` always set it, so
test mode cannot be switched on in a deployed build.

## Test results

All of these were run again from a fresh `git clone` of the final commit, after `npm install`.

```text
npm run build            ✓ Compiled successfully; 11 routes (/, /login, /signup, /forgot-password,
                         /reset-password, /auth/callback, /projects, /projects/new, /projects/[id],
                         /settings/team, /_not-found) plus the proxy
npm run check:bundle     ok: scanned 257 files in .next, no fixture code or data found.
npm run lint             eslint: no problems.  markdownlint: Summary: 0 issues in 0 files
npm test                 Test Files  10 passed (10)
                              Tests  223 passed (223)
npm run test:skills      ok: 8 skills have valid front matter and no banned wording.
                         # tests 8   # pass 8   # fail 0
npm run test:db          SQL TESTS: 159 passed, 0 failed (migrations applied twice without error)
npm run test:e2e         37 passed (1.9m)
```

What the 223 unit tests cover: contrast (every token pair, both themes, plus the palette itself), the
event reducer and replays of the fixtures, the room reducer and the conversation and rail builders, the
route guard (redirects, `?next=` safety, static file paths), error message mapping, Markdown safety,
form behaviour (login, signup, new project), UI parts and the test-mode switch.

What the 37 Playwright tests cover: login validation in plain English with no console errors, redirects
to `/login?next=`, "invite only" on sign up, the owner-only team page (invite and remove), sign out,
the project list, new project, the room (Approve BRD is the only approval control; the booby-trapped BRD
does nothing; approve, message, stop, resume, release card, change request), axe accessibility checks
(WCAG 2 A and AA, 2.1 AA, 2.2 AA) for login, projects and three room states in light and dark, no
sideways scroll at 360 px on every page, and reduced motion.

## Screenshots

In `docs/screenshots/`, taken with Playwright against test mode (demo data), at 1280 px (desktop) and
390 px (phone), light and dark. File names are `<page>-<theme>-<size>.png`:

- `login-*`
- `projects-*`
- `project-room-waiting-*` (project room while the BRD waits for approval)
- `project-room-building-*` (project room while coders work)

The demo timestamps are fixed in the past, so cards say "1 year ago". That is the data, not a bug.

## Decisions I made

1. **`proxy.ts`, not `middleware.ts`.** Next.js 16 renamed the middleware file. The plan says "middleware";
   the behaviour is the same.
2. **Exact versions of the newest releases at the time**, including TypeScript 6.0.3 and jsdom 29.1.1
   (jsdom is also listed at the repository root because Vitest looks for it there; without that a fresh
   `npm install` could not find it).
3. **`create_project` RPC and `change_requests.order_id`.** The plan says `/projects/new` "inserts project and
   `start_project` order". One RPC does both in one step, so a project can never exist without its
   first order. `change_requests.order_id` lets the machine update a change request when its order changes.
4. **Test mode.** The plan asks for a local or mocked backend. I added a `Backend` interface
   (`apps/web/lib/backend/`) with a Supabase implementation and a fixture implementation. Test mode is
   decided on the server only, needs `HERMES_TEST_MODE=1`, and needs `NODE_ENV` not to be `production`.
   A cookie `hermes-test-user` stands in for a session. The check script proves the fixture code is not
   in the production build. Playwright tests run against `next dev` in this mode.
5. **Sign-up error text.** When the invite trigger rejects an email, Supabase returns
   "Database error saving new user". The sign up form maps this to a plain message about invitations.
   An auth hook ("before user created") is an alternative for M2; it would give a cleaner error code.
6. **One approval button.** "Ask for changes" sends a `request_brd_changes` order and does not approve
   anything. The Approve BRD button is the only control that sends `approve_brd`.
7. **Fade in with CSS, rows with Motion.** Page fades are CSS, so the server HTML is visible without
   JavaScript. Press feedback on buttons is CSS too. Motion is used for rows that appear after load.
   Under reduced motion none of it runs.
8. **Not-found pages return HTTP 200.** The project page streams, so Next.js has sent the status before the
   page can decide the project does not exist. Next.js adds a `noindex` tag instead. It looks right to
   people; a monitoring tool that only reads status codes would not see a 404.
9. **Dates in fixtures** are fixed (October 2025), so they never change between runs.
10. **Plugin skill-name pattern.** The plugin's `_SKILL_RE` still matches the old names
    (`sdlc-project`, `sdlc-requirements`, ...). I left the plugin alone in M1 and list the change for M2.
11. **`npm audit`.** Production dependencies: 0 vulnerabilities (`npm audit --omit=dev`). The 11 findings
    (3 low, 1 moderate, 7 high) are all in the markdown lint tooling (for example `braces` and `smol-toml`
    through `markdownlint-cli2`), which only runs on a developer machine. I did not force-upgrade.
12. **Playwright browser.** The Playwright version needs a newer Chromium than the one installed. I did
    not run `playwright install`. `playwright.base.ts` uses `/opt/pw-browsers/chromium` (override with
    `HERMES_CHROMIUM`) when it exists, and Playwright's own browser otherwise.
13. **Next.js writes `apps/web/AGENTS.md`** each time `next dev` starts. I committed it so the tree stays clean.
14. **One convention for approval in the skills.** The BA ends its turn asking the user to
    press Approve BRD; nobody else asks for approval. After it, the orchestrator never asks again.
    Devin tasks always carry `max_acu_limit` (small default if none is given) and fall back to a Claude coder.

## What is not verified

- **Nothing was run against a real Supabase project.** The SQL is tested on a real PostgreSQL 16 with a
  stub `auth` schema, not on Supabase itself. Supabase-specific behaviour (the real `auth` schema, the
  Realtime service, email sending, the redirect URLs, `getUser()`) is untested. `lib/backend/supabase.ts`,
  `/auth/callback` and the Realtime subscription code are type-checked and only exercised through the
  mocked form tests, not end to end.
- Realtime reconnect handling is tested at the reducer level and through the fixture backend. A real
  dropped websocket has not been tried.
- The agent map and lanes were checked by screenshots and axe, not by a person using a screen reader.
- Skills are drafts. They were checked for format only. They have not been run by Hermes, and the
  bridge and plugin do not know about them yet.
- Safari and Firefox were not tested; only Chromium.

## What the operator must do in M2

1. Read the migrations once more, then apply them to the live Supabase project (the plan's M2 step 1).
   Use a branch or a scratch project first if possible. The legacy `agent_room` schema stays as it is.
2. Insert the write key into `platform_private.keys` (`name = 'write'`). Choose a long random value and
   keep it only on the VM and in Supabase. The migrations deliberately do not create it.
3. In Supabase Auth: turn off public sign up if you want a second lock (the trigger already refuses
   uninvited emails), set the Site URL and the redirect URL for `/auth/callback`, and decide on email
   confirmation. Check that the "Database error saving new user" mapping works with the real service.
4. Create the Vercel project for `apps/web`, set `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (never the service role key), and make sure `HERMES_TEST_MODE` is not set.
5. Sign in as the seeded owner (`mhmdhoumani04@gmail.com`) and invite the team on `/settings/team`.
6. Bridge v2 and plugin v2 (plan M2 steps 2 and 3): read orders with `platform_take_orders`, map sessions,
   set phase and status from skill events, capture `docs/BRD.md` into `projects.brd_markdown`, send events to
   `platform_ingest`, and update the plugin's skill-name pattern to the eight new skill names.
7. Installer v2 (step 4): copy `hermes/skills/*` to `~/.hermes/skills/`, turn off the old chat integration
   and remove its token (back it up first), turn on the API server.
8. Decide the real values the skills mention loosely: the GitHub account and template repository name, the
   Devin ACU limit, and the repository protection script that will live in `template/` (M3).
9. Run the calculator demo from the new site with one approval (plan M2 step 6) and tell me what you see.
