#!/usr/bin/env python3
"""Fake a full SDLC pipeline run through the real agent-room plugin hooks.

Use it to check the dashboard without spending a real Hermes run:
    python3 simulate_run.py                 # writes to ~/.hermes/agent-room/events.jsonl
    python3 simulate_run.py --speed 3       # faster
    AGENT_ROOM_EVENTS=/tmp/ev.jsonl python3 simulate_run.py

Every event it writes is marked "sim": true.
"""

import argparse
import importlib.util
import os
import sys
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--speed", type=float, default=1.0, help="higher is faster")
ap.add_argument("--plugin", default=None, help="path to the agent-room plugin folder")
opt = ap.parse_args()

here = Path(__file__).resolve().parent
candidates = [opt.plugin, here.parent / "plugin" / "agent-room", Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "plugins" / "agent-room"]
plugin_dir = next(Path(c) for c in candidates if c and (Path(c) / "__init__.py").exists())
spec = importlib.util.spec_from_file_location("agent_room_sim", plugin_dir / "__init__.py")
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)

_orig_emit = ar._emit
ar._emit = lambda t, **f: _orig_emit(t, sim=True, **f)


class Ctx:
    hooks = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn


ctx = Ctx()
ar.register(ctx)
H = ctx.hooks
MAIN = "sim-main"
REPO = "hermesagenttabbeqai/tip-calculator"
n = 0


def wait(s=0.6):
    time.sleep(s / opt.speed)


def tool(name, args, result="ok", sid=MAIN, status="ok", pause=0.5):
    global n
    n += 1
    call = f"call-{n}"
    H["pre_tool_call"](tool_name=name, args=args, session_id=sid, tool_call_id=call)
    wait(pause)
    H["post_tool_call"](tool_name=name, args=args, result=result, session_id=sid, tool_call_id=call, status=status, duration_ms=int(pause * 1000))
    wait(0.15)


def sh(cmd, result="", sid=MAIN, pause=0.5):
    tool("terminal", {"command": cmd}, result=result, sid=sid, pause=pause)


def user(text):
    H["pre_llm_call"](session_id=MAIN, user_message=text, platform="telegram", sender_id="6542600442", is_first_turn=False)
    wait(0.8)


def reply(text):
    H["post_llm_call"](session_id=MAIN, assistant_response=text, platform="telegram")
    wait(1.0)


def skill(name):
    tool("skill_view", {"name": name}, pause=0.3)
    H["on_skill_lifecycle"](action="loaded", skill_name=name, session_id=MAIN)


H["on_session_start"](session_id=MAIN, platform="telegram", model="claude-sim")
user("/sdlc-project tip-calculator: a web app that works out the tip and splits the bill")
skill("sdlc-project")
sh(f"gh repo create {REPO} --public --template hermesagenttabbeqai/hermes-project-template --clone", f"https://github.com/{REPO}")
reply("Created tip-calculator from the template. Starting requirements.")

skill("sdlc-requirements")
reply("Which tip percentages should be preset?")
user("10, 15, 20 and a custom amount")
reply("How many people can split one bill?")
user("1 to 20 people")
tool("write_file", {"path": "docs/BRD.md", "content": "# BRD\nBR-01 ..."})
sh('git add docs/BRD.md && git commit -m "docs: add BRD (BR-01..BR-05, NFR-01..02)" && git push origin main')
reply("BRD ready: 5 business requirements and 2 non-functional ones. Reply Approve to pass gate G1.")
user("Approve")
tool("patch", {"path": "docs/approvals.md", "old_string": "", "new_string": "| G1 | Requirements | Approved by Mohammad | 2026-10-16 |"})
sh('git commit -am "Record G1 approval" && git push')

skill("sdlc-planning")
tool("write_file", {"path": "PLAN.md", "content": "# Plan\n1. form\n2. logic\n3. styles"})
sh('gh issue create --title "Input form" --body "Task 1"', f"https://github.com/{REPO}/issues/1")
sh('gh issue create --title "Tip logic" --body "Task 2"', f"https://github.com/{REPO}/issues/2")
sh('gh issue create --title "Styles" --body "Task 3"', f"https://github.com/{REPO}/issues/3")
sh(f"gh api -X PUT repos/{REPO}/branches/main/protection --input protection.json")
reply("Plan ready: 3 tasks, 3 issues, main is protected. Reply Approve for gate G2.")
user("Approve")
tool("patch", {"path": "docs/approvals.md", "old_string": "", "new_string": "| G2 | Plan | Approved by Mohammad | 2026-10-16 |"})

