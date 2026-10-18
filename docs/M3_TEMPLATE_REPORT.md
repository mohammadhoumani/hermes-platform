# M3 report: project template, Devin config, CI and deploy

Scope: M3 items 1 and 3, and the Devin config part of item 2. Nothing here called a live service
(no GitHub, Vercel, Devin or Supabase). All keys in files and tests are fake.

## What was built

| Where | What |
| --- | --- |
| `template/` | The content of the template repo `hermesagenttabbeqai/hermes-project-template`. Start with `template/README.md`: it explains every file and every secret. |
| `template/.github/workflows/ci.yml` | Jobs `build-test`, `secret-scan`, `dep-audit` on pull requests and pushes to `main`. |
| `template/.github/workflows/deploy.yml` | Staging on every push to `main`. Production on a `release-*` tag or a manual run, behind a QA and CI gate. |
| `template/.github/workflows/e2e.yml` | Playwright against an address. Used by QA. Uploads `playwright-report`. |
| `template/scripts/` | `protect-main.sh`, `setup-repo.sh`, `vercel-deploy.sh`, `publish-url.sh`, `verify-release.sh`. |
| `hermes/devin/` | `config.yaml.snippet`, `README.md`, `devin_poller.py`. |
| `hermes/tests/test_devin_poller.py` | 15 tests against a mock Devin server on 127.0.0.1. Picked up by `npm run test:hermes`. |
| `tests/template/` | `validate.mjs` (static checks), `scripts.test.sh` (scripts against fake `gh` and `vercel`), `run.sh`. |
| `package.json` | New script `test:template`, added to `test:all`. |
| `.markdownlint-cli2.jsonc` | Globs now also cover `template/**/*.md` and `hermes/devin/**/*.md`. |
| `hermes/skills/sdlc-development/SKILL.md` | One new step: append the Devin session to `~/.hermes/platform/devin_sessions.json`. The poller needs it. |

## How the agents find the URLs

Staging and production addresses are published in three places: the job summary, a commit status on the deployed
commit (`staging-url` or `production-url`, the address is `target_url`), and a GitHub deployment in the environment
`staging` or `production`. The command is in `template/README.md`.

## Tests

- `npm run test:template`: 16 static checks, 43 script checks, 15 poller tests.
- Extra checks I ran by hand and did not add to the suite (they need tools that are not in the repo):
  shellcheck on every script, actionlint (with shellcheck) on the three workflows, `npm ci`, `npm test`,
  `npm run build` and `npm audit --omit=dev` on a copy of the starter app, and the Playwright smoke test on a copy of the
  starter app with the sandbox Chromium. All were clean.
- `TEMPLATE_BUILD=1 npm run test:template` repeats the `npm ci`, test, build and audit on a copy of `template/` (needs the npm registry).
- The suite runs shellcheck if it is installed. The sandbox did not have it.

## Decisions I made

1. **Actions are pinned to exact version tags, not SHAs.** The task allowed both. Looking up SHAs needs GitHub, which was off limits.
   The test enforces `@vX.Y.Z` or a 40-character SHA. Pin to SHAs later with a tool such as `pinact`.
2. **Zero required approvals in branch protection.** Every agent uses one GitHub account, and GitHub does not let an account approve its
   own pull request, so a required approval would block every merge. The rules are: pull request needed, CI checks must pass, no force push,
   no deletion, linear history. `enforce_admins` is on, so the owner account cannot push to `main` either (`--no-enforce-admins` turns it off).
3. **`strict` (branch must be up to date) is off.** With it on, every merge makes all other open pull requests out of date and the Reviewer
   would have to rebase each one even without conflicts. The review skill already asks for rebases when there are conflicts.
4. **Required check names equal the job names** (`build-test`, `secret-scan`, `dep-audit`). A test checks that `ci.yml`, `protect-main.sh`
   and `verify-release.sh` agree.
5. **The production deploy rebuilds from the tagged commit** instead of promoting the staging build. It is simple and does not depend on
   how Vercel promotes preview builds. `verify-release.sh` makes sure the tag is on `main`, `docs/QA.md` starts with `QA result: passed`
   (first ten lines), and the three CI checks of that commit succeeded. A tag pushed while CI still runs fails the gate; run the workflow again.
6. **Starter app: Vite 8.3.4, plain JavaScript, Node test runner, Playwright 1.64.1.** Two dev dependencies only, no `vite.config` file,
   so Vercel detects it. Versions are the ones the npm registry returned on 2026-10-18 (Playwright matches `apps/web`). `package-lock.json`
   is committed because `npm ci` and the audit need it.
