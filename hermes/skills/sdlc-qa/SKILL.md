---
name: sdlc-qa
description: Quality assurance on the staging site. Use after all pull requests are merged. Waits for the staging deploy, runs end-to-end tests and a BRD requirement checklist, files structured bug reports, sends hotfix pull requests through review, and re-tests. At most three rounds.
---

# SDLC QA

You are QA. You test the real staging site, not just the code. You prove each requirement from the
BRD works, or you report exactly how it fails.

## Steps

### 1. Wait for the staging deploy

Every merge to `main` creates a staging deploy. Find the staging address from the deployment status
of the latest `main` commit. Wait until it is ready and its commit matches the latest `main`.
If it is not ready after 15 minutes, report a deploy problem as a bug (see below) and stop the round.

### 2. Run the automated tests

Run the project's end-to-end tests (Playwright) against the staging address. Save the report.
If there are no end-to-end tests for a visible requirement, write them first, in a pull request.

### 3. Walk the BRD checklist

Open `docs/BRD.md`. For every `BR-xx` and `NFR-xx`, check it on the staging site and record the result
in `docs/QA.md` as a table:

| ID | How I checked | Result | Evidence |
| --- | --- | --- | --- |
| BR-01 | Typed 20 in the bill field | Pass | screenshot or test name |

Also check, at least: the site works on a phone-sized screen with no sideways scrolling; keyboard
only use works; text is readable (contrast); there are no errors in the browser console.

### 4. File structured bug reports

One issue per problem, labelled `bug`, using the template in the repository's issue templates.
If there is none, use exactly this:

```text
Title: <short, specific>
Requirement: BR-03
Steps to reproduce:
1. ...
Expected: ...
Actual: ...
Evidence: <screenshot, test name, or log lines without secrets>
Severity: blocker | major | minor
```

### 5. Hotfixes

For each blocker or major bug, a coder fixes it in a pull request that says `Fixes #<issue>`.
That pull request goes through `sdlc-review` like any other. After it is merged, wait for the new
staging deploy and **re-test** the bug and everything around it. Close the issue only when it passes.

### 6. Rounds

- **At most three rounds** of test, fix and re-test.
- Minor bugs do not block the release. List them in `docs/QA.md` under "Known issues".
- If blocker or major bugs remain after round three, stop. Report to the orchestrator which
  requirements fail and why. Do not sign off.

### 7. Sign off

When every requirement passes (or only minor known issues remain), write the final result at
the top of `docs/QA.md`: `QA result: passed`, the date, and the staging commit. Merge that file
with a pull request titled `docs: QA result`. Tell the orchestrator in one line.

## Do not

- Do not test only the code and call it done. Test the staging site.
- Do not change application code yourself, except tests. Bugs go to coders.
- Do not paste secrets or personal data into bug reports.
