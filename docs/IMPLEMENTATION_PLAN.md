# Hermes Platform v2: Implementation Plan

Owner: Mohammad Houmani · Written 2026-10-18 · Source spec: the "major scope and architectural pivot" brief
(web-only, invite-only auth, palette, 3D office, 6-phase autonomous SDLC with one BRD gate, Claude + Devin).

## 0. Decisions (settled)

| Topic | Decision |
| --- | --- |
| Who can use it | **Invite-only.** An owner invites team members by email. No public signup. |
| Models | **Claude** (Claude Pro subscription, through Hermes) runs Orchestrator, BA, Architect, 2 coders, Reviewer, QA. **Devin** (Devin Pro, via Devin MCP) is coder #3, one task per project, with an ACU cap. |
| Human gates | **Exactly one:** the user approves the BRD in the web UI. Everything after is autonomous. |
| Telegram | Removed. Web is the only entry point. |
| Generated apps hosting | **Vercel**: staging (preview) deploy after each merge to main, production after QA sign-off. |
| 3D office | Built inside our web app with React Three Fiber, driven by our event stream. Reuse models/ideas from Hermes3D (MIT, credit it). 2D fallback. |
| Web stack | Next.js (App Router, TypeScript) on Vercel, Supabase (Auth + Postgres + Realtime), Tailwind CSS, Motion (Framer Motion) for animation, React Three Fiber + drei for 3D. |
| Capacity | One project runs at a time (queue the rest). Max 2 Claude coders in parallel. Pause and auto-resume on Claude usage-limit errors. |

## 1. Design tokens (from docs/palette-reference.png)

| Token | Hex | Meaning in the brand sheet | Use |
| --- | --- | --- | --- |
| `steel-gray` | `#24213B` | Reliability & robustness | Primary text on light; app background in dark mode; header/nav |
| `caribbean-green` | `#00CDAB` | Growth & sustenance | Primary brand: buttons, active states, progress, "agent working" |
| `texas-rose` | `#FFB64D` | Excitement & enthusiasm | Highlights, the BRD approval gate, "needs you" states, warnings |
| `wafer` | `#E4D7CC` | Empathy & humility | Soft surfaces, cards on Snow, borders, office floor/furniture tone |
| `snow` | `#FFFFFF` | Clarity & simplicity | Light-mode background, text on dark |

Accessibility rules (WCAG AA, must be unit-tested in `apps/web/lib/contrast.test.ts`):
- `caribbean-green` on `snow` is only ~2:1, so **never use green text on white**. Green is a fill; text on green
  buttons is `steel-gray`. For green text/links on light backgrounds derive a darker shade (`green-700`) that reaches ≥ 4.5:1.
- `texas-rose` on `snow` also fails for text; use it as a fill with `steel-gray` text.
- Dark mode: background `steel-gray`, text `snow`/`wafer`, green and rose text are fine (≥ 4.5:1).
- Derive a small tonal scale per color (50…900) in `apps/web/styles/tokens.css`; status colors: success = green, attention = rose, error = a red derived to pass AA on both themes.

## 2. Target repo layout (this repo: hermes-platform)

```
apps/web/              Next.js app (the new platform UI)
hermes/plugin/         agent-room Hermes plugin (event stream) — existing, extend
hermes/bridge/         bridge service (web orders -> Hermes API) — existing, extend
hermes/skills/         SDLC skills (SKILL.md per skill) — new pipeline
hermes/install/        installer (get.sh, install.sh) — VM setup incl. Telegram removal
hermes/tools/          simulate_run.py etc.
hermes/tests/          mocks for Supabase and Hermes API used in tests
supabase/migrations/   SQL migrations for the new data model (versioned, idempotent)
template/              project template repo content (CI workflows, Playwright, CONTRACT skeleton)
legacy/agent-room/     the current single-file site, setup page, old SQL — reference only, do not ship
docs/                  this plan, decisions, runbook
```

## 3. Data model (Supabase, schema `public` with RLS; machine-only RPCs keep the write-key pattern)