skill("sdlc-development")
goals = [
    ("sim-dev-a", "Task #1 input form. Work on branch feature/tip-input-form", "feature/tip-input-form", "Input form", 4),
    ("sim-dev-b", "Task #2 tip logic. Work on branch feature/tip-calc-logic", "feature/tip-calc-logic", "Tip logic", 5),
    ("sim-dev-c", "Task #3 styles. Work on branch feature/split-bill-styles", "feature/split-bill-styles", "Styles", 6),
]
H["pre_tool_call"](tool_name="delegate_task", args={"tasks": [{"goal": g[1]} for g in goals]}, session_id=MAIN, tool_call_id="deleg-1")
for sid, goal, *_ in goals:
    H["subagent_start"](parent_session_id=MAIN, parent_turn_id="t", parent_subagent_id=None, child_session_id=sid, child_subagent_id=sid, child_role=None, child_goal=goal)
    wait(0.3)
for sid, goal, br, title, pr in goals:
    H["pre_llm_call"](session_id=sid, user_message=goal, platform="telegram", is_first_turn=True)
for step in range(3):
    for sid, goal, br, title, pr in goals:
        if step == 0:
            tool("write_file", {"path": f"src/{title.lower().replace(' ', '-')}.js", "content": "..."}, sid=sid, pause=0.4)
        elif step == 1:
            sh(f'git commit -am "feat: {title.lower()}" && git push -u origin {br}', sid=sid, pause=0.4)
        else:
            sh(f'gh pr create --title "{title}" --head {br} --body "Closes #{pr - 3}"', f"https://github.com/{REPO}/pull/{pr}", sid=sid, pause=0.4)
for sid, goal, br, title, pr in goals:
    sh(f"gh pr checks {pr} --watch", "test\tpass\t14s", sid=sid, pause=0.6)
for sid, goal, br, title, pr in goals:
    H["subagent_stop"](parent_session_id=MAIN, parent_turn_id="t", child_session_id=sid, child_role=None,
                       child_summary=f"{title} done, PR #{pr} open, CI green", child_status="completed",
                       tool_call_history=[{"tool_name": "write_file", "tool_input": {"targets": {"path": f"src/{title}.js"}}}], duration_ms=90000)
    wait(0.4)
H["post_tool_call"](tool_name="delegate_task", args={}, result="3 done", session_id=MAIN, tool_call_id="deleg-1", status="ok", duration_ms=1)

skill("sdlc-review")
sh('gh pr review 4 --approve --body "Looks good"')
sh('gh pr review 6 --approve --body "Looks good"')
sh('gh pr review 5 --request-changes --body "Totals must round to 2 decimals (NFR-02)"')
H["subagent_start"](parent_session_id=MAIN, parent_turn_id="t2", parent_subagent_id=None, child_session_id="sim-fix", child_subagent_id="sim-fix",
                    child_role=None, child_goal="Fix rounding on PR #5, branch feature/tip-calc-logic")
wait(0.4)
sh('git commit -am "fix: round totals to 2 decimals" && git push', sid="sim-fix")
sh("gh pr checks 5", "test\tpass\t12s", sid="sim-fix")
H["subagent_stop"](parent_session_id=MAIN, parent_turn_id="t2", child_session_id="sim-fix", child_role=None,
                   child_summary="Rounding fixed, test added", child_status="completed", tool_call_history=[], duration_ms=30000)
sh('gh pr review 5 --approve --body "Fixed"')
reply("All 3 PRs are approved and green. Reply Approve to merge them (gate G3).")
user("Approve")
tool("patch", {"path": "docs/approvals.md", "old_string": "", "new_string": "| G3 | Merge | Approved by Mohammad | 2026-10-16 |"})
for pr in (4, 5, 6):
    sh(f"gh pr merge {pr} --squash --delete-branch", pause=0.4)

skill("sdlc-release")
tool("write_file", {"path": "README.md", "content": "# Tip calculator"})
sh('gh pr create --title "docs: README and user guide" --head docs/readme', f"https://github.com/{REPO}/pull/7")
sh("gh pr merge 7 --squash")
sh(f"gh api repos/{REPO}/pages", '{"html_url": "https://hermesagenttabbeqai.github.io/tip-calculator/"}')
reply("Done. Live at https://hermesagenttabbeqai.github.io/tip-calculator/")
time.sleep(0.8)
print("Simulated run written to", ar._events_path())
if ar._cloud.enabled():
    ok = ar._cloud.flush()
    print("Sent to Supabase:", ar._cloud.sent, "events" if ok else f"(not all sent: {ar._cloud.last_error})")
else:
    print("Supabase is not set up in config.json, so nothing was sent to the cloud.")
