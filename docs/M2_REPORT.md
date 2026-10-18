# Milestone 2 report (code part)

The code for Milestone 2 ("Cut-over") is finished and tested. Everything ran inside the container.
No live service was contacted: no Supabase project, no Vercel, no GitHub, no Devin, no VM.
No real key exists anywhere in the repository (tests use fake values such as `w-test`).
`legacy/` was not changed. The old Agent Room keeps working until the operator runs the installer
(`docs/M2_RUNBOOK.md`, Part 4).

What is **not** done is the cut-over itself. It needs Mohammad: the live database, Vercel and the VM.
The step by step list is in `docs/M2_RUNBOOK.md`.

## What was built, by task

### 1. Bridge v2 (`hermes/bridge/platform_bridge.py`, Python standard library only)

- Takes orders with `platform_take_orders`, reports with `platform_update_order`, sets status, phase,
  links and the BRD with `platform_set_project`, and maps sessions with `platform_map_session`.
- One project at a time. Other projects wait in a queue and show as `queued`.
- Order kinds: `start_project`, `message`, `approve_brd`, `request_brd_changes`, `change_request`, `stop`, `resume`.
- Status and phase come from the skills the agents load (`sdlc-ba` is Discovery, and so on).
- The BRD is read from `docs/BRD.md` in the project's repository and stored in `projects.brd_markdown`.
  The project then waits in `awaiting_brd_approval`.
- `approve_brd` starts "finish on your own" mode: the bridge keeps the run going through every phase until release.
- Usage limit: when Hermes or Claude reports a limit, the project becomes `paused`. The bridge waits
  (30 minutes by default, more on repeated limits) and continues by itself. It gives up after 20 tries.
- Release is detected from the project state file (`production_url`, `release_number`) or the live link in the output.
- A persistent state file and an outbox keep the bridge correct across restarts and Supabase outages.
- Safety: a blocklist of dangerous commands is refused when Hermes asks for approval; other commands are approved automatically.
- Test files: `hermes/tests/mock_platform.py` (mock of the five RPCs), `hermes/tests/fake_hermes.py`
  (fake Hermes API that fires the real plugin hooks), `hermes/tests/test_bridge.py` (33 tests).
  They cover the six required cases: a full run with one approval, the BRD changes loop, usage-limit pause and
  resume, stop, a second project queued, and a change request on a released project. They also cover
  outages, duplicate orders, a restart in the middle of a run, dangerous commands and the real command line.

### 2. Plugin v2 (`hermes/plugin/hermes-platform/`) and web event model

- Sends to `platform_ingest`. It can also mirror to the old `agent_room_ingest` when configured
  (`legacy` section in `config.json`). Secret hiding was kept and extended (Supabase secret keys, `apk_`, `cog_`, Vercel tokens).
- New skill names in the stage map. New actions: Team sync comments (`gh issue comment`), QA results
  (`QA.md`), repository and deploy links (`project.json` and command output), and Devin MCP calls.
- `apps/web/lib/agent-events` understands all of them. A fixture written by the real plugin
  (`fixtures/plugin-v2-actions.json`, made by `hermes/tools/make_fixture_v2.py`) is replayed in Vitest.
  A cross-language test checks that every action the plugin can send has a case in the web reducer.
- The skills were updated to agree with the bridge (workspace folder, `project.json` state file, `docs/BRD.md`, `QA.md`).
- Tests: `hermes/tests/test_plugin.py` (17), `apps/web/lib/agent-events/plugin-v2.test.ts`.

### 3. Installer v2 (`hermes/install/install_v2.sh`, `get_v2.sh`, `edit_config.py`)

- Installs the plugin, the bridge (systemd user service `hermes-platform-bridge`) and the 8 skills.
- Checks the write key first with a harmless call (empty list of events). A wrong key stops it before any change.
- Backs up every file it will change to `~/.hermes/backups/<timestamp>/` and writes a manifest.
- Switches Telegram off in a reversible way: `TELEGRAM_*` lines in `.env` become comments, and `telegram.enabled: false`
  is set in `config.yaml` with tokens blanked. It prints exactly what changed, names only, never values.
- Makes sure the Hermes API server is on (adds a random `API_SERVER_KEY` if there is none).
- Writes `~/.hermes/platform/config.json` (mode 600). Stops the old bridge and disables the old plugin (not deleted).
- Enables the plugin, restarts the gateway, starts the service and runs the bridge self check.
- `--dry-run` changes nothing. `--rollback` (alias `--uninstall`) restores everything from the newest backup.
  Running it twice makes no second backup. A copy of the installer stays in `~/.hermes/platform/` so rollback works after the download is gone.
- `get_v2.sh` downloads the package, checks every file against `SHA256SUMS`, then runs the installer.
- Tests (`hermes/tests/test_installer.py`, 30 tests) run in a fake `HERMES_HOME` with fake `hermes` and `systemctl`
  programs. They cover dry run, a full install, running twice, a wrong key, rollback (the file tree is identical afterwards),
  an update that backs up only changed files, flags, no hermes or systemd, a damaged backup, the download script with a
  tampered file, and the YAML and `.env` editing cases.

### 4. Owners remove a member's access (`supabase/migrations/0005_member_removal.sql`)

- `profiles.disabled_at`. Policies make a removed person see and do nothing, at once, even with a valid login.
  They can still read their own profile so the site can explain.
- `remove_member`, `restore_member`, `team_members()` (owners only). Owners cannot remove themselves or another owner.
  Removing stops the person's running projects with a `stop` order, bans the login and deletes their sessions.
- `/settings/team` shows People (with a confirm step, "Access removed" badge and "Give access back") and Invites waiting
  (pending invites can be taken back). A removed person sees one notice page.