Tables:
- `profiles` (id uuid pk = auth.users.id, display_name, role `owner|member`, created_at)
- `invites` (email citext pk, role, invited_by uuid, created_at, accepted_at)
- `projects` (id uuid pk, owner_id uuid, name, slug unique, status, phase, repo_url, staging_url, production_url,
  brd_markdown, brd_approved_at, created_at, updated_at).
  `status`: `queued|discovery|awaiting_brd_approval|architecture|development|review|qa|releasing|released|paused|failed|stopped`
- `project_sessions` (session_id text pk, project_id uuid, parent_session_id text null, role text, created_at) — maps Hermes
  session ids (main + sub-agents + Devin sessions) to a project.
- `orders` (id bigint pk, project_id uuid, user_id uuid, kind, text, status, note, run_id, created_at, updated_at).
  `kind`: `start_project|message|approve_brd|request_brd_changes|change_request|stop|resume`
  `status`: `queued|taken|running|waiting|done|failed`
- `events` (id bigint pk, project_id uuid null, session_id text, type text, payload jsonb, created_at) — indexed (project_id, id).
- `change_requests` (id, project_id, user_id, text, status, created_at)
- `machine_keys` in a private schema (`platform_private.keys`: name, value) — the bridge's write key.

RLS (must be tested, see M1-T3):
- A user sees a project only if they own it (owner_id = auth.uid()). Owners with role `owner` may see all projects of the team
  (`profiles.role = 'owner'`). Members see their own.
- `orders`: insert only for your own project, only allowed kinds, length ≤ 4000, rate limit (≤ 40 per 10 min per user).
- `events`, `project_sessions`: select only via project ownership; no client inserts.
- `invites`: only `owner` role can insert/select/delete.
- Invite-only enforcement: a `BEFORE INSERT` trigger on `auth.users` (or a Supabase "before user created" auth hook) rejects any
  email not present in `invites`; on success it creates the `profiles` row with the invited role and stamps `accepted_at`.
  The first owner (mhmdhoumani04@gmail.com) is seeded by migration as an invite with role `owner`.

Machine RPCs (SECURITY DEFINER, `search_path = ''`, require the write key; granted to `anon` only):
- `platform_take_orders(write_key, max_rows)` → claims queued orders (FOR UPDATE SKIP LOCKED), returns project_id, kind, text.
- `platform_update_order(write_key, order_id, status, note, run_id)`
- `platform_set_project(write_key, project_id, fields jsonb)` → status/phase/urls/brd_markdown (whitelisted keys only).
- `platform_map_session(write_key, session_id, project_id, parent_session_id, role)`
- `platform_ingest(write_key, events jsonb)` → each event's `sid`/`child`/`parent` is resolved to project_id through
  `project_sessions`; on `sub_start` the child session inherits the parent's project automatically.
Realtime: publish `events`, `orders`, `projects` so the UI subscribes (RLS applies).

The legacy `agent_room` schema and its RPCs stay untouched until M2 cut-over (the current bridge still uses them).

## 4. Milestones

### M1 — Foundation (container-only; no VM, no production database, no deploy)

Goal: a repo where the new web app runs locally against a local/mocked backend, the new schema exists as tested migrations, and
the pipeline skills are drafted. Nothing touches the live Supabase project, Vercel, GitHub or the VM.

**T1. Monorepo scaffold**
- Root `package.json` with npm workspaces (`apps/*`), `README.md` explaining the layout, `.nvmrc` (Node LTS), `.editorconfig`.
- Exact-pinned dependency versions (no `^`/`~`).
- Check: `npm install` and `npm run -w apps/web build` succeed.

**T2. Supabase migrations** (`supabase/migrations/0001_platform.sql`, `0002_rls.sql`, `0003_rpcs.sql`, `0004_seed_owner_invite.sql`)
- Implement section 3 exactly. Idempotent where practical (`create table if not exists`, `create or replace function`).
- Never put real key values in migrations; the write key is inserted later by the operator.
- Check: apply to a throwaway local Postgres (install `postgresql` via apt or use `pglite`/`pg-mem` if apt is unavailable) with a
  minimal stub of the `auth` schema (`auth.users`, `auth.uid()`), and run SQL tests (T3).

