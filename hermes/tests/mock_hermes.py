# Stand-in for the Hermes API server. Each run fires the REAL agent-room plugin hooks,
# so its events go plugin -> (mock) Supabase -> website, like on the real server.
import importlib.util, json, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
spec = importlib.util.spec_from_file_location("ar", "/home/claude/agent-room/plugin/agent-room/__init__.py")
ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)
class Ctx:
    h = {}
    def register_hook(self, n, f): self.h[n] = f
c = Ctx(); ar.register(c); H = c.h
KEY = "api-test"; runs = {}; lock = threading.Lock(); log = []
def tool(sid, name, args, result="ok"):
    H["pre_tool_call"](tool_name=name, args=args, session_id=sid, tool_call_id=str(uuid.uuid4()))
    time.sleep(0.2)
    H["post_tool_call"](tool_name=name, args=args, result=result, session_id=sid, status="ok", duration_ms=200)
def work(rid, text, sid):
    log.append((sid, text[:60]))
    H["pre_llm_call"](session_id=sid, user_message=text, platform="api_server", is_first_turn=False)
    time.sleep(0.6)
    if text.startswith("/sdlc-project"):
        tool(sid, "skill_view", {"name": "sdlc-project"}); tool(sid, "skill_view", {"name": "sdlc-requirements"})
        tool(sid, "write_file", {"path": "docs/BRD.md", "content": "x"})
        reply = "BRD ready: 4 requirements. Reply Approve to pass gate G1."
    elif text.strip().lower() == "approve":
        tool(sid, "patch", {"path": "docs/approvals.md", "new_string": "| G1 | Approved by Mohammad | 2026-10-16 |"})
        tool(sid, "skill_view", {"name": "sdlc-planning"}); tool(sid, "write_file", {"path": "PLAN.md", "content": "x"})
        reply = "G1 recorded. Plan ready. Reply Approve for gate G2."
    elif "rm -rf" in text:
        with lock: runs[rid].update(status="waiting_for_approval", approval={"request_id": "req-1", "description": "rm -rf build/ (recursive delete)"})
        for _ in range(100):
            time.sleep(0.2)
            if runs[rid].get("choice"): break
        reply = f"Command {'ran' if runs[rid].get('choice') == 'once' else 'was denied'}."
    else:
        reply = f"Noted: {text}"
    H["post_llm_call"](session_id=sid, assistant_response=reply, platform="api_server")
    with lock: runs[rid].update(status="completed", output=reply); runs[rid].pop("approval", None)
class R(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def auth(self): return self.headers.get("Authorization") == "Bearer " + KEY
    def do_GET(self):
        if self.path == "/health": return self._j(200, {"status": "ok"})
        if self.path == "/_log": return self._j(200, log)
        if not self.auth(): return self._j(401, {"error": {"message": "unauthorized"}})
        rid = self.path.rsplit("/", 1)[-1]
        with lock: r = dict(runs.get(rid) or {})
        return self._j(200 if r else 404, {"object": "hermes.run", "run_id": rid, **r} if r else {"error": {"message": "no run"}})
    def do_POST(self):
        if not self.auth(): return self._j(401, {"error": {"message": "unauthorized"}})
        b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/v1/runs":
            rid = "run_" + uuid.uuid4().hex[:8]
            with lock: runs[rid] = {"status": "running", "session_id": b.get("session_id")}
            threading.Thread(target=work, args=(rid, b.get("input", ""), b.get("session_id")), daemon=True).start()
            return self._j(202, {"run_id": rid, "status": "started"})
        if self.path.endswith("/approval"):
            rid = self.path.split("/")[3]
            with lock: runs[rid]["choice"] = b.get("choice"); runs[rid]["status"] = "running"
            return self._j(200, {"object": "hermes.run.approval_response", "choice": b.get("choice")})
        if self.path.endswith("/stop"):
            rid = self.path.split("/")[3]
            with lock: runs[rid]["status"] = "cancelled"
            return self._j(200, {"status": "stopping"})
        self._j(404, {})
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), R).serve_forever()
