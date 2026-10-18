# Hermes project template

This folder is the content of the GitHub template repository `hermesagenttabbeqai/hermes-project-template`.
Every new project the agents build starts as a copy of it. It gives each project the same safety net:
CI on every pull request, a secret scan, a dependency audit, staging and production deploys on Vercel,
and end-to-end tests the QA agent can run.

The agents replace this README in the release phase.

## What is in it

| Path | What it is for |
| --- | --- |
| `.github/workflows/ci.yml` | Runs on every pull request and every push to `main`. Jobs: `build-test` (install, lint if there is a `lint` script, unit tests, build), `secret-scan` (gitleaks), `dep-audit` (`npm audit --omit=dev --audit-level=high`). The Reviewer reads them with `gh pr checks`. |
| `.github/workflows/deploy.yml` | Staging deploy to Vercel on every push to `main`. Production deploy on a tag `release-*` or a manual run, only after QA signed off. |
| `.github/workflows/e2e.yml` | Playwright end-to-end tests against a web address. Used by the QA agent. Uploads the report as an artifact. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | The structured bug report that QA files. |
| `.github/ISSUE_TEMPLATE/team_sync.md` | The text of the pinned Team sync issue. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Task id, what changed, tests. |
| `.github/CODEOWNERS` | Optional. All rules are commented out. |
| `.gitleaks.toml` | Secret scan settings: the default rules, and a short allow list of files that cannot hold secrets. |
| `scripts/protect-main.sh` | Sets branch protection on `main` (pull request needed, CI checks must pass, no force push). Safe to run again. `--dry-run` shows what it would do. |
| `scripts/setup-repo.sh` | Creates the labels `task`, `bug`, `sync` and the Team sync issue. Safe to run again. |
| `scripts/vercel-deploy.sh` | Builds and deploys with the Vercel CLI. Used by `deploy.yml`. |
| `scripts/publish-url.sh` | Writes the deployed address to the job summary and to a commit status. Used by `deploy.yml`. |
| `scripts/verify-release.sh` | Production gate: the commit is on `main`, `docs/QA.md` says `QA result: passed`, CI is green. |
| `docs/BRD.md`, `docs/CONTRACT.md`, `docs/PLAN.md` | Skeletons. The business analyst and the architect fill them in. |
| `index.html`, `src/` | A very small starter site: Vite 8.3.4, plain JavaScript, the Node test runner. It needs no Vite config file, and Vercel builds it without any settings. Replace it with what the plan needs. |
| `e2e/`, `playwright.config.js` | Playwright 1.64.1 with a smoke test, on a desktop and a phone screen size. |
| `package.json`, `package-lock.json` | Exact versions, no `^`. Keep the lock file in git: CI uses `npm ci` and the audit needs it. |

## Secrets and variables

Set them in the repository (Settings, Secrets and variables, Actions), or with `gh secret set NAME`.
Never put real values in a file.

| Name | Kind | Needed for |
| --- | --- | --- |
| `VERCEL_TOKEN` | secret | `deploy.yml`. A Vercel access token. |
| `VERCEL_ORG_ID` | secret | `deploy.yml`. From `.vercel/project.json` after `vercel link`. |
| `VERCEL_PROJECT_ID` | secret | `deploy.yml`. Same file. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | secret, optional | `e2e.yml`. Lets the tests open a staging site that has Vercel Deployment Protection on. Alternative: turn that protection off for the project. |
| `GITLEAKS_LICENSE` | secret, optional | Only when the repository belongs to a GitHub organization. Personal accounts need no licence. |
| `PRODUCTION_URL` | variable, optional | A fixed production address, for example a custom domain. If it is not set, the Vercel address is used. |

`GITHUB_TOKEN` is provided by GitHub. The workflows ask only for the permissions they need.

## Set up a new project (what the Release and Architect agents do)

1. Create the repository from this template (`gh repo create <name> --template hermesagenttabbeqai/hermes-project-template --private --clone`).
2. Create the Vercel project and add the three Vercel secrets.
3. Run `bash scripts/setup-repo.sh` (labels and the Team sync issue). Keep the issue number as `sync_issue`.
4. Push the first commit to `main`, then run `bash scripts/protect-main.sh`. The branch must exist before it can be protected.
   GitHub only allows branch protection on a private repository with a paid plan. On a free plan, make the repository public.

## How the agents use it

| Agent | Command | What it gets |
| --- | --- | --- |
| Reviewer | `gh pr checks <number>` | The result of `build-test`, `secret-scan` and `dep-audit`. A red check blocks the merge. |
| QA | `gh api repos/<owner>/<repo>/commits/<sha>/status --jq '.statuses[] \| select(.context=="staging-url") \| .target_url'` | The staging address of a commit (also in the job summary and the `staging` deployment). |
| QA | `gh workflow run e2e.yml -f url=<address>` then `gh run watch <id>` | The Playwright run. The report is the artifact `playwright-report`. |
| Release | `git tag release-1 <sha> && git push origin release-1` | Starts the production deploy. It stops early if QA has not signed off or CI is not green. |
| Release | same `gh api` command with `production-url` | The production address. |

The production deploy builds again from the tagged commit, so the tag must be on the commit QA tested.

## Run it on your computer

```text
npm ci
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` builds the site and tests it locally. Set `E2E_BASE_URL=https://...` to test a running site instead.
Run `npx playwright install chromium` once first.

## Pinned versions

Actions are pinned to exact version tags (for example `actions/checkout@v4.2.2`), and the Vercel CLI to an exact version.
To pin an action to a full commit SHA instead, replace the tag with the SHA and keep the tag in a comment.