- Tests: 48 new SQL checks (`60_member_removal.sql`), Vitest (`members.test.ts`, `team-manager.test.tsx`, messages),
  Playwright (`team.spec.ts`, accessibility checks of the team page and the notice page in light and dark).

### 5. Vercel readiness and runbook

- `apps/web/vercel.json`, new security headers (HSTS, COOP), `/pkg/` served without login (route guard test),
  `apps/web/scripts/build-pkg.mjs` builds the package with `SHA256SUMS` during `prebuild`.
- `lib/deploy-readiness.test.ts` checks the settings file, headers, the environment example, that no web source uses a
  service role key, the package checksums and that the package holds no key.
- `docs/M2_RUNBOOK.md` (simple English, Windows commands, cut-over order, checks, going back) and
  `docs/M2_DEPLOY_CHECKLIST.md` (Vercel settings, environment variables, Supabase Auth settings, database and RLS checks).

## Commands

```bash
npm run test:all      # lint, unit tests, SQL tests, skills, Python and shell tests, build, Playwright
npm run test:hermes   # only the Python and shell tests (plugin, bridge, installer, fixture check)
bash hermes/tests/run.sh
python3 hermes/tools/make_fixture_v2.py          # rewrite the web fixture from the real plugin
node apps/web/scripts/build-pkg.mjs --out /tmp/pkg --base file:///tmp/pkg   # build the installer package by hand
```

## Test results

Run from a fresh `git clone` followed by `npm ci`, then `npm run test:all` (exit code 0):

| Suite | Result |
| --- | --- |
| Markdown lint and ESLint | 0 issues |
| Vitest (`apps/web`) | `Test Files  14 passed (14)`, `Tests  266 passed (266)` |
| SQL (`npm run test:db`) | `SQL TESTS: 207 passed, 0 failed (migrations applied twice without error)` |
| Skills (`npm run test:skills`) | `ok: 8 skills have valid front matter and no banned wording.` and `# pass 8`, `# fail 0` |
| Python and shell (`npm run test:hermes`) | `Ran 80 tests in 85.945s` and `OK` (bridge 33, plugin 17, installer 30), then `fixture is up to date` |
| `next build` | passes (also creates `/pkg`) |
| Playwright (`npm run test:e2e`) | `46 passed (2.5m)` |

Before M2 the numbers were 159 SQL checks and no Python tests.

## Decisions I made

- **Same Supabase project.** The v2 tables have their own names, and the old Agent Room lives in its own schema
  and uses no Supabase login, so v2 can share the project. A new project works the same way.
- **One project at a time** for the whole VM (one global slot), as the plan says. Others show `queued`.
- **Order status:** an order is never put back in the queue by the bridge. A taken order ends as `done` or `failed`.
  A restart continues from the state file.
- **Commands are auto-approved**, except a blocklist (for example `rm -rf /`, deleting `~/.hermes`, `curl | sh`,
  reading keys or `.ssh`, `mkfs`, `shutdown`). The plan asks for no approvals except the BRD.
- **Telegram off by commenting out**, never deleting. Rollback restores the exact old files.
- **The old bridge and plugin are stopped at installation** (they would fight for the one Hermes API server). `--keep-legacy` skips this.
  `--mirror-legacy` also sends events to the old site, as a read-only view.
- **Installer package check is `SHA256SUMS` from the same website.** It protects against a broken or partial
  download, not against a hacked website. HTTPS protects the transport.
- **Owners cannot be removed** through the website (nor can you remove yourself). Role changes stay a database action.
  `remove_member` also stops the person's running projects.
- **No Content Security Policy** yet (needs per-request nonces with Next.js). Listed in the checklist.
- **`/pkg/` is public.** It holds only open source files and no secret.
- **Old migrations kept as they are.** Migration 0005 replaces `platform_is_owner()`, three policies and `create_project`.
  The files must be applied in order. A note in 0002 says so.
- **Old v1 skills** (`sdlc-project`, `sdlc-requirements`, `sdlc-planning`) on the VM are left alone. The plugin still understands their names.

## What is not verified

These could not be checked in the container. They are the first things to watch at the cut-over.

- **Real Hermes v0.21.5.** The bridge and plugin were tested against a fake Hermes API that follows the documented
  endpoints (`/v1/runs`, `/approval`, `/stop`, `/health`). The exact JSON of the real API, the real plugin hook
  arguments, the wording of the real usage-limit message and `hermes plugins enable/disable` behaviour are assumptions.
  The usage-limit detection uses several patterns and the failure case is a visible `paused` or `failed` project.
- **Real Supabase.** The SQL ran on plain PostgreSQL 16 with a small stub of the `auth` schema. Not checked:
  Realtime delivery, email sending, the built-in `auth.sessions` and `banned_until` columns (the function ignores
  a missing table or column with a warning, and the policies lock the data anyway), the Data API settings.
- **Vercel.** `vercel.json`, the install command from the repository root, "include files outside the Root Directory"
  and the `VERCEL_PROJECT_PRODUCTION_URL` variable are from documentation. The build was tested only locally.
- **The systemd and `loginctl` parts** of the installer ran against shell stand-ins, not a real systemd. `.env` and
  `config.yaml` editing is tested on sample files; a very unusual `config.yaml` layout is handled by leaving the line alone.
- **GitHub, Devin and project templates.** The skills use `gh` and the Devin MCP tools, but nothing was run. Staging and
  live links need the project template and its deploy workflow, which belong to Milestone 3.
  Until then the calculator demo may stop at the release step.
- **Network stress.** Outages were tested with a mock returning 503. Real slow networks were not.
- **A full calculator run with real agents** (the plan's Milestone 2 check) can only be done by the operator after the cut-over.
