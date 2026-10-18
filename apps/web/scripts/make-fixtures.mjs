#!/usr/bin/env node
/**
 * Writes the JSON event fixtures in lib/agent-events/fixtures/.
 * The events have exactly the shape that hermes/plugin/agent-room/__init__.py sends (see lib/agent-events/types.ts),
 * and follow the v2 flow: Orchestrator, BA (BRD, one approval), Architect, Coders + Devin, Reviewer, QA, Release.
 * Run: node scripts/make-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../lib/agent-events/fixtures");
mkdirSync(out, { recursive: true });

function recorder(startTs) {
  let t = startTs;
  let n = 0;
  const ev = [];
  const MAIN = "main-1";
  const add = (e, dt = 4) => ev.push({ v: 1, ts: Math.round((t += dt) * 1000) / 1000, sim: true, ...e });
  const tool = (name, args, { sid = MAIN, actions = [], status = "ok", summary } = {}) => {
    const call = `call-${++n}`;
    const sum = summary ?? args.command ?? args.path ?? args.name ?? "";
    add({ type: "tool_start", sid, call, tool: name, summary: sum }, 1);
    add({ type: "tool_end", sid, call, tool: name, status, ms: 400, summary: sum, ...(actions.length ? { actions } : {}) }, 2);
  };
  const sh = (command, actions, sid = MAIN) => tool("terminal", { command }, { sid, actions });
  const human = (text) => add({ type: "turn_start", sid: MAIN, platform: "api_server", sender: "web", first: false, text }, 20);
  const reply = (text, gates) => add({ type: "turn_end", sid: MAIN, platform: "api_server", text, ...(gates ? { gates } : {}) }, 6);
  const skill = (name) => {
    tool("skill_view", { name }, { summary: name });
    add({ type: "skill", sid: MAIN, name, action: "loaded" }, 1);
  };
  const subStart = (child, goal, role) => add({ type: "sub_start", parent: MAIN, child, sub: child, ...(role ? { role } : {}), goal }, 3);
  const subStop = (child, summary, status = "completed", role) =>
    add({ type: "sub_stop", parent: MAIN, child, ...(role ? { role } : {}), status, summary, ms: 90000, tools: 8, files: [] }, 8);
  return { ev, add, tool, sh, human, reply, skill, subStart, subStop, MAIN, now: () => t };
}

const REPO = "bot-account/tip-calculator";

// ---------------------------------------------------------------------------
// 1. Discovery only: the BA asked questions, wrote the BRD and waits for the one approval
// ---------------------------------------------------------------------------
function discovery(r) {
  r.add({ type: "plugin_loaded", path: "/home/hermes/.hermes/agent-room/events.jsonl", cloud: true }, 0);
  r.add({ type: "session_start", sid: r.MAIN, platform: "api_server", model: "claude-sim" }, 1);
  r.human("Start project: a web app that works out the tip and splits the bill between friends");
  r.skill("sdlc-orchestrator");
  r.sh(`gh repo create ${REPO} --public --template bot-account/hermes-project-template --clone`, [{ action: "repo", repo: REPO, template: "bot-account/hermes-project-template" }]);
  r.reply("Created the project repo. Handing over to the business analyst.");
  r.skill("sdlc-ba");
  r.reply("Which tip percentages should be preset?");
  r.human("10, 15, 20 and a custom amount");
  r.reply("How many people can split one bill?");
  r.human("1 to 20 people");
  r.reply("Should it remember the last values?");
  r.human("No, keep it simple");
  r.tool("write_file", { path: "docs/BRD.md", content: "# BRD ..." }, { actions: [{ action: "brd", path: "docs/BRD.md" }] });
  r.sh('git add docs/BRD.md && git commit -m "docs: add BRD (BR-01..BR-05, NFR-01..02)" && git push origin main', [
    { action: "commit", message: "docs: add BRD (BR-01..BR-05, NFR-01..02)" },
    { action: "push", branch: "main" },
  ]);
  r.reply("The BRD is ready: 5 business requirements and 2 quality requirements. Please read it and approve it, or ask for changes.");
}

// ---------------------------------------------------------------------------
// 2. Everything after the approval, up to the live site
// ---------------------------------------------------------------------------
function afterApproval(r) {
  r.human("The user approved the BRD. Continue on your own until the site is live.");
  r.skill("sdlc-architect");
  r.tool("write_file", { path: "docs/CONTRACT.md", content: "# Contract ..." }, { actions: [{ action: "docs", path: "docs/CONTRACT.md" }] });
  r.tool("write_file", { path: "docs/openapi.yaml", content: "openapi: 3.1.0" }, { actions: [{ action: "docs", path: "docs/openapi.yaml" }] });
  r.tool("write_file", { path: "docs/PLAN.md", content: "# Plan ..." }, { actions: [{ action: "plan", path: "docs/PLAN.md" }] });
  r.sh('gh issue create --title "Input form" --body "Task 1 (assignee: claude)"', [{ action: "issue", title: "Input form" }]);
  r.sh('gh issue create --title "Tip logic" --body "Task 2 (assignee: claude)"', [{ action: "issue", title: "Tip logic" }]);
  r.sh('gh issue create --title "Styles and layout" --body "Task 3 (assignee: devin)"', [{ action: "issue", title: "Styles and layout" }]);
  r.sh("gh api -X PUT repos/bot-account/tip-calculator/branches/main/protection --input protection.json", [{ action: "protect" }]);
  r.reply("Design and plan are ready: 3 tasks that do not share files.");

  r.skill("sdlc-development");
  const goals = [
    ["dev-a", "Task #1 input form. Work on branch feature/tip-input-form", "feature/tip-input-form", "Input form", 4],
    ["dev-b", "Task #2 tip logic. Work on branch feature/tip-calc-logic", "feature/tip-calc-logic", "Tip logic", 5],
  ];
  for (const [sid, goal] of goals) r.subStart(sid, goal);
  r.add({ type: "devin_started", sid: "devin-1", task: "Task #3 styles and layout", branch: "feature/styles-layout", text: "Task #3 styles and layout. Branch feature/styles-layout" }, 5);
  for (const [sid, , br, title] of goals) {
    r.tool("write_file", { path: `src/${title.toLowerCase().replace(/ /g, "-")}.ts`, content: "..." }, { sid, actions: [{ action: "file", path: `src/${title.toLowerCase().replace(/ /g, "-")}.ts`, tool: "write_file" }] });
    r.sh(`git commit -am "feat: ${title.toLowerCase()}" && git push -u origin ${br}`, [{ action: "commit", message: `feat: ${title.toLowerCase()}` }, { action: "push", branch: br }], sid);
  }
  r.add({ type: "devin_progress", sid: "devin-1", text: "Wrote the stylesheet and the layout" }, 6);
  for (const [sid, , br, title, pr] of goals) {
    r.sh(`gh pr create --title "${title}" --head ${br} --body "Closes #${pr - 3}"`, [{ action: "pr_open", title, branch: br, pr }], sid);
    r.sh(`gh pr checks ${pr} --watch`, [{ action: "ci", pr, outcome: "passed" }], sid);
  }
  r.add({ type: "devin_pr", sid: "devin-1", pr: 6, text: "Styles and layout" }, 6);
  for (const [sid, , , title] of goals) r.subStop(sid, `${title} done, PR open, CI green`);
  r.add({ type: "devin_done", sid: "devin-1", text: "PR #6 open, CI green" }, 6);
  r.reply("All three tasks have a pull request. Starting the review.");

  r.skill("sdlc-review");
  r.sh('gh pr review 4 --approve --body "Looks good"', [{ action: "review", pr: 4, verdict: "approved", body: "Looks good" }]);
  r.sh('gh pr review 6 --approve --body "Looks good"', [{ action: "review", pr: 6, verdict: "approved", body: "Looks good" }]);
  r.sh('gh pr review 5 --request-changes --body "Totals must round to 2 decimals (NFR-02)"', [{ action: "review", pr: 5, verdict: "changes", body: "Totals must round to 2 decimals (NFR-02)" }]);
  r.subStart("fix-1", "Fix rounding on PR #5, branch feature/tip-calc-logic");
  r.sh('git commit -am "fix: round totals to 2 decimals" && git push', [{ action: "commit", message: "fix: round totals to 2 decimals" }, { action: "push" }], "fix-1");
  r.sh("gh pr checks 5", [{ action: "ci", pr: 5, outcome: "passed" }], "fix-1");
  r.subStop("fix-1", "Rounding fixed, test added");
  r.sh('gh pr review 5 --approve --body "Fixed"', [{ action: "review", pr: 5, verdict: "approved", body: "Fixed" }]);
  for (const pr of [4, 5, 6]) r.sh(`gh pr merge ${pr} --squash --delete-branch`, [{ action: "pr_merge", pr }]);
  r.reply("All pull requests are approved and merged into main.");

  r.skill("sdlc-qa");
  r.tool("deploy_status", { name: "staging" }, { actions: [{ action: "deploy", env: "staging", url: "https://tip-calculator-git-main.example.test" }] });
  r.tool("terminal", { command: "npx playwright test" }, { actions: [{ action: "qa_result", outcome: "failed", round: 1, bugs: 1, summary: "Custom tip of 0 shows NaN" }] });
  r.subStart("hotfix-1", "Hotfix: custom tip of 0 shows NaN, branch fix/custom-tip-zero");
  r.sh('git commit -am "fix: custom tip of zero" && git push -u origin fix/custom-tip-zero', [{ action: "commit", message: "fix: custom tip of zero" }, { action: "push", branch: "fix/custom-tip-zero" }], "hotfix-1");
  r.sh('gh pr create --title "Fix custom tip of zero" --head fix/custom-tip-zero', [{ action: "pr_open", title: "Fix custom tip of zero", branch: "fix/custom-tip-zero", pr: 7 }], "hotfix-1");
  r.subStop("hotfix-1", "Hotfix PR #7 is open");
  r.sh('gh pr review 7 --approve --body "Fix is correct"', [{ action: "review", pr: 7, verdict: "approved", body: "Fix is correct" }]);
  r.sh("gh pr merge 7 --squash", [{ action: "pr_merge", pr: 7 }]);
  r.tool("terminal", { command: "npx playwright test" }, { actions: [{ action: "qa_result", outcome: "passed", round: 2, summary: "All BRD requirements checked" }] });
  r.reply("QA signed off. The site works as the BRD describes.");

  r.skill("sdlc-release");
  r.tool("write_file", { path: "README.md", content: "# Tip calculator" }, { actions: [{ action: "docs", path: "README.md" }] });
  r.tool("deploy_status", { name: "production" }, { actions: [{ action: "deploy", env: "production", url: "https://tip-calculator.example.test" }] });
  r.reply("Done. The site is live at https://tip-calculator.example.test");
}

// ---------------------------------------------------------------------------
// 3. A change request on the released project
// ---------------------------------------------------------------------------
function changeRequest(r) {
  r.human("Change request: add a button that rounds the total up to the next whole dollar");
  r.skill("sdlc-change-request");
  r.tool("write_file", { path: "docs/PLAN.md", content: "# Plan (change)" }, { actions: [{ action: "plan", path: "docs/PLAN.md" }] });
  r.subStart("cr-dev", "Change request task: round up button. Work on branch feature/round-up");
  r.sh('git commit -am "feat: round up button" && git push -u origin feature/round-up', [{ action: "commit", message: "feat: round up button" }, { action: "push", branch: "feature/round-up" }], "cr-dev");
  r.sh('gh pr create --title "Round up button" --head feature/round-up', [{ action: "pr_open", title: "Round up button", branch: "feature/round-up", pr: 8 }], "cr-dev");
  r.subStop("cr-dev", "PR #8 open, CI green");
  r.skill("sdlc-review");
  r.sh('gh pr review 8 --approve --body "Good"', [{ action: "review", pr: 8, verdict: "approved", body: "Good" }]);
  r.sh("gh pr merge 8 --squash", [{ action: "pr_merge", pr: 8 }]);
  r.skill("sdlc-qa");
  r.tool("terminal", { command: "npx playwright test" }, { actions: [{ action: "qa_result", outcome: "passed", round: 1, summary: "Round up works" }] });
  r.skill("sdlc-release");
  r.tool("deploy_status", { name: "production" }, { actions: [{ action: "deploy", env: "production", url: "https://tip-calculator.example.test" }] });
  r.reply("The change is live at https://tip-calculator.example.test");
}

const START = 1760000000;

let r = recorder(START);
discovery(r);
writeFileSync(`${out}/discovery-awaiting-brd.json`, JSON.stringify(r.ev, null, 1) + "\n");

r = recorder(START);
discovery(r);
afterApproval(r);
writeFileSync(`${out}/calculator-run.json`, JSON.stringify(r.ev, null, 1) + "\n");

r = recorder(START + 100000);
changeRequest(r);
writeFileSync(`${out}/change-request.json`, JSON.stringify(r.ev, null, 1) + "\n");

console.log("Wrote fixtures to", out);
