"""In-process stand-in for the Supabase v2 machine RPCs (0003_rpcs.sql) and the order table.

Only fake values are used (write key "w-test"). It follows the SQL closely enough to catch mistakes:
wrong keys are refused, set_project only accepts the whitelisted fields and valid values, ingest maps a
sub-agent's events to the parent's project, map_session back-fills events that came first.

    mock = MockPlatform(); mock.start()
    pid = mock.add_project("Calculator"); mock.add_order(pid, "start_project", "a tip calculator")
    ... run the bridge against mock.url ...
    mock.stop()
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WRITE = "w-test"
KEY = "sb_publishable_test"

STATUSES = {"queued", "discovery", "awaiting_brd_approval", "architecture", "development", "review", "qa",
            "releasing", "released", "paused", "failed", "stopped"}
PHASES = {"discovery", "architecture", "development", "review", "qa", "release"}
ORDER_STATUSES = {"queued", "taken", "running", "waiting", "done", "failed"}
ORDER_KINDS = {"start_project", "message", "approve_brd", "request_brd_changes", "change_request", "stop", "resume"}
ALLOWED = {"status", "phase", "repo_url", "staging_url", "production_url", "brd_markdown", "brd_approved_at"}
URL_RE = re.compile(r"^https?://", re.I)


class RpcFail(Exception):
    def __init__(self, http, code, message):
        self.http, self.code, self.message = http, code, message


class MockPlatform:
    def __init__(self, write_key: str = WRITE, api_key: str = KEY):
        self.write_key, self.api_key = write_key, api_key
        self.lock = threading.RLock()
        self.projects: dict = {}
        self.orders: list = []
        self.events: list = []
        self.sessions: dict = {}
        self.legacy: list = []  # events mirrored to the old agent_room_ingest RPC
        self.calls: list = []  # (rpc name, args without the key)
        self.status_history: dict = {}  # project id -> list of statuses in the order they were set
        self.fail_next = 0  # answer the next N calls with HTTP 503 (a Supabase outage)
        self.httpd = None
        self.url = ""

    # ---- test helpers --------------------------------------------------------------------------
    def reset(self):
        with self.lock:
            self.projects.clear()
            self.orders.clear()
            self.events.clear()
            self.sessions.clear()
            self.legacy.clear()
            self.calls.clear()
            self.status_history.clear()
            self.fail_next = 0

    def add_project(self, name: str = "Demo", owner: str = "user-1") -> str:
        pid = str(uuid.uuid4())
        with self.lock:
            self.projects[pid] = {
                "id": pid, "owner_id": owner, "name": name, "slug": re.sub(r"[^a-z0-9]+", "-", name.lower()) + "-" + pid[:6],
                "status": "queued", "phase": None, "repo_url": None, "staging_url": None, "production_url": None,
                "brd_markdown": None, "brd_approved_at": None,
            }
            self.status_history[pid] = []
        return pid

    def add_order(self, pid: str, kind: str, text: str = "") -> int:
        assert kind in ORDER_KINDS, kind
        with self.lock:
            oid = len(self.orders) + 1
            self.orders.append({"id": oid, "project_id": pid, "kind": kind, "text": text, "status": "queued", "note": None, "run_id": None})
            return oid

    def order(self, oid: int) -> dict:
        with self.lock:
            return dict(next(o for o in self.orders if o["id"] == oid))

    def project(self, pid: str) -> dict:
        with self.lock:
            return dict(self.projects[pid])

    def history(self, pid: str) -> list:
        with self.lock:
            return list(self.status_history[pid])

    def events_of(self, pid: str, type_: str | None = None) -> list:
        with self.lock:
            return [e for e in self.events if e["project_id"] == pid and (type_ is None or e["type"] == type_)]

    def calls_named(self, name: str) -> list:
        with self.lock:
            return [a for n, a in self.calls if n == name]

    # ---- the RPCs ---------------------------------------------------------------------------------
    def _key(self, args):
        if args.get("write_key") is None or args.get("write_key") != self.write_key:
            raise RpcFail(403, "28000", "platform: wrong write key")

    def rpc_platform_take_orders(self, a):
        self._key(a)
        n = min(max(int(a.get("max_rows") or 5), 1), 20)
        out = []
        for o in self.orders:
            if o["status"] == "queued" and len(out) < n:
                o["status"] = "taken"
                out.append({"order_id": o["id"], "project_id": o["project_id"], "kind": o["kind"], "text": o["text"]})
        return out

    def rpc_platform_update_order(self, a):
        self._key(a)
        if a.get("status") not in ORDER_STATUSES:
            raise RpcFail(400, "22023", "platform: unknown order status")
        for o in self.orders:
            if o["id"] == a.get("order_id"):
                o["status"] = a["status"]
                if a.get("note") is not None:
                    o["note"] = str(a["note"])[:1000]
                if a.get("run_id") is not None:
                    o["run_id"] = str(a["run_id"])[:200]
                o.setdefault("history", []).append(a["status"])
                return None
        raise RpcFail(400, "P0002", "platform: order not found")

    def rpc_platform_set_project(self, a):
        self._key(a)
        fields = a.get("fields")
        if not isinstance(fields, dict):
            raise RpcFail(400, "22023", "platform: fields must be a JSON object")
        bad = next((k for k in fields if k not in ALLOWED), None)
        if bad:
            raise RpcFail(400, "22023", f"platform: field not allowed: {bad}")
        p = self.projects.get(a.get("project_id"))
        if p is None:
            raise RpcFail(400, "P0002", "platform: project not found")
        if "status" in fields and fields["status"] not in STATUSES:
            raise RpcFail(400, "23514", "projects_status_check")
        if fields.get("phase") is not None and fields["phase"] not in PHASES:
            raise RpcFail(400, "23514", "projects_phase_check")
        for k in ("repo_url", "staging_url", "production_url"):
            if fields.get(k) is not None and (not URL_RE.match(fields[k]) or len(fields[k]) > 2000):
                raise RpcFail(400, "23514", f"projects_{k}_check")
        if fields.get("brd_markdown") is not None and len(fields["brd_markdown"]) > 200000:
            raise RpcFail(400, "23514", "projects_brd_markdown_check")
        if "status" in fields and p["status"] != fields["status"]:
            self.status_history[p["id"]].append(fields["status"])
        p.update(fields)
        return None

    def rpc_platform_map_session(self, a):
        self._key(a)
        sid = a.get("session_id")
        if not sid:
            raise RpcFail(400, "22023", "platform: session_id is required")
        if a.get("project_id") not in self.projects:
            raise RpcFail(400, "23503", "project_sessions_project_id_fkey")
        self.sessions[sid] = a["project_id"]
        # children seen earlier through orphan sub_start events
        changed = True
        while changed:
            changed = False
            for e in self.events:
                if e["project_id"] is None and e["type"] == "sub_start":
                    p, c = e["payload"].get("parent"), e["payload"].get("child")
                    if p in self.sessions and c and c not in self.sessions:
                        self.sessions[c] = self.sessions[p]
                        changed = True
        for e in self.events:
            if e["project_id"] is None and e["session_id"] in self.sessions:
                e["project_id"] = self.sessions[e["session_id"]]
        return None

    def rpc_platform_ingest(self, a):
        self._key(a)
        evs = a.get("events")
        if not isinstance(evs, list) or len(evs) > 500:
            raise RpcFail(400, "22023", "platform: events must be a JSON array of at most 500 items")
        n = 0
        for ev in evs:
            if not isinstance(ev, dict) or not ev.get("type"):
                continue
            sid, child, parent = ev.get("sid"), ev.get("child"), ev.get("parent")
            if ev["type"] == "sub_start" and child:
                pid = self.sessions.get(parent)
                if pid:
                    self.sessions.setdefault(child, pid)
                else:
                    pid = self.sessions.get(child)
                sid = child
            else:
                sid = sid or child or parent
                pid = self.sessions.get(sid) or (self.sessions.get(parent) if parent else None)
            self.events.append({"id": len(self.events) + 1, "project_id": pid, "session_id": sid or "", "type": ev["type"], "payload": ev})
            n += 1
        return n

    def rpc_agent_room_ingest(self, a):
        self._key(a)
        self.legacy.extend(a.get("events") or [])
        return len(a.get("events") or [])

    # ---- HTTP -----------------------------------------------------------------------------------------
    def start(self):
        mock = self

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

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                name = self.path.rsplit("/", 1)[-1]
                with mock.lock:
                    if mock.fail_next > 0:
                        mock.fail_next -= 1
                        return self._send(503, {"message": "Service Unavailable"})
                    if self.headers.get("apikey") != mock.api_key:
                        return self._send(401, {"message": "Invalid API key"})
                    fn = getattr(mock, "rpc_" + name, None)
                    if fn is None:
                        return self._send(404, {"code": "PGRST202", "message": f"function {name} not found"})
                    mock.calls.append((name, {k: v for k, v in body.items() if k != "write_key"}))
                    try:
                        return self._send(200, fn(body))
                    except RpcFail as e:
                        return self._send(e.http, {"code": e.code, "message": e.message})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
