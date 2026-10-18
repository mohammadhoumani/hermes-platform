"""Devin poller tests: a mock Devin API on 127.0.0.1 (no real network, no real key).

Run:  python3 -m unittest hermes.tests.test_devin_poller   or   python3 -m unittest discover -s hermes/tests
"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "devin"))

import devin_poller as dp  # noqa: E402

KEY = "cog_test_not_a_real_key"
PR = "https://github.com/acme/calc/pull/6"


class MockDevin:
    """Scripted answers per path. A list is used one by one; the last one repeats."""

    def __init__(self):
        self.script = {}
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.requests.append((self.path, self.headers.get("Authorization")))
                answers = outer.script.get(self.path)
                if not answers:
                    code, body, extra = 404, {"detail": "not found"}, {}
                else:
                    code, body, *rest = answers[0] if len(answers) == 1 else answers.pop(0)
                    extra = rest[0] if rest else {}
                raw = json.dumps(body).encode()
                self.send_response(code)
                for k, v in extra.items():
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def v1(status_enum, pr=None):
    return (200, {"session_id": "x", "status_enum": status_enum, "pull_request": {"url": pr} if pr else None})


class PollerTest(unittest.TestCase):
    def setUp(self):
        self.api = MockDevin()
        self.addCleanup(self.api.close)
        self.tmp = Path(tempfile.mkdtemp(prefix="hp-devin-"))
        self.sessions = self.tmp / "devin_sessions.json"
        self.events = []
        self.logs = []

    def add(self, *lines):
        with open(self.sessions, "a", encoding="utf-8") as f:
            for line in lines:
                f.write(json.dumps(line) + "\n")

    def poller(self, **kw):
        kw.setdefault("base_url", self.api.url)
        kw.setdefault("log", lambda *a: self.logs.append(" ".join(str(x) for x in a)))
        return dp.DevinPoller(KEY, self.sessions, self.events.append, state_file=self.tmp / "state.json", **kw)

    # ---- reading the sessions file ----
    def test_read_sessions_formats(self):
        self.sessions.write_text('{"session_id":"devin-aaa","project_id":"p1","task":"T3"}\nnot json\n{"session_id":"../bad"}\n"devin-bbb"\n')
        got = dp.read_sessions(self.sessions)
        self.assertEqual([s["session_id"] for s in got], ["devin-aaa", "devin-bbb"])
        self.assertEqual(got[0]["project_id"], "p1")
        self.sessions.write_text(json.dumps({"sessions": [{"session_id": "devin-ccc"}, {"id": "devin-ddd"}]}))
        self.assertEqual([s["session_id"] for s in dp.read_sessions(self.sessions)], ["devin-ccc", "devin-ddd"])
        self.sessions.write_text(json.dumps([{"session_id": "devin-eee"}]))
        self.assertEqual([s["session_id"] for s in dp.read_sessions(self.sessions)], ["devin-eee"])
        self.sessions.write_text(json.dumps({"session_id": "devin-fff"}))
        self.assertEqual([s["session_id"] for s in dp.read_sessions(self.sessions)], ["devin-fff"])
        self.assertEqual(dp.read_sessions(self.tmp / "missing.json"), [])

    def test_normalize_status(self):
        for raw, want in [("working", "working"), ("blocked", "blocked"), ("finished", "finished"), ("expired", "failed"),
                          ("suspend_requested", "suspended"), ("exit", "finished"), ("error", "failed"), ("", "unknown"),
                          ("something_new", "working")]:
            self.assertEqual(dp.normalize_status(raw), want, raw)

    # ---- polling ----
    def test_emits_on_change_only_and_stops_after_finish(self):
        self.add({"session_id": "devin-abc", "project_id": "proj-1", "task": "Task 3"})
        self.api.script["/v1/sessions/devin-abc"] = [v1("working"), v1("working"), v1("working", PR), v1("finished", PR), v1("finished", PR)]
        p = self.poller()
        p.poll_once()
        p.poll_once()  # same status: nothing new
        p.poll_once()  # pull request appears
        p.poll_once()  # finished
        n = len(self.api.requests)
        p.poll_once()  # done: no more requests
        self.assertEqual(len(self.api.requests), n)
        self.assertEqual([(e["status"], e["pr"]) for e in self.events], [("working", None), ("working", PR), ("finished", PR)])
        last = self.events[-1]
        self.assertEqual((last["type"], last["sid"], last["session_id"], last["project"], last["pr_url"], last["finished"]),
                         ("devin_status", "devin-abc", "devin-abc", "proj-1", PR, True))
        self.assertEqual(last["v"], 1)
        self.assertIn("Task 3", last["text"])

    def test_sends_bearer_key_to_the_v1_path_and_never_puts_it_in_events(self):
        self.add({"session_id": "devin-abc"})
        self.api.script["/v1/sessions/devin-abc"] = [v1("working")]
        self.poller().poll_once()
        self.assertEqual(self.api.requests, [("/v1/sessions/devin-abc", "Bearer " + KEY)])
        self.assertNotIn(KEY, json.dumps(self.events))
        self.assertNotIn(KEY, "\n".join(self.logs))

    def test_v3_is_used_for_cog_key_with_org_id(self):
        self.add({"session_id": "devin-abc"})
        self.api.script["/v3/organizations/org-1/sessions/devin-abc"] = [(200, {"status": "running", "pull_requests": [{"pr_url": PR, "pr_state": "open"}]})]
        p = self.poller(org_id="org-1")
        self.assertEqual(p.api_version, "v3")
        p.poll_once()
        self.assertEqual((self.events[0]["status"], self.events[0]["pr"]), ("working", PR))
        self.assertEqual(self.poller().api_version, "v1")

    def test_skips_sessions_of_projects_that_are_not_running(self):
        self.add({"session_id": "devin-run", "project_id": "p-run"}, {"session_id": "devin-old", "project_id": "p-old"},
                 {"session_id": "devin-free"})
        for s in ("run", "old", "free"):
            self.api.script["/v1/sessions/devin-" + s] = [v1("working")]
        bridge = self.tmp / "bridge_state.json"
        bridge.write_text(json.dumps({"projects": {"p-run": {"status": "development"}, "p-old": {"status": "released"}}}))
        self.poller(is_active=dp.active_projects_from_bridge_state(bridge)).poll_once()
        asked = sorted(r[0] for r in self.api.requests)
        self.assertEqual(asked, ["/v1/sessions/devin-free", "/v1/sessions/devin-run"])

    def test_not_found_is_reported_once(self):
        self.add({"session_id": "devin-gone"})
        p = self.poller()
        p.poll_once()
        p.poll_once()
        self.assertEqual([(e["status"], e["finished"]) for e in self.events], [("unknown", False)])
        self.assertEqual(len(self.api.requests), 1)

    def test_auth_error_is_logged_once_and_retried(self):
        self.add({"session_id": "devin-abc"})
        self.api.script["/v1/sessions/devin-abc"] = [(401, {"detail": "bad key"}), (401, {"detail": "bad key"}), v1("working")]
        p = self.poller()
        p.poll_once()
        p.poll_once()
        self.assertEqual(self.events, [])
        self.assertEqual(len(self.logs), 1)
        self.assertIn("401", self.logs[0])
        p.poll_once()
        self.assertEqual([e["status"] for e in self.events], ["working"])

    def test_server_error_does_not_stop_other_sessions(self):
        self.add({"session_id": "devin-bad"}, {"session_id": "devin-good"})
        self.api.script["/v1/sessions/devin-bad"] = [(500, {})]
        self.api.script["/v1/sessions/devin-good"] = [v1("blocked")]
        self.poller().poll_once()
        self.assertEqual([(e["sid"], e["status"]) for e in self.events], [("devin-good", "blocked")])

    def test_redirects_are_not_followed(self):
        self.add({"session_id": "devin-abc"})
        self.api.script["/v1/sessions/devin-abc"] = [(302, {}, {"Location": self.api.url + "/elsewhere"})]
        self.poller().poll_once()
        self.assertEqual(self.events, [])
        self.assertNotIn("/elsewhere", [r[0] for r in self.api.requests])

    def test_a_failing_callback_is_retried_next_cycle(self):
        self.add({"session_id": "devin-abc"})
        self.api.script["/v1/sessions/devin-abc"] = [v1("working")]
        calls = []

        def emit(ev):
            calls.append(ev)
            if len(calls) == 1:
                raise RuntimeError("boom")

        p = dp.DevinPoller(KEY, self.sessions, emit, base_url=self.api.url, state_file=self.tmp / "state.json", log=lambda *a: None)
        p.poll_once()
        p.poll_once()
        self.assertEqual(len(calls), 2)

    def test_state_survives_a_restart(self):
        self.add({"session_id": "devin-abc"})
        self.api.script["/v1/sessions/devin-abc"] = [v1("working", PR)]
        self.poller().poll_once()
        self.poller().poll_once()  # a new object, same state file
        self.assertEqual(len(self.events), 1)

    def test_pull_request_address_must_be_https(self):
        self.assertIsNone(dp.extract_pr({"pull_request": {"url": "javascript:alert(1)"}}))
        self.assertIsNone(dp.extract_pr({"pull_request": {"url": "http://example.com/pull/1"}}))
        self.assertEqual(dp.extract_pr({"pull_request": {"url": PR}}), PR)

    # ---- command line ----
    def test_cli_once_appends_json_lines(self):
        self.add({"session_id": "devin-abc", "project_id": "p1"})
        self.api.script["/v1/sessions/devin-abc"] = [v1("finished", PR)]
        out = self.tmp / "events.jsonl"
        env = {"DEVIN_API_KEY": KEY, "HERMES_HOME": str(self.tmp)}
        with mock.patch.dict(os.environ, env):
            rc = dp.main(["--once", "--sessions-file", str(self.sessions), "--state-file", str(self.tmp / "s2.json"),
                          "--base-url", self.api.url, "--events-file", str(out)])
        self.assertEqual(rc, 0)
        ev = json.loads(out.read_text().splitlines()[0])
        self.assertEqual((ev["type"], ev["status"], ev["pr"], ev["project"]), ("devin_status", "finished", PR, "p1"))

    def test_cli_needs_a_key(self):
        with mock.patch.dict(os.environ, {"DEVIN_API_KEY": ""}), mock.patch.object(sys, "stderr", new=open(os.devnull, "w")):
            self.assertEqual(dp.main(["--once", "--sessions-file", str(self.sessions)]), 2)


if __name__ == "__main__":
    unittest.main()
