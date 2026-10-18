#!/usr/bin/env python3
"""Writes apps/web/lib/agent-events/fixtures/plugin-v2-actions.json by driving the REAL hermes-platform plugin
with a scripted run (Team sync comments, Devin MCP calls, QA.md results, deploy links, the project state file).
The output is therefore exactly what the plugin sends, so the web app's tests replay the real shape.

    python3 hermes/tools/make_fixture_v2.py            # write the fixture
    python3 hermes/tools/make_fixture_v2.py --check    # exit 1 if the committed fixture is out of date
"""

import importlib.util
import json
import os
import sys
import tempfile
import time as real_time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "apps" / "web" / "lib" / "agent-events" / "fixtures" / "plugin-v2-actions.json"
PID = "0b6f3c1e-7a52-4d0e-9c1b-2f6a5d8e4c11"
START = 1760200000.0


class Clock:
    """A fake `time` module for the plugin: every call moves 2 seconds on, so the fixture never changes."""

    def __init__(self):
        self.t = START

    def time(self):
        self.t += 2.0
        return self.t

    def sleep(self, s):
        pass


def build() -> list:
    tmp = Path(tempfile.mkdtemp(prefix="hp-fixture-"))
    os.environ.update(HERMES_HOME=str(tmp), HERMES_PLATFORM_EVENTS=str(tmp / "events.jsonl"))
    for k in ("HERMES_PLATFORM_SUPABASE_URL", "HERMES_PLATFORM_WRITE_KEY"):
        os.environ.pop(k, None)
    spec = importlib.util.spec_from_file_location("hp_fixture_plugin", ROOT / "hermes" / "plugin" / "hermes-platform" / "__init__.py")
    p = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(p)
    p.time = Clock()
    H = p.HOOKS
    MAIN = "main-1"
    n = [0]

    def tool(name, args, result="", sid=MAIN, status="ok"):
        n[0] += 1
        call = f"call-{n[0]}"
        H["pre_tool_call"](tool_name=name, args=args, session_id=sid, tool_call_id=call)
        H["post_tool_call"](tool_name=name, args=args, result=result, session_id=sid, tool_call_id=call, status=status, duration_ms=300)

    sh = lambda cmd, result="", sid=MAIN: tool("terminal", {"command": cmd}, result, sid)

    def skill(name):
        tool("skill_view", {"name": name}, "ok")
        H["on_skill_lifecycle"](action="loaded", skill_name=name, session_id=MAIN)

    def human(text):
        H["pre_llm_call"](session_id=MAIN, user_message=f"{text}\n\n(hermes-project:{PID})", platform="api_server", is_first_turn=False)

    def reply(text):
        H["post_llm_call"](session_id=MAIN, assistant_response=text, platform="api_server")

    REPO = "bot-account/tip-calculator"
    WS = "/home/ubuntu/.hermes/platform/workspaces/" + PID
    state = lambda **kw: json.dumps({"repo_path": WS + "/repo", **kw})

    H["on_session_start"](session_id=MAIN, platform="api_server", model="claude-sim")
    human("/sdlc-orchestrator a web app that works out the tip and splits the bill")
    skill("sdlc-orchestrator")
    sh(f"gh repo create {REPO} --public --template bot-account/hermes-project-template --clone", f"https://github.com/{REPO}")
    tool("write_file", {"path": WS + "/project.json", "content": state(repo_url=f"https://github.com/{REPO}")})
    sh('gh issue create --title "Team sync" --body "Agents post blockers here"', f"https://github.com/{REPO}/issues/1")
    skill("sdlc-ba")
    tool("write_file", {"path": "docs/BRD.md", "content": "# Business Requirements"})
    reply("The BRD is ready: 5 business requirements and 2 quality requirements.\nPlease read it on the website, then press Approve BRD.")

    human("The user approved the BRD. Continue on your own until the site is live.")
    skill("sdlc-architect")
    tool("write_file", {"path": "docs/PLAN.md", "content": "# Plan"})
    sh('gh issue create --title "Input form" --body "Task 1 (assignee: claude)"', f"https://github.com/{REPO}/issues/2")
    reply("Design and plan are ready: 3 tasks.")

    skill("sdlc-development")
    tool("mcp_devin_devin_session_create", {"title": "Task 3 styles and layout", "prompt": "Build the styles. Branch feature/styles", "max_acu_limit": 5},
         json.dumps({"session_id": "devin-3f9a1c0b77d2", "url": "https://app.devin.ai/sessions/3f9a1c0b77d2"}))
    for sid, goal in (("dev-a", "Task #1 input form. Work on branch feature/input-form"), ("dev-b", "Task #2 tip logic. Work on branch feature/tip-logic")):
        H["subagent_start"](parent_session_id=MAIN, child_session_id=sid, child_subagent_id=sid, child_goal=goal)
    sh('gh issue comment 1 --body "BLOCKER: task 2 -> task 1\nWhat is the exact name of the tip field?"')
    sh("gh issue comment 1 --body 'INTERFACE: task 1 -> all\ncalcTip(bill, percent) returns cents'", sid="dev-a")
    tool("mcp_devin_devin_session_interact", {"session_id": "devin-3f9a1c0b77d2", "message": "Use the design tokens from docs/CONTRACT.md"}, "sent")
    sh('gh issue comment 1 --body "READY: task 1 -> task 2\nthe form is on main"', sid="dev-a")
    for sid, br, title, pr in (("dev-a", "feature/input-form", "Input form", 4), ("dev-b", "feature/tip-logic", "Tip logic", 5)):
        sh(f'git commit -am "feat: {title.lower()}" && git push -u origin {br}', sid=sid)
        sh(f'gh pr create --title "{title}" --head {br}', f"https://github.com/{REPO}/pull/{pr}", sid=sid)
        sh(f"gh pr checks {pr}", "test\tpass\t12s", sid=sid)
        H["subagent_stop"](parent_session_id=MAIN, child_session_id=sid, child_status="completed", child_summary=f"{title} done, PR #{pr} open", tool_call_history=[], duration_ms=60000)
    reply("All tasks have a pull request.")

    skill("sdlc-review")
    # all agents share one GitHub account, so the Reviewer posts its verdict as a comment (first line = verdict)
    sh('gh pr comment 4 --body "Review: approved\nChecked: contract, tests, security. CI is green."')
    sh('gh pr comment 5 --body "Review: approved\nChecked: contract, tests, security. CI is green."')
    sh("gh pr merge 4 --squash --delete-branch")
    sh("gh pr merge 5 --squash --delete-branch")

    skill("sdlc-qa")
    tool("write_file", {"path": WS + "/project.json", "content": state(repo_url=f"https://github.com/{REPO}", staging_url="https://tip-calculator-git-main.vercel.app")})
    sh('gh issue create --title "Custom tip of 0 shows NaN" --label bug --body "Steps..."', f"https://github.com/{REPO}/issues/3")
    tool("write_file", {"path": "docs/QA.md", "content": "QA result: failed (round 1)\n\n| ID | How | Result | Evidence |\n| --- | --- | --- | --- |\n| BR-01 | typed 20 | Pass | t |\n| BR-02 | custom tip 0 | Fail | t |\n"})
    tool("write_file", {"path": "docs/QA.md", "content": "QA result: passed (round 2)\n\n| ID | How | Result | Evidence |\n| --- | --- | --- | --- |\n| BR-01 | typed 20 | Pass | t |\n| BR-02 | custom tip 0 | Pass | t |\n"})

    skill("sdlc-release")
    sh("vercel deploy --prod --yes", "Inspect: https://vercel.com/x/y\nProduction: https://tip-calculator.vercel.app [4s]\n")
    tool("write_file", {"path": "README.md", "content": "# Tip calculator"})
    tool("write_file", {"path": WS + "/project.json", "content": state(
        repo_url=f"https://github.com/{REPO}", staging_url="https://tip-calculator-git-main.vercel.app", production_url="https://tip-calculator.vercel.app", release_number=1)})
    reply("Your site is live: https://tip-calculator.vercel.app\nYou can ask for changes on the website.")

    p.time = real_time
    if not p.flush(10):
        raise SystemExit("the plugin did not finish writing")
    lines = (tmp / "events.jsonl").read_text().splitlines()
    return [json.loads(x) for x in lines]


def main() -> int:
    text = json.dumps(build(), indent=1) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"{OUT} is out of date. Run: python3 hermes/tools/make_fixture_v2.py", file=sys.stderr)
            return 1
        print("fixture is up to date")
        return 0
    OUT.write_text(text)
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
