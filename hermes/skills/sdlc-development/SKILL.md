---
name: sdlc-development
description: Developer workflow for building the planned tasks. Use after the plan exists. Each task gets its own worktree, branch, atomic commits, unit tests and pull request. Includes the Team sync issue rules, handing a task to Devin, and falling back to a Claude coder.
---

# SDLC Development

You build the tasks in `docs/PLAN.md`. At most two Claude coders work at the same time, plus one Devin task.
This skill is for every coder, including the orchestrator when it starts them.

## Before you start a task

1. Read `docs/BRD.md`, `docs/CONTRACT.md` and your task in `docs/PLAN.md`.
2. Read the **Team sync** issue (all comments). Do this again before each major step.
3. Change only the files listed in your task. If you need another file, post in Team sync first.

## Work in your own worktree

Every task has its own worktree and branch, so coders never step on each other:

```text
git fetch origin
git worktree add ../<repo>-<task-short-name> -b feature/<task-short-name> origin/main
cd ../<repo>-<task-short-name>
```

Do all your work inside that folder.

## Build in small steps

- Make **atomic commits**: one idea per commit, with a clear message (`feat: ...`, `fix: ...`, `test: ...`).
- Write unit tests with the code. Run the project's test and lint commands before every commit.
- Follow `docs/CONTRACT.md` exactly: names, types, design tokens. If the contract is wrong or
  incomplete, do not silently change it. Post in Team sync (see below).
- No secrets in code, tests or logs. Use obviously fake values.
- Keep text for users in plain, simple English.

## Open a pull request

When your task's "done when" is true and all checks pass locally:

```text
git push -u origin feature/<task-short-name>
gh pr create --title "<task title>" --body "Closes #<issue number>. <one line on what changed>. Requirements: BR-01, BR-02."
```

Then watch the checks (`gh pr checks <number> --watch`). If a check fails, fix it and push again.
Do not merge your own pull request. The reviewer does that (see `sdlc-review`).

## The Team sync issue

Team sync is how coders talk to each other without a human. It is one pinned issue.

**Post a comment when:**

- you are blocked and need an answer from another task (start with `BLOCKER:`),
- you need to change a shared interface (start with `INTERFACE:` and give the exact before and after),
- you finish something others depend on (start with `READY:`).

**Post with this exact command**, so the website can show the message (the issue number is `sync_issue`
in the project state file):

```text
gh issue comment <sync issue number> --body "<comment>"
```

**Comment format:**

```text
<BLOCKER|INTERFACE|READY>: task <number> -> task <number or "all">
<what you need or what changed, in two or three lines>
```

**Read before each step:** at the start of a task, before you push, and every time something
does not match the contract. Answer questions addressed to your task within your next step.
If nobody answers a blocker after you finish your other work, make the simplest choice that
follows the contract, write it in your pull request, and carry on.

## Handing a task to Devin

Tasks marked `assignee: devin` go to Devin through the Devin MCP tools.

1. Create the Devin session with the Devin tool `devin_session_create`, with a prompt that contains everything Devin needs: the repository,
   the branch name, the task text, the files it may change, the contract sections it must follow,
   the test and lint commands, and the rule "open a pull request and do not merge it".
2. Always set `max_acu_limit` on the session. Use the limit given in the order or settings.
   If none is given, use a small limit (for example 5). Never leave it unset.
3. Write the session down so the website can follow it. Append one line with the terminal tool (the project id is
   the folder name of your Workspace folder):
   `mkdir -p ~/.hermes/platform && printf '%s\n' '{"session_id":"<session id>","project_id":"<project id>","task":"Task <number>"}' >> ~/.hermes/platform/devin_sessions.json`
4. Check the session until it finishes (talk to it with `devin_session_interact`). Read its pull request like any other coder's.
5. Treat Devin's questions like Team sync comments: answer them from the contract.

**Fallback:** if the Devin tools are missing, return an error, the session fails, or the limit is
reached before the pull request exists, do not wait. Say so in Team sync, and build that task
yourself as a Claude coder, using the same worktree and branch rules. Mention the fallback in the pull request.

## Finishing

You are done when every task in `docs/PLAN.md` has an open pull request with passing checks.
Then say so in one line and let the orchestrator move to review.

## Do not

- Do not push to `main`.
- Do not edit files outside your task without asking in Team sync.
- Do not skip tests to make a check pass.
- Do not leave a worktree running or a branch half-pushed. Push, or say what is left.
