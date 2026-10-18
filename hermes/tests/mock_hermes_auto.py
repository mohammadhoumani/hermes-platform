# Fake Hermes that walks a whole SDLC run and stops to ask at every point a real run might:
# G1, G2, a plain question, a risky command, G3, then the release link.
import json, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
KEY = "api-test"; runs = {}; lock = threading.Lock(); log = []; step = {}
SCRIPT = [
    "BRD ready: 5 requirements in docs/BRD.md. Reply Approve to pass gate G1.",
    "G1 approved and recorded. PLAN.md is ready with 3 tasks. Approve gate G2?",
    "Dev-1 asks: which colour theme do you want for the board, light or dark?",
    "RISKY",
    "All 3 PRs pass CI and review. Approve gate G3 to merge into main?",
    "Merged and released. Live: https://hermesagenttabbeqai.github.io/kanban-board/",
]
def work(rid, text, sid):
    i = 0 if text.startswith("/sdlc-project") else step.get(sid, 0) + 1
    step[sid] = i
    log.append({"sid": sid, "in": text[:90], "step": i})
    time.sleep(0.4)
    reply = SCRIPT[min(i, len(SCRIPT) - 1)]
    if reply == "RISKY":
        with lock: runs[rid].update(status="waiting_for_approval", approval={"request_id": "req-9", "description": "git push --force origin main"})
        for _ in range(100):
            time.sleep(0.1)
            if runs[rid].get("choice"): break
        reply = f"Push {'done' if runs[rid].get('choice') == 'once' else 'was denied'}. Opened PRs #4 #5 #6."
    with lock: runs[rid].update(status="completed", output=reply); runs[rid].pop("approval", None)
class R(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def auth(self): return self.headers.get("Authorization") == "Bearer " + KEY
    def do_GET(self):
        if self.path == "/health": return self._j(200, {"status": "ok"})
        if self.path == "/_log": return self._j(200, log)
        if not self.auth(): return self._j(401, {})
        rid = self.path.rsplit("/", 1)[-1]
        with lock: r = dict(runs.get(rid) or {})
        return self._j(200 if r else 404, {"run_id": rid, **r})
    def do_POST(self):
        if not self.auth(): return self._j(401, {})
        b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/v1/runs":
            rid = "run_" + uuid.uuid4().hex[:8]
            with lock: runs[rid] = {"status": "running"}
            threading.Thread(target=work, args=(rid, b.get("input", ""), b.get("session_id")), daemon=True).start()
            return self._j(202, {"run_id": rid, "status": "started"})
        rid = self.path.split("/")[3]
        if self.path.endswith("/approval"):
            log.append({"approval": b})
            with lock: runs[rid]["choice"] = b.get("choice"); runs[rid]["status"] = "running"
            return self._j(200, {"choice": b.get("choice")})
        if self.path.endswith("/stop"):
            with lock: runs[rid]["status"] = "cancelled"
            return self._j(200, {})
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), R).serve_forever()
