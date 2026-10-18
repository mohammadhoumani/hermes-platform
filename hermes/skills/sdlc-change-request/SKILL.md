---
name: sdlc-change-request
description: Handles a change the user asks for on an already released project. Updates the contract and plan with only what changes, then runs development, review, QA and release again without writing a new BRD.
---

# SDLC Change Request

The user asked for a change to a project that is already live. You run a small version of the
pipeline. There is **no new BRD** and **no new approval**. The user's original approval covers
the change, because they asked for it.

## Steps

### 1. Understand the change

Read the user's request. Read `docs/BRD.md`, `docs/CONTRACT.md`, `docs/PLAN.md` and `docs/QA.md`.
Decide what the change touches. If the request is unclear, make the simplest reasonable choice and
say which in one sentence to the user. Do not interview them.

If the change clearly breaks a business requirement in the BRD, say so in plain words in one
message and do the change anyway as asked. Record the difference in `docs/CONTRACT.md` under "Assumptions".

### 2. Write the delta

On a branch `docs/change-<number>`, update only the parts that change:

- `docs/CONTRACT.md`: add a section `## Change <number>: <title>` that lists what is new or different
  (data model, API, design tokens). Update `docs/openapi.yaml` if an endpoint changes.
- `docs/PLAN.md`: add new tasks under `## Change <number>`, using the same task format as
  the architect (assignee, requirements, files, branch, done when). No two new tasks may share a file.
  Use `assignee: claude` for all of them unless the change is large and has a clearly separate part.
- Link the new tasks to the existing requirements they affect. If the change adds a feature that
  no requirement covers, write a line `CR-<number>` with one testable sentence in the contract and
  link tasks to that.

Merge these documents with a pull request titled `docs: change <number>` once checks pass.

### 3. Run the phases again, small

1. **Development**: load `sdlc-development` and build the new tasks. Same rules: worktree, branch,
   atomic commits, tests, one pull request per task.
2. **Review**: load `sdlc-review`. Same rules, including at most three rework rounds.
3. **QA**: load `sdlc-qa`. Test the change **and** re-run the whole checklist, because a change can
   break something that worked. Add rows for the change to `docs/QA.md`.
4. **Release**: load `sdlc-release`. Promote the new tested commit. Update the README and user
   guide where the change affects them.

### 4. Tell the user

Short message: what changed, in plain words, and the live address.
If the change could not be finished, say what is done and what is not.

## Rules

- One change at a time. If the user sends another change while one is running, finish the current
  one first, then start the next.
- Never skip QA. A released site must stay working.
- Never ask the user to approve anything.
- If the project is stopped or failed, do nothing and say that the project must be resumed first.