**T3. Database tests** (`supabase/tests/*.sql` or a node test using `pg`)
- User A cannot read user B's project, events, orders (simulate `auth.uid()` via `set local request.jwt.claims`).
- Non-invited email insert into `auth.users` is rejected; invited one creates a profile with the right role.
- Only owners can manage invites.
- Machine RPCs reject a wrong write key; `platform_ingest` maps a sub-agent's events to the parent's project.
- Order insert rejects unknown kinds, empty/oversized text, and the 41st order in 10 minutes.

**T4. Web app: shell, theme, auth** (`apps/web`)
- Next.js App Router + TypeScript + Tailwind; tokens from section 1 in CSS variables; light and dark themes
  (`prefers-color-scheme` + a toggle stored in a cookie).
- Supabase via `@supabase/ssr` (server + browser clients). Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (`.env.example` only; never commit real values; the service role key is NOT used anywhere in the web app in M1).
- Pages: `/login`, `/signup` (says "invite only"; signup errors from the invite trigger are shown in plain words),
  `/forgot-password`, `/reset-password`, `/auth/callback`.
- Middleware protecting everything except auth pages and static assets; redirect to `/login?next=…`.
- `/settings/team` (owners only): invite by email, list and revoke invites.
- Motion: page transitions, button/press micro-animations, list item enter animations; all disabled under
  `prefers-reduced-motion`.
- Check: unit tests for middleware redirects; Playwright test of login form validation; no console errors.

**T5. Web app: projects and the project room**
- `/projects`: list with status chips (status → color mapping uses tokens), "New project" button.
- `/projects/new`: textarea for the idea → inserts project + `start_project` order.
- `/projects/[id]`: the room.
  - Left: conversation with the agents (BA questions, user replies) + a reply box (`message` orders).
  - BRD panel: renders `brd_markdown` (sanitized markdown), with **Approve BRD** (texas-rose fill) and **Ask for changes**.
    Approve sends `approve_brd`; this is the only approval button anywhere in the app.
  - Progress rail: the 6 phases (Discovery → Architecture → Development → Review → QA → Release) driven by `projects.phase`.
  - Live activity feed + "Who is talking" 2D map (port from legacy, see T6), lanes for Coder 1, Coder 2 and Devin.
  - Release card: staging and production links when present. Change request box once released.
  - Stop / Resume buttons.
- Realtime subscription to `events`, `orders`, `projects` for this project; reconnect handling; empty states.
- Responsive: works at 360 px width with no horizontal scroll.

**T6. Event model library** (`apps/web/lib/agent-events/`)
- Port the event-to-view logic from `legacy/agent-room/web/index.html` (`onLive`, `onAction`, lane assignment, gate
  detection, stage mapping) into pure TypeScript modules with types for every plugin event
  (see `hermes/plugin/agent-room/__init__.py`).
- New agent roster: Orchestrator, BA, Architect, Coder 1, Coder 2, Devin, Reviewer, QA, Release/DevOps, GitHub.
- New skill → phase map: `sdlc-orchestrator`, `sdlc-ba`, `sdlc-architect`, `sdlc-development`, `sdlc-review`, `sdlc-qa`,
  `sdlc-release`, `sdlc-change-request`.
- Output a single `ViewState` (agents, links between them, feed items, lanes, phase, gate) that both the 2D map and the future
  3D office consume.
- Check: unit tests replaying `hermes/tools/simulate_run.py`-style event sequences (write fixtures as JSON) produce the expected
  phases, lanes and feed items.

