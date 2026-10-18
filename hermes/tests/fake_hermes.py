"""In-process stand-in for the Hermes API server, with a scripted "team" behind it.

Every run fires the REAL hermes-platform plugin hooks, so events go plugin -> events.jsonl (read by the
bridge) and plugin -> mock Supabase (platform_ingest), like on the real server. The team follows the v2 skills:

    start prompt   -> orchestrator + BA: repo, docs/BRD.md, project.json, asks for approval
    BRD changes    -> BA rewrites docs/BRD.md, asks again
    approval       -> architect, Team sync, Devin call, development with two helpers (reply says they run in the background)
    "Continue ..." -> 1st: review + QA (QA.md); 2nd: release (project.json production_url) and "Your site is live"
    change request -> change-request, development, review, QA, release in one run (release_number + 1)

Faults for tests: brain.faults["build"] = ["limit"] makes the next "build" run fail with a usage-limit message.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

KEY = "api-test"
LIVE = "https://tip-calc.example.test/"
STAGING = "https://tip-calc-git-main.example.test/"


class Run:
    def __init__(self, fh, rid, text, session):
        self.fh, self.id, self.input, self.session = fh, rid, text, session
        # the id the plugin hooks see; fh.alias_sessions simulates a Hermes that does not reuse our session id
        self.sid = ("hermes-internal-" + session) if fh.alias_sessions else session
        self.data = {"status": "running", "output": None, "error": None, "approval": None, "choice": None}

    # ---- status ----
    def complete(self, text):
        with self.fh.lock:
            if self.data["status"] != "cancelled":
                self.data.update(status="completed", output=text, approval=None)

    def fail(self, error):
        with self.fh.lock:
            if self.data["status"] != "cancelled":
                self.data.update(status="failed", error=error, approval=None)

    def cancelled(self):
        return self.data["status"] == "cancelled"

    def ask_approval(self, command, description=""):
        with self.fh.lock:
            self.data.update(status="waiting_for_approval", approval={"request_id": "req-" + uuid.uuid4().hex[:6], "command": command, "description": description})
        for _ in range(200):
            time.sleep(0.02)
            with self.fh.lock:
                if self.data["choice"]:
                    c = self.data["choice"]
                    self.data.update(status="running", approval=None, choice=None)
                    self.fh.approvals.append((command, c))
                    return c
        return None

    def hang(self, seconds=15):
        end = time.time() + seconds
        while time.time() < end and not self.cancelled():
            time.sleep(0.02)

    # ---- plugin hooks ----
    def hook(self, name, **kw):
        self.fh.plugin.HOOKS[name](**kw)

    def tool(self, name, args, result="ok", sid=None, status="ok"):
        sid = sid or self.sid
        call = uuid.uuid4().hex[:8]
        self.hook("pre_tool_call", tool_name=name, args=args, session_id=sid, tool_call_id=call)
        time.sleep(0.01)
        self.hook("post_tool_call", tool_name=name, args=args, result=result, session_id=sid, tool_call_id=call, status=status, duration_ms=10)

    def sh(self, cmd, result="", sid=None):
        self.tool("terminal", {"command": cmd}, result, sid)

    def skill(self, name, sid=None):
        self.tool("skill_view", {"name": name}, sid=sid)
        self.hook("on_skill_lifecycle", action="loaded", skill_name=name, session_id=sid or self.sid)

    def write(self, path, content, disk=None):
        if disk is not None:
            Path(disk).parent.mkdir(parents=True, exist_ok=True)
            Path(disk).write_text(content, encoding="utf-8")
        self.tool("write_file", {"path": path, "content": content})

    def reply(self, text):
        self.hook("post_llm_call", session_id=self.sid, assistant_response=text, platform="api_server")


def brd_text(version=1, name="Tip calculator"):
    extra = "" if version == 1 else f"\n\n## Decisions\n\n- Version {version}: the user asked for changes.\n"
    return (f"# Business Requirements: {name}\n\n## Goal\n\nWork out the tip and split the bill.\n\n"
            "## Business requirements\n\n| ID | Requirement |\n| --- | --- |\n| BR-01 | The user enters the bill. |\n"
            "| BR-02 | The user picks a tip. |\n\n## Quality requirements\n\n- NFR-01 Loads in under 2 seconds.\n"
            "\n## Not included\n\n- Accounts.\n" + extra)


class Brain:
    def __init__(self):
        self.stage = {}
        self.ws = {}
        self.faults: dict = {}
        self.brd_version = {}
        self.release_no = {}
        self.seen = []  # (handler, input first line) in order

    def fault(self, key):
        lst = self.faults.get(key) or []
        return lst.pop(0) if lst else None

    def apply_fault(self, run, key):
        f = self.fault(key)
        if f == "limit":
            run.fail("Claude AI usage limit reached|%d" % (int(time.time()) + 1))
            return True
        if f == "rate429":
            run.fail("Error 429: rate_limit_error - Number of requests has exceeded your rate limit")
            return True
        if f == "error":
            run.fail("Tool crashed: boom")
            return True
        if f == "limit_text":  # Hermes answered with the error text as a normal reply
            run.complete("API Error: 529 overloaded_error. Please try again later.")
            return True
        if f == "hang":
            run.hang()
            return True
        if f == "slow":
            time.sleep(0.8)
        if f == "approve_danger":
            run.ask_approval("rm -rf ~/.hermes", "delete the Hermes folder")
            run.complete("Tried a dangerous command.")
            return True
        if f == "approve_ok":
            run.ask_approval("npm install", "install packages")
        return False

    def handle(self, run: Run):
        sid = run.session
        run.hook("pre_llm_call", session_id=run.sid, user_message=run.input, platform="api_server", is_first_turn=sid not in self.stage)
        t = re.sub(r"^\(The previous attempt.*?\)\n\n", "", run.input, flags=re.S)
        time.sleep(0.02)
        ws = re.search(r"Workspace folder: (\S+)", t)
        if ws:
            self.ws[sid] = ws.group(1)
        try:
            if t.startswith("/sdlc-orchestrator"):
                self.seen.append("start")
                self.start(run)
            elif "asked for changes to the BRD" in t:
                self.seen.append("brd_changes")
                self.brd_changes(run)
            elif t.startswith("The user approved the BRD"):
                self.seen.append("build")
                self.build(run)
            elif t.startswith("/sdlc-change-request"):
                self.seen.append("change")
                self.change(run)
            elif "Continue on your own" in t or t.startswith("Resume."):
                self.seen.append("advance")
                self.advance(run)
            else:
                self.seen.append("message")
                run.reply("Thanks, I noted that.")
                run.complete("Thanks, I noted that.")
        except Exception as e:  # a bug in the script should fail loudly in the test
            run.fail(f"fake hermes crashed: {e!r}")

    # ---- the scripted team ----
    def start(self, run):
        sid = run.session
        self.stage[sid] = 0
        if self.apply_fault(run, "start"):
            return
        ws = Path(self.ws[sid])
        slug = re.search(r"Repository name: (\S+)", run.input).group(1)
        run.skill("sdlc-orchestrator")
        run.sh(f"gh repo create bot/{slug} --public --template bot/hermes-project-template --clone", f"https://github.com/bot/{slug}")
        run.sh('gh issue create --title "Team sync" --body "Agents post blockers here"', f"https://github.com/bot/{slug}/issues/1")
        run.skill("sdlc-ba")
        self.brd_version[sid] = 1
        run.write("docs/BRD.md", brd_text(1), disk=ws / "repo" / "docs" / "BRD.md")
        state = {"repo_path": str(ws / "repo"), "repo_url": f"https://github.com/bot/{slug}"}
        run.write(str(ws / "project.json"), json.dumps(state), disk=ws / "project.json")
        msg = "The BRD is ready: 2 business requirements and 1 quality requirement.\nPlease read it on the website, then press Approve BRD, or tell me what to change."
        run.reply(msg)
        run.complete(msg)

    def brd_changes(self, run):
        sid = run.session
        if self.apply_fault(run, "brd_changes"):
            return
        run.skill("sdlc-ba")
        self.brd_version[sid] = self.brd_version.get(sid, 1) + 1
        ws = Path(self.ws[sid])
        run.write("docs/BRD.md", brd_text(self.brd_version[sid]), disk=ws / "repo" / "docs" / "BRD.md")
        msg = "I updated the BRD (a decision was added). Please read it again and press Approve BRD."
        run.reply(msg)
        run.complete(msg)

    def build(self, run):
        sid = run.session
        if self.apply_fault(run, "build"):
            return
        ws = Path(self.ws[sid])
        run.skill("sdlc-architect")
        run.write("docs/CONTRACT.md", "# Contract")
        run.write("docs/PLAN.md", "# Plan\n## Task 1\n- assignee: claude\n## Task 2\n- assignee: devin")
        run.skill("sdlc-development")
        run.sh('gh issue comment 1 --body "BLOCKER: task 2 -> task 1\nneed the date format"')
        run.tool("mcp_devin_devin_session_create", {"title": "Task 2 styles", "prompt": "build the styles", "max_acu_limit": 5},
                 json.dumps({"session_id": "devin-abcdef123456", "url": "https://app.devin.ai/sessions/abcdef123456"}))
        for n in (1, 2):
            child = f"{run.sid}-c{n}"
            run.hook("subagent_start", parent_session_id=run.sid, child_session_id=child, child_subagent_id=child, child_goal=f"Task {n}. Work on branch feature/t{n}")
            run.sh(f'git commit -am "feat: task {n}" && git push -u origin feature/t{n}', sid=child)
            run.sh(f'gh pr create --title "Task {n}" --head feature/t{n}', f"https://github.com/bot/x/pull/{n}", sid=child)
            run.hook("subagent_stop", parent_session_id=run.sid, child_session_id=child, child_status="completed", child_summary=f"Task {n} done", tool_call_history=[], duration_ms=10)
        self.stage[sid] = 1
        msg = "Both task helpers are running in the background. I will report back once the pull requests are ready."
        run.reply(msg)
        run.complete(msg)

    def advance(self, run):
        sid = run.session
        st = self.stage.get(sid, 0)
        ws = Path(self.ws[sid])
        if st == 0:  # resumed before the build ever finished: do the build now
            return self.build(run)
        if st == 1:
            if self.apply_fault(run, "qa"):
                return
            run.skill("sdlc-review")
            run.sh("gh pr review 1 --approve --body ok")
            run.sh("gh pr merge 1 --squash --delete-branch")
            run.skill("sdlc-qa")
            run.write("docs/QA.md", "QA result: passed\n\n| ID | Result |\n| --- | --- |\n| BR-01 | Pass |\n")
            self.stage[sid] = 2
            msg = "Review and QA are done. QA result: passed. The release comes next."
        elif st == 2:
            if self.apply_fault(run, "release"):
                return
            run.skill("sdlc-release")
            run.sh("vercel deploy --prod", f"Production: {LIVE}")
            n = self.release_no.get(sid, 0) + 1
            self.release_no[sid] = n
            state = {"repo_path": str(ws / "repo"), "repo_url": "https://github.com/bot/x", "staging_url": STAGING, "production_url": LIVE, "release_number": n}
            run.write(str(ws / "project.json"), json.dumps(state), disk=ws / "project.json")
            self.stage[sid] = 3
            msg = f"Your site is live: {LIVE}\nYou can ask for changes on the website."
        else:
            msg = "Everything is finished."
        run.reply(msg)
        run.complete(msg)

    def change(self, run):
        sid = run.session
        if self.apply_fault(run, "change"):
            return
        ws = Path(self.ws[sid])
        for name in ("sdlc-change-request", "sdlc-development", "sdlc-review", "sdlc-qa", "sdlc-release"):
            run.skill(name)
        n = self.release_no.get(sid, 1) + 1
        self.release_no[sid] = n
        state = {"repo_path": str(ws / "repo"), "repo_url": "https://github.com/bot/x", "staging_url": STAGING, "production_url": LIVE, "release_number": n}
        run.write(str(ws / "project.json"), json.dumps(state), disk=ws / "project.json")
        msg = f"The change is done. Your site is live: {LIVE}"
        run.reply(msg)
        run.complete(msg)


class FakeHermes:
    def __init__(self, plugin, brain: Brain | None = None):
        self.plugin = plugin
        self.brain = brain or Brain()
        self.runs: dict = {}
        self.inputs: list = []  # (session, input) for every run, in order
        self.approvals: list = []
        self.stops: list = []
        self.lock = threading.RLock()
        self.busy_next = 0  # answer the next N POST /v1/runs with 429
        self.alias_sessions = False
        self.httpd = None
        self.url = ""

    def start(self):
        fh = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def _auth(self):
                return self.headers.get("Authorization") == "Bearer " + KEY

            def do_GET(self):
                if self.path == "/health":
                    return self._send(200, {"status": "ok"})
                if not self._auth():
                    return self._send(401, {"error": {"message": "unauthorized"}})
                rid = self.path.rsplit("/", 1)[-1]
                with fh.lock:
                    r = fh.runs.get(rid)
                    return self._send(200, {"run_id": rid, **r.data}) if r else self._send(404, {"error": {"message": "no run"}})

            def do_POST(self):
                if not self._auth():
                    return self._send(401, {"error": {"message": "unauthorized"}})
                b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if self.path == "/v1/runs":
                    with fh.lock:
                        if fh.busy_next > 0:
                            fh.busy_next -= 1
                            return self._send(429, {"error": {"message": "too many runs"}})
                        rid = "run_" + uuid.uuid4().hex[:8]
                        run = Run(fh, rid, b.get("input", ""), b.get("session_id"))
                        fh.runs[rid] = run
                        fh.inputs.append((run.session, run.input))
                    threading.Thread(target=fh.brain.handle, args=(run,), daemon=True).start()
                    return self._send(202, {"run_id": rid, "status": "started"})
                parts = self.path.split("/")
                rid = parts[3] if len(parts) > 3 else ""
                with fh.lock:
                    run = fh.runs.get(rid)
                    if run is None:
                        return self._send(404, {})
                    if self.path.endswith("/approval"):
                        run.data["choice"] = b.get("choice")
                        return self._send(200, {"choice": b.get("choice")})
                    if self.path.endswith("/stop"):
                        run.data["status"] = "cancelled"
                        fh.stops.append(rid)
                        return self._send(200, {"status": "stopping"})
                self._send(404, {})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
