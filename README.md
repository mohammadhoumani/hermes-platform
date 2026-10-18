# Hermes Platform v2

A team gives a software idea on a website. Hermes AI agents (running on a separate VM) run the whole software
lifecycle: ask questions, write a requirements document (BRD), plan, code, review, test and release.
The only human gate is one click: **approve the BRD**.

This repository is the new platform. The older single-file dashboard lives in `legacy/` and is reference only.

## Layout

```text
apps/web/              Next.js app (App Router, TypeScript, Tailwind): the platform UI
hermes/plugin/         hermes-platform Hermes plugin v2 (event stream to Supabase)
hermes/bridge/         bridge v2 (website orders -> Hermes API, one project at a time)
hermes/skills/         SDLC skills, one SKILL.md per skill
hermes/install/        installer v2 for the VM (install_v2.sh, get_v2.sh) with dry run and rollback
hermes/tools/          fixture generator and other helpers
hermes/tests/          mock Supabase and Hermes servers, plugin, bridge and installer tests
supabase/migrations/   SQL migrations for the v2 data model (versioned, idempotent)
supabase/tests/        SQL tests (run against a throwaway local PostgreSQL)
template/              project template for generated apps (not started yet, see M3)
legacy/agent-room/     the old site, setup page and SQL (reference only, do not ship)
docs/                  implementation plan, milestone reports
```

## Quick start

You need Node 22 and npm 10 (see `.nvmrc`). The database tests also need the PostgreSQL 16 server binaries.

```bash
npm install
npm run build        # build the web app
npm run lint         # eslint + markdown lint
npm test             # unit tests (Vitest)
npm run test:db      # SQL migrations + 150+ database checks on a throwaway PostgreSQL
npm run test:skills  # validate the SKILL.md files
npm run test:hermes  # Python and shell tests: plugin, bridge, installer (needs python3 and node)
npm run test:e2e     # Playwright UI tests (starts the app in test mode by itself)
```

Run the web app with fixture data and no backend:

```bash
HERMES_TEST_MODE=1 npm run dev     # then open http://localhost:3000 with the test cookie, see docs/M1_REPORT.md
```

Run it against a real Supabase project: copy `apps/web/.env.example` to `apps/web/.env.local`, fill in the project URL and
the publishable key, then `npm run dev`.

## Going live

`docs/M2_RUNBOOK.md` is the step by step cut-over list (database, website, VM installer, test run, rollback).
`docs/M2_DEPLOY_CHECKLIST.md` has the Vercel settings, environment variables, Supabase Auth settings and the security checklist.
`docs/M2_REPORT.md` says what was built in Milestone 2 and what is not verified yet.

## Rules

See section 5 of `docs/IMPLEMENTATION_PLAN.md`: small commits, no secrets in the repo, `legacy/` is read only, plain English in the UI.
