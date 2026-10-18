"""Plugin v2 (hermes-platform): redaction, new actions, project marker, sending to platform_ingest, legacy mirror."""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock as umock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from mock_platform import KEY, WRITE, MockPlatform  # noqa: E402

PLUGIN = ROOT / "plugin" / "hermes-platform" / "__init__.py"
PID = "11111111-2222-4333-8444-555555555555"


def load(name="hp_plugin_under_test"):
    spec = importlib.util.spec_from_file_location(name, PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class PluginCase(unittest.TestCase):
    cloud = False

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hp-plugin-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        env = {"HERMES_HOME": str(self.tmp), "HERMES_PLATFORM_EVENTS": str(self.tmp / "events.jsonl")}
        for k in list(os.environ):
            if k.startswith("HERMES_PLATFORM_"):
                env.setdefault(k, "")
        self.mock = None
        if self.cloud:
            self.mock = MockPlatform().start()
            self.addCleanup(self.mock.stop)
            env.update(HERMES_PLATFORM_SUPABASE_URL=self.mock.url, HERMES_PLATFORM_SUPABASE_KEY=KEY, HERMES_PLATFORM_WRITE_KEY=WRITE)
        patcher = umock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.p = load()

    def events(self):
        self.assertTrue(self.p.flush(10))
        path = self.tmp / "events.jsonl"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def tool_actions(self, tool, args, result="", status="ok"):
        self.p.HOOKS["post_tool_call"](tool_name=tool, args=args, result=result, session_id="s1", tool_call_id="c1", status=status, duration_ms=5)
        ends = [e for e in self.events() if e["type"] == "tool_end"]
        return ends[-1].get("actions", [])


class TestClassify(PluginCase):
    def test_redaction(self):
        r = self.p.redact
        fake = {
            "github": "ghp_" + "a" * 36, "pat": "github_pat_" + "B" * 30, "openai": "sk-" + "c" * 24,
            "jwt": "eyJ" + "a" * 12 + "." + "b" * 12 + "." + "c" * 12, "bearer": "Bearer " + "x" * 20,
            "supa": "sb_secret_" + "z" * 20, "devin": "apk_" + "q" * 20, "cog": "cog_" + "k" * 24,
        }
        for name, val in fake.items():
            self.assertNotIn(val, r(f"token is {val} ok"), name)
        self.assertEqual(r("WRITE_KEY=abc123 and SUPABASE_SERVICE_ROLE: foo"), "WRITE_KEY=[redacted] and SUPABASE_SERVICE_ROLE:[redacted]")
        self.assertIn("API_KEY=[redacted]", r('API_KEY="secret value"'))
        self.assertEqual(r("plain text"), "plain text")

    def test_project_marker_and_skills_in_turn_start(self):
        self.p.HOOKS["pre_llm_call"](session_id="s1", user_message=f"/sdlc-orchestrator build a tip app\n\n(This order came from the Hermes website. Load sdlc-ba later.)\n\n(hermes-project:{PID})", platform="api_server")
        ev = [e for e in self.events() if e["type"] == "turn_start"][0]
        self.assertEqual(ev["project"], PID)
        self.assertNotIn("hermes-project", ev["text"])
        self.assertEqual(ev["skills"], ["sdlc-ba", "sdlc-orchestrator"])
        self.p.HOOKS["pre_llm_call"](session_id="s1", user_message="/sdlc-requirements old style and sdlc-change-request", platform="api_server")
        ev = [e for e in self.events() if e["type"] == "turn_start"][1]
        self.assertEqual(ev["skills"], ["sdlc-change-request", "sdlc-requirements"])
        self.assertNotIn("project", ev)

    def test_skill_events_have_a_phase_and_are_not_doubled(self):
        h = self.p.HOOKS
        h["post_tool_call"](tool_name="skill_view", args={"name": "sdlc-qa"}, result="ok", session_id="s1", status="ok")
        h["on_skill_lifecycle"](action="loaded", skill_name="sdlc-qa", session_id="s1")
        h["on_skill_lifecycle"](action="loaded", skill_name="sdlc-planning", session_id="s1")
        skills = [e for e in self.events() if e["type"] == "skill"]
        self.assertEqual([(e["name"], e["phase"]) for e in skills], [("sdlc-qa", "qa"), ("sdlc-planning", "architecture")])
        for old, phase in (("sdlc-project", "kickoff"), ("sdlc-requirements", "discovery"), ("sdlc-release", "release")):
            self.assertEqual(self.p.SKILL_STAGE[old], phase)
        self.assertEqual(set(self.p.SKILL_STAGE), set(self.p.SDLC_SKILLS))

    def test_sync_comment_protocol(self):
        a = self.tool_actions("terminal", {"command": 'gh issue comment 1 --body "BLOCKER: task 2 -> task 1\nneed the date format, token=abc123secret"'})
        self.assertEqual(len(a), 1)
        self.assertEqual((a[0]["action"], a[0]["kind"], a[0]["from"], a[0]["to"], a[0]["issue"]), ("sync", "blocker", "task 2", "task 1", "1"))
        self.assertIn("need the date format", a[0]["text"])
        self.assertNotIn("abc123secret", a[0]["text"])
        a = self.tool_actions("terminal", {"command": "gh issue comment 1 -b 'READY: task 3 -> all\nshared types are on main'"})
        self.assertEqual((a[0]["kind"], a[0]["from"], a[0]["to"]), ("ready", "task 3", "all"))
        a = self.tool_actions("terminal", {"command": "gh issue comment 1 --body \"$(cat <<'EOF'\nINTERFACE: task 1 -> task 2\nformatDate(d: Date): string\nEOF\n)\""})
        self.assertEqual((a[0]["kind"], a[0]["from"], a[0]["to"]), ("interface", "task 1", "task 2"))
        self.assertIn("formatDate", a[0]["text"])

    def test_comment_on_the_team_sync_issue_without_the_protocol(self):
        a = self.tool_actions("terminal", {"command": 'gh issue create --title "Team sync" --body "post here"'}, "https://github.com/bot/x/issues/7")
        self.assertEqual((a[0]["action"], a[0].get("number"), a[0].get("sync")), ("issue", "7", True))
        a = self.tool_actions("terminal", {"command": 'gh issue comment 7 --body "Heads up: I renamed the helper"'})
        self.assertEqual([x["action"] for x in a], ["sync"])
        self.assertEqual(a[0]["kind"], "note")
        a = self.tool_actions("terminal", {"command": 'gh issue comment 9 --body "Heads up: unrelated issue"'})
        self.assertEqual(a, [])

    def test_bug_label_on_issue(self):
        a = self.tool_actions("terminal", {"command": 'gh issue create --title "Total wrong" --label bug --body x'})
        self.assertEqual((a[0]["action"], a[0]["label"]), ("issue", "bug"))

    def test_qa_result_from_qa_md(self):
        a = self.tool_actions("write_file", {"path": "docs/QA.md", "content": "QA result: passed\n\nDate 2026-10-18\n"})
        self.assertEqual((a[0]["action"], a[0]["outcome"]), ("qa_result", "passed"))
        table = "QA result: failed (round 2)\n\n| ID | How | Result | Evidence |\n| --- | --- | --- | --- |\n| BR-01 | typed | Pass | t |\n| BR-02 | typed | Fail | t |\n| BR-03 | typed | Fail | t |\n"
        a = self.tool_actions("write_file", {"path": "docs/QA.md", "content": table})
        self.assertEqual((a[0]["outcome"], a[0]["round"], a[0]["bugs"]), ("failed", 2, 2))
        a = self.tool_actions("write_file", {"path": "docs/QA.md", "content": "# QA\nnotes only"})
        self.assertEqual(a[0]["action"], "docs")

    def test_state_file_gives_repo_and_deploy_links(self):
        content = json.dumps({"repo_path": "/x/repo", "repo_url": "https://github.com/bot/tip-calc.git", "staging_url": "https://tip-git-main.vercel.app", "production_url": "https://tip.vercel.app"})
        a = self.tool_actions("write_file", {"path": "/home/ubuntu/.hermes/platform/workspaces/abc/project.json", "content": content})
        self.assertEqual([(x["action"], x.get("env"), x.get("repo")) for x in a], [("repo", None, "bot/tip-calc"), ("deploy", "staging", None), ("deploy", "production", None)])
        self.assertEqual(a[2]["url"], "https://tip.vercel.app")
        a = self.tool_actions("patch", {"path": "project.json", "new_string": '"production_url": "https://tip.vercel.app", "release_number": 2'})
        self.assertEqual([(x["env"], x["url"]) for x in a], [("production", "https://tip.vercel.app")])

    def test_deploy_links_from_command_output(self):
        a = self.tool_actions("terminal", {"command": "vercel deploy --prod --yes"}, "Inspect: https://vercel.com/x\nProduction: https://tip-calc.vercel.app [3s]\n")
        self.assertEqual([(x["action"], x["env"], x["url"]) for x in a], [("deploy", "production", "https://tip-calc.vercel.app")])
        a = self.tool_actions("terminal", {"command": "vercel deploy --yes"}, "Preview: https://tip-calc-abc123.vercel.app [2s]")
        self.assertEqual([(x["env"]) for x in a], ["staging"])
        gh = json.dumps([{"environment": "Production", "environment_url": "https://tip.vercel.app", "state": "success"},
                         {"environment": "Preview", "environment_url": "https://tip-git-main.vercel.app", "state": "success"}])
        a = self.tool_actions("terminal", {"command": "gh api repos/bot/x/deployments/1/statuses"}, gh)
        self.assertEqual({(x["env"], x["url"]) for x in a}, {("production", "https://tip.vercel.app"), ("staging", "https://tip-git-main.vercel.app")})
        a = self.tool_actions("terminal", {"command": "curl https://example.com"}, "https://tip.vercel.app")
        self.assertEqual(a, [])
        a = self.tool_actions("terminal", {"command": "vercel deploy --prod"}, "Error: failed", status="error")
        self.assertEqual(a, [])

    def test_devin_mcp_calls(self):
        res = json.dumps({"session_id": "devin-0123456789ab", "url": "https://app.devin.ai/sessions/0123456789ab"})
        a = self.tool_actions("mcp_devin_devin_session_create", {"title": "Styles", "prompt": "do it with key apk_" + "x" * 20, "max_acu_limit": 5}, res)
        self.assertEqual((a[0]["action"], a[0]["op"], a[0]["session"], a[0]["max_acu"]), ("devin", "create", "devin-0123456789ab", 5))
        self.assertEqual(a[0]["task"], "Styles")
        self.assertIn("app.devin.ai", a[0]["url"])
        a = self.tool_actions("mcp_devin_devin_session_interact", {"session_id": "devin-0123456789ab", "message": "Use the contract. token: abc999"}, "sent")
        self.assertEqual((a[0]["op"], a[0]["session"]), ("interact", "devin-0123456789ab"))
        self.assertNotIn("abc999", a[0]["text"])
        a = self.tool_actions("mcp_devin_devin_session_create", {"prompt": "x"}, "Error: no credits", status="error")
        self.assertTrue(a[0]["failed"])
        a = self.tool_actions("mcp_devin_devin_session_events", {"session_id": "devin-0123456789ab"}, "[]")
        self.assertEqual(a[0]["op"], "check")

    def test_old_actions_still_work(self):
        a = self.tool_actions("terminal", {"command": 'git add . && git commit -m "feat: x" && git push origin main'})
        self.assertEqual([x["action"] for x in a], ["commit", "push"])
        a = self.tool_actions("terminal", {"command": "gh pr create --title T --head feature/x"}, "https://github.com/o/r/pull/12")
        self.assertEqual((a[0]["action"], a[0]["pr"]), ("pr_open", "12"))
        a = self.tool_actions("terminal", {"command": "gh pr review 12 --request-changes --body 'round it'"})
        self.assertEqual(a[0]["verdict"], "changes")
        a = self.tool_actions("write_file", {"path": "docs/BRD.md", "content": "x"})
        self.assertEqual(a[0]["action"], "brd")

    def test_hooks_never_raise_or_block(self):
        h = self.p.HOOKS
        self.assertIsNone(h["pre_tool_call"](tool_name="terminal", args="not a dict", session_id="s"))
        self.assertIsNone(h["post_tool_call"](tool_name="terminal", args=None, result=object(), session_id="s"))
        self.assertIsNone(h["post_tool_call"](tool_name="write_file", args={"path": None}, result=None, session_id="s"))
        self.assertIsNone(h["pre_llm_call"](session_id="s", user_message=None))
        self.assertIsNone(h["pre_llm_call"](session_id="s", user_message={"a": 1}))
        self.assertIsNone(h["subagent_stop"](parent_session_id="p", child_session_id="c", tool_call_history="oops"))
        self.assertTrue(self.p.flush(5))

    def test_message_text_is_redacted_and_clipped(self):
        secret = "ghp_" + "z" * 36
        self.p.HOOKS["post_llm_call"](session_id="s1", assistant_response=f"here {secret} " + "word " * 400, platform="api_server")
        ev = [e for e in self.events() if e["type"] == "turn_end"][0]
        self.assertNotIn(secret, ev["text"])
        self.assertLessEqual(len(ev["text"]), 600)


class TestSending(PluginCase):
    cloud = True

    def test_events_go_to_platform_ingest(self):
        pid = self.mock.add_project("Demo")
        self.mock.rpc_platform_map_session({"write_key": WRITE, "session_id": "s1", "project_id": pid})
        self.p.register(type("Ctx", (), {"register_hook": lambda self, n, f: None})())
        self.p.HOOKS["pre_llm_call"](session_id="s1", user_message="hello", platform="api_server")
        self.p.HOOKS["post_llm_call"](session_id="s1", assistant_response="hi", platform="api_server")
        self.assertTrue(self.p.flush(10))
        got = self.mock.events_of(pid)
        self.assertEqual([e["type"] for e in got], ["turn_start", "turn_end"])
        self.assertEqual(self.mock.legacy, [])  # no legacy mirror unless configured
        self.assertEqual(self.p._cloud.last_error, None)
        names = [n for n, _ in self.mock.calls]
        self.assertIn("platform_ingest", names)
        self.assertNotIn("agent_room_ingest", names)

    def test_events_wait_for_a_down_server_and_arrive_later(self):
        pid = self.mock.add_project("Demo")
        self.mock.rpc_platform_map_session({"write_key": WRITE, "session_id": "s2", "project_id": pid})
        self.mock.fail_next = 2
        self.p.HOOKS["pre_llm_call"](session_id="s2", user_message="hello", platform="api_server")
        self.assertTrue(self.p.flush(30))
        self.assertEqual(len(self.mock.events_of(pid)), 1)

    def test_legacy_mirror_is_optional_and_separate(self):
        cfg = {"legacy": {"supabase_url": self.mock.url, "supabase_key": KEY, "write_key": WRITE}}
        (self.tmp / "platform").mkdir()
        (self.tmp / "platform" / "config.json").write_text(json.dumps(cfg))
        p2 = load("hp_plugin_legacy")
        p2.HOOKS["pre_llm_call"](session_id="s3", user_message="hello legacy", platform="api_server")
        self.assertTrue(p2.flush(10))
        self.assertEqual([e["type"] for e in self.mock.legacy], ["turn_start"])
        self.assertEqual(self.mock.legacy[0]["text"], "hello legacy")

    def test_local_file_is_written_even_without_cloud_settings(self):
        with umock.patch.dict(os.environ, {"HERMES_PLATFORM_SUPABASE_URL": "", "HERMES_PLATFORM_WRITE_KEY": ""}):
            p3 = load("hp_plugin_local")
            p3.HOOKS["pre_llm_call"](session_id="s4", user_message="local only", platform="api_server")
            self.assertTrue(p3.flush(10))
        lines = (self.tmp / "events.jsonl").read_text().splitlines()
        self.assertTrue(any("local only" in x for x in lines))


if __name__ == "__main__":
    unittest.main()
