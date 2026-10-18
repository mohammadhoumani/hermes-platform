import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
WRITE, READ, SEND, KEY = "w-test", "r-test", "s-test", "sb_publishable_test"
rows, cmds, lock = [], [], threading.Lock()
import datetime
now = lambda: datetime.datetime.utcnow().isoformat() + "Z"
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "apikey, content-type, authorization"); self.send_header("Access-Control-Allow-Methods", "POST"); self.end_headers()
    def bad(self, what): return self._j(400, {"code": "28000", "message": f"agent_room: wrong {what} key"})
    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.headers.get("apikey") != KEY: return self._j(401, {"message": "Invalid API key"})
        p = self.path.rsplit("/", 1)[-1]
        with lock:
            if p == "agent_room_ingest":
                if b.get("write_key") != WRITE: return self.bad("write")
                for e in b.get("events", []): rows.append({"id": len(rows) + 1, "event": e})
                return self._j(200, len(b.get("events", [])))
            if p == "agent_room_read":
                if b.get("read_key") != READ: return self.bad("read")
                a, n = int(b.get("after_id") or 0), int(b.get("max_rows") or 1000)
                return self._j(200, rows[-n:] if a <= 0 else [r for r in rows if r["id"] > a][:n])
            if p == "agent_room_send":
                if b.get("send_key") != SEND: return self.bad("send")
                c = {"id": len(cmds) + 1, "created_at": now(), "kind": b.get("kind") or "message", "text": b.get("message") or "", "status": "queued", "note": None}
                cmds.append(c); return self._j(200, c["id"])
            if p == "agent_room_my_commands":
                if b.get("send_key") != SEND: return self.bad("send")
                return self._j(200, cmds[-int(b.get("max_rows") or 20):])
            if p == "agent_room_take":
                if b.get("write_key") != WRITE: return self.bad("write")
                out = []
                for c in cmds:
                    if c["status"] == "queued" and len(out) < int(b.get("max_rows") or 5):
                        c["status"] = "taken"; out.append({"id": c["id"], "kind": c["kind"], "text": c["text"]})
                return self._j(200, out)
            if p == "agent_room_update":
                if b.get("write_key") != WRITE: return self.bad("write")
                for c in cmds:
                    if c["id"] == b.get("command_id"):
                        c["status"] = b.get("new_status") or c["status"]
                        if b.get("new_note") is not None: c["note"] = b["new_note"]
                return self._j(200, None)
        self._j(404, {"message": "not found"})
    def do_GET(self):
        with lock: self._j(200, {"rows": len(rows), "cmds": cmds})
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