**T7. Skill drafts** (`hermes/skills/<name>/SKILL.md`, Hermes skill format with YAML front matter `name`, `description`)
- `sdlc-orchestrator`: owns the run, routes phases, one project at a time, writes progress via plugin-visible actions.
- `sdlc-ba`: interactive questions in rounds, then BRD at `docs/BRD.md`; ends its turn asking for approval of the BRD.
- `sdlc-architect`: `docs/CONTRACT.md` (data model, API contracts in `docs/openapi.yaml`, stack, design tokens), then
  `docs/PLAN.md` with tasks that do not share files, each marked `assignee: claude|devin`.
- `sdlc-development`: worktree + feature branch per task, atomic commits, unit tests, PR per task; the Team sync issue protocol
  (post blockers/interface questions, read before each step); Devin task handed over through the Devin MCP tools with
  `max_acu_limit`; fallback to a Claude coder when Devin is unavailable.
- `sdlc-review`: review against PLAN/CONTRACT, CI must be green, secret/vulnerability findings block, request changes with
  actionable feedback, coder rebases on main and fixes conflicts, auto-merge approved PRs; max 3 rework rounds then stop.
- `sdlc-qa`: wait for the staging deploy, run Playwright e2e + a BRD requirement checklist, file structured bug reports
  (issue template), route hotfix PRs through review, re-test; max 3 rounds.
- `sdlc-release`: promote to production, write README + user guide, report the live URL.
- `sdlc-change-request`: take a change on a released project, update CONTRACT/PLAN delta, run development → review → QA →
  release without a new BRD.
- No Telegram wording anywhere. All human interaction is "the user replies on the website".
- Check: a markdown lint pass and a script that validates front matter for every skill.

**T8. Hand-over report** (`docs/M1_REPORT.md`): what was built, how to run it, test results, open questions, anything that needs
the operator (Mohammad) or the live services.

### M2 — Cut-over (needs the operator: VM, live Supabase, Vercel)
1. Review M1 migrations, then apply them to the live Supabase project (operator approves); insert the write key.
2. Bridge v2: read `orders` per project via `platform_take_orders`, map sessions, set project phase/status from skill
   events, BRD capture (read `docs/BRD.md` from the repo after the BA turn and store it in `projects.brd_markdown`),
   approve_brd → finish-on-its-own mode, usage-limit pause/resume, one project at a time.
3. Plugin v2: send to `platform_ingest`; add actions for Team sync issue comments, QA results, deploy URLs.
4. Installer v2: installs skills to `~/.hermes/skills/`, disables the Telegram platform and removes its token
   (backup first), enables the API server, installs bridge v2. Operator runs it on the VM.
5. Deploy `apps/web` to Vercel (new project), set env vars, invite the team.
6. Check: a full run of the calculator demo from the new web app with one approval.

### M3 — Devin, CI, staging/production
1. Devin MCP in Hermes config (`https://mcp.devin.ai/mcp`, `Authorization: Bearer ${DEVIN_API_KEY}`, tool allow-list).
2. Bridge poller for Devin sessions → events (`devin_*` types) so Devin shows on the board.
3. `template/`: GitHub Actions (build, unit tests, gitleaks, dependency audit), branch protection script, Playwright e2e,
   Vercel deploy workflow (staging on main, production on QA sign-off tag).
4. Check: fake secret PR blocked; failing test blocks merge; Devin PR reviewed and fixed.

### M4 — 3D office and polish
1. React Three Fiber office scene consuming `ViewState`: desks per agent, walking on handoffs, speech bubbles for sync
   messages, meeting table for review/QA, phase lighting; Hermes3D models where useful (MIT, credited in `NOTICE`).
2. 2D fallback (current map) on low-end devices / reduced motion; performance budget: 60 fps desktop, ≥ 30 fps mid phone.
3. Full end-to-end: calculator + kanban, one change request, one forced QA bug, one forced merge conflict. Runbook. Demo.

## 5. Rules for every implementer
- Small commits with clear messages; run tests before each commit.
- No secrets in the repo, logs or test fixtures (use obviously fake values like `w-test`).
- Do not modify `legacy/` (reference only).
- Do not call live services (live Supabase project, Vercel, GitHub, Devin, the VM) in M1.
- Plain, simple English in all UI text; every user-facing state has a clear message (loading, empty, error).