7. **Lint is optional**: `npm run lint --if-present`. The architect adds a linter if the plan needs one.
8. **Gitleaks uses `gitleaks/gitleaks-action@v2.3.9`**, with PR comments and artifact upload off to keep permissions small.
   It needs no licence for a personal account; for an organization add the `GITLEAKS_LICENSE` secret.
9. **E2E is not chained to the deploy automatically.** QA runs `gh workflow run e2e.yml`. If no address is given it reads the `staging-url`
   status of the commit. This keeps a protected or slow staging site from turning every deploy red.
10. **Vercel Deployment Protection** blocks anonymous requests to preview deployments by default. `publish-url.sh` warns on HTTP 401 or 403.
    Either turn protection off for the project or set the optional secret `VERCEL_AUTOMATION_BYPASS_SECRET` (the Playwright config sends it as a header).
11. **Extra scripts I added** because the skills need them: `setup-repo.sh` (labels `task`, `bug`, `sync` and the Team sync issue; the architect
    skill labels issues `task`, which does not exist in a new repo), and the three deploy helpers, so the YAML stays short and the logic can be tested.
12. **Devin API version.** The brief says v1 (`GET /v1/sessions/{id}`). The README says `cog_` keys are the ones that work for the MCP server.
    I do not know if v1 accepts `cog_` keys, so with a `cog_` key and an organization id (`--org-id` or `DEVIN_ORG_ID`) the poller uses the v3 path
    `/v3/organizations/{org}/sessions/{id}`. Otherwise it uses v1.
13. **Sessions file format.** One JSON object per line (easy to append with `printf >>`), but `{"sessions": [...]}` and a bare list are also read.
    The poller keeps what it already reported in `devin_poller_state.json` next to it, so a restart does not repeat events.
14. **Event shape**: `{"v":1,"ts","type":"devin_status","project","sid","session_id","status","raw_status","pr","pr_url","finished","text"}`.
    `status` is one of `working|blocked|finished|failed|suspended|unknown`. `sid` is the Devin session id, like the `devin-1` ids in the web fixtures.

## Not verified

- No workflow has run on GitHub. I only parsed them (js-yaml, actionlint) and ran the scripts against shims. The action tags
  (`actions/checkout@v4.2.2`, `actions/setup-node@v4.4.0`, `actions/upload-artifact@v4.6.2`, `gitleaks/gitleaks-action@v2.3.9`) are from memory and must exist.
- Real `vercel` CLI behaviour is untested: the output format of `vercel deploy`, the alias parsing from `vercel inspect` (best effort, falls back to the
  deployment address), `vercel pull` with only the three env vars, and `--meta`. Vercel CLI 64.5.0 and the template's Vite/Playwright versions come from the npm registry.
- The environment `url` expression, commit statuses and deployments (permissions `statuses: write`, `deployments: write`) were not exercised.
- Branch protection payload accepted by GitHub: the fields follow the documented REST API, but nothing was sent. Private repos on a free GitHub plan cannot have branch protection.
- The Devin API response shapes (v1 `status_enum`, `pull_request.url`; v3 `status`, `pull_requests[].pr_url`) are from memory of the docs. The mock server
  uses those shapes, so the tests prove the code, not the API. Unknown status words count as `working`.
- Hermes `mcp_servers` syntax (`tools.include`, `*` patterns, `${DEVIN_API_KEY}` in headers, `timeout`/`connect_timeout`) and the exact Devin MCP tool argument names are unverified.
- The "fake secret PR blocked" and "failing test blocks merge" checks of the plan (M3 step 4) need a real repo with the workflows and branch protection.
- Shellcheck is not in the repo environment, so `test:template` skips it when missing. The scripts were clean when I ran it by hand.

## For the integrator (not done here, outside my scope)

- **Bridge**: call `DevinPoller(...).poll_once()` from the loop (or run `devin_poller.py --events-file`), and forward `devin_status` events
  to `platform_ingest`. The web reducer (`apps/web/lib/agent-events`) knows `devin_started`, `devin_progress`, `devin_pr`, `devin_done`, `devin_failed`;
  it has no case for `devin_status`, so either map it there or in the bridge (`pr` set -> `devin_pr`, `finished` -> `devin_done`, `failed` -> `devin_failed`).
- **Installer**: copy `hermes/devin/config.yaml.snippet` into `config.yaml` (when a `DEVIN_API_KEY` exists) and run the poller as a service. The installer was not touched.
- **Review skill**: `gh pr review --approve` fails on a pull request from the same account. Branch protection here does not need approvals, but the skill text
  could say "if GitHub refuses the approval, comment the review result and merge".
- **Operator steps** for the template repo: create `hermesagenttabbeqai/hermes-project-template`, copy `template/` into it, mark it as a template repository.
  Per project: Vercel project plus the three secrets, then `scripts/setup-repo.sh` and `scripts/protect-main.sh` (see `template/README.md`).
