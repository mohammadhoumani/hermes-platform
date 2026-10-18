#!/usr/bin/env python3
"""Agent Room bridge: orders typed on the website -> Hermes.

Runs on the Hermes server. Every 2 seconds it claims new orders from Supabase
(agent_room_take), sends them to the local Hermes API server (POST /v1/runs) in one
persistent session, and writes the progress back (agent_room_update) so the website can
show it. The agents' work itself reaches the dashboard through the agent-room plugin.

Order kinds:
  project       start a new SDLC project (new Hermes session)
  message       a reply in the current session (answers, "Approve", changes)
  approve_once  approve the command Hermes is waiting on
  deny          deny it
  stop          stop the current run

Finish on its own (default on): the user only approves G1 (the BRD). After that the bridge
keeps the team going by itself: it approves G2 and G3, answers "use your best judgment" to any
other question, and approves commands Hermes asks about, until the release is live. The Stop
button still works. Turn it off with "auto_after_brd": false in config.json.

Settings: ~/.hermes/agent-room/config.json (supabase_url, supabase_key, write_key) and the
Hermes API server key from ~/.hermes/.env (API_SERVER_KEY). Python standard library only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
DATA = HERMES_HOME / "agent-room"
CONFIG = DATA / "config.json"
STATE = DATA / "bridge_state.json"
POLL = float(os.environ.get("AGENT_ROOM_BRIDGE_POLL", "2"))
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}

PROJECT_PROMPT = (
    "/sdlc-project {text}\n\n"
    "(This order came from the Agent Room website. Load the sdlc-project skill with skill_view and "
    "follow it step by step. The user reads your replies on the website and answers or approves "
    "gates by sending messages in this same conversation.)"
)
AUTO_POLICY = (
    "\n\nApproval rule from the user: the user approves ONLY gate G1 (the BRD). Once G1 is approved, "
    "G2 (the plan) and G3 (the merge) are pre-approved by the user: write them in approvals.md as "
    "\"approved in advance by the user at G1\" and go straight on through planning, development, review, "
    "merge and release without stopping to ask. If you must choose something, choose the sensible option "
    "yourself and note it. Only stop if you are truly blocked."
)
AUTO_GATE = ("Approved {gate} automatically: the user approved the BRD and asked the team to finish the "
             "rest on its own. Continue with the next stage without waiting.")
AUTO_GO = ("Continue on your own. The user approved the BRD and asked the team to finish without them: "
           "make the sensible choice yourself, note it, and keep going until the release is live.")
AUTO_MAX = int(os.environ.get("AGENT_ROOM_AUTO_MAX", "40"))
AUTO_WAIT = float(os.environ.get("AGENT_ROOM_AUTO_WAIT", "90"))  # seconds to let background helpers work
GATE_RE = re.compile(r"\bG\s?-?([123])\b")
# Agents often ask "Approve this BRD?" without naming the gate, so the words count too.
GATE_WORDS = [("G3", re.compile(r"(?i)\bmerg")), ("G2", re.compile(r"(?i)\bplan\b|PLAN\.md")),
              ("G1", re.compile(r"(?i)\bBRD\b|requirements"))]
SELF_RE = re.compile(r"(?i)\b(finish|continue|keep going|carry on|go on)\b.{0,20}\b(your|its|their) own\b|\bauto(matic(ally)?)? mode\b")
BUSY_RE = re.compile(r"(?i)\b(background|in progress|still running|is running|are running|report back|once .{0,40}(is|are) (ready|done)|will (notify|let you know))\b")
YES_RE = re.compile(r"(?i)\b(approve[ds]?|yes|ok(ay)?|go ahead|looks good|lgtm|confirm(ed)?|agreed?)\b")
NO_RE = re.compile(r"(?i)\b(change|changes|no|not|don'?t|wait|fix|instead|but)\b")
DONE_RE = re.compile(r"(?i)https://[\w.-]+\.github\.io/|\b(release (is )?(done|complete|finished|live)|pipeline (is )?(done|complete|finished))\b")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def read_env_file(path: Path) -> dict:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


def load_settings() -> dict:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    env = read_env_file(HERMES_HOME / ".env")
    s = {
        "supabase_url": os.environ.get("AGENT_ROOM_SUPABASE_URL") or cfg.get("supabase_url", ""),
        "supabase_key": os.environ.get("AGENT_ROOM_SUPABASE_KEY") or cfg.get("supabase_key", ""),
        "write_key": os.environ.get("AGENT_ROOM_WRITE_KEY") or cfg.get("write_key", ""),
        "api_url": (os.environ.get("AGENT_ROOM_HERMES_API") or cfg.get("hermes_api")
                    or f"http://127.0.0.1:{env.get('API_SERVER_PORT', '8642')}").rstrip("/"),
        "api_key": os.environ.get("API_SERVER_KEY") or env.get("API_SERVER_KEY") or cfg.get("hermes_api_key", ""),
        "auto": str(os.environ.get("AGENT_ROOM_AUTO", cfg.get("auto_after_brd", True))).lower() not in ("0", "false", "no", "off"),
    }
    missing = [k for k in ("supabase_url", "supabase_key", "write_key", "api_key") if not s[k]]
    if missing:
        sys.exit(f"agent-room bridge: missing settings: {', '.join(missing)}. Run install.sh again.")
    return s


def http(method: str, url: str, headers: dict, body=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in headers.items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode() or "null"
            return r.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "null")
        except Exception:
            payload = None
        return e.code, payload


class Bridge:
    def __init__(self, s: dict):
        self.s = s
        self.state = {"session": None, "active": None, "pending": [], "flow": None}
        try:
            self.state.update(json.loads(STATE.read_text(encoding="utf-8")))
        except Exception:
            pass
        if not isinstance(self.state.get("flow"), dict):
            self.state["flow"] = {"asked": None, "auto": False, "count": 0}
        self.last_status = None

    @property
    def flow(self) -> dict:
        return self.state["flow"]

    # ---- Supabase -------------------------------------------------------
    def rpc(self, name: str, args: dict):
        code, data = http("POST", f"{self.s['supabase_url']}/rest/v1/rpc/{name}",
                          {"apikey": self.s["supabase_key"]}, args)
        if code >= 300:
            raise RuntimeError(f"Supabase {name} answered {code}: {(data or {}).get('message') if isinstance(data, dict) else data}")
        return data

    def update(self, cmd_id, status: str, note: str = None, run_id: str = None):
        if cmd_id is None:  # a step the bridge took on its own (finish-on-its-own mode)
            if note:
                log("auto:", status, note[:200])
            return
        try:
            self.rpc("agent_room_update", {"write_key": self.s["write_key"], "command_id": cmd_id,
                                           "new_status": status, "new_note": note, "new_run_id": run_id})
        except Exception as e:
            log("could not update order", cmd_id, e)

    # ---- Hermes API server ---------------------------------------------
    def api(self, method: str, path: str, body=None):
        return http(method, self.s["api_url"] + path, {"Authorization": "Bearer " + self.s["api_key"]}, body, timeout=30)

    def save(self):
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            STATE.write_text(json.dumps(self.state), encoding="utf-8")
        except Exception as e:
            log("could not save state", e)

    def start_run(self, cmd: dict):
        kind, text = cmd["kind"], cmd["text"].strip()
        if kind == "project" or not self.state.get("session"):
            self.state["session"] = f"agent-room-{int(time.time())}-{cmd['id'] or 'auto'}"
        if kind == "project":
            self.state["flow"] = {"asked": None, "auto": False, "count": 0}
            prompt = PROJECT_PROMPT.format(text=text) + (AUTO_POLICY if self.s["auto"] else "")
        else:
            prompt = text
            # The user's first yes to a gate in a project is the yes to G1 (the BRD): from then on
            # the team finishes on its own. "Continue on your own" switches it on too.
            if kind == "message" and cmd.get("id") is not None and self.s["auto"] and not self.flow.get("auto"):
                if ((self.flow.get("asked") and YES_RE.search(text) and not NO_RE.search(text))
                        or SELF_RE.search(text)):
                    self.flow.update(auto=True, count=0)
                    log("BRD approved: the team now finishes on its own")
        code, data = self.api("POST", "/v1/runs", {"input": prompt, "session_id": self.state["session"]})
        if code == 429:
            self.state["pending"].insert(0, cmd)  # busy: try again soon
            self.update(cmd["id"], "queued", "Hermes is busy, retrying")
            return
        if code >= 300 or not isinstance(data, dict) or not data.get("run_id"):
            msg = (data or {}).get("error", {}).get("message") if isinstance(data, dict) and isinstance(data.get("error"), dict) else data
            self.update(cmd["id"], "failed", f"Hermes refused the order ({code}): {msg}")
            log("run start failed", code, msg)
            return
        self.state["active"] = {"cmd": cmd["id"], "run": data["run_id"]}
        self.last_status = None
        self.update(cmd["id"], "running", "Hermes is working on it", data["run_id"])
        log("order", cmd["id"], "->", data["run_id"], "session", self.state["session"])

    def poll_active(self):
        act = self.state.get("active")
        if not act:
            return
        code, data = self.api("GET", f"/v1/runs/{act['run']}")
        if code == 404:
            self.update(act["cmd"], "failed", "Hermes lost this run (was the gateway restarted?)")
            self.state["active"] = None
            return
        if code >= 300 or not isinstance(data, dict):
            return  # try again next tick
        status = data.get("status")
        if status == self.last_status and status != "waiting_for_approval":
            return
        self.last_status = status
        if status == "waiting_for_approval":
            ap = data.get("approval") or {}
            what = ap.get("description") or ap.get("command") or "a command"
            act["approval"] = ap.get("request_id") or ap.get("id")
            if self.flow.get("auto"):
                body = {"choice": "once"}
                if act["approval"]:
                    body["request_id"] = act["approval"]
                code, _ = self.api("POST", f"/v1/runs/{act['run']}/approval", body)
                if code < 300:
                    self.last_status = None
                    self.update(act["cmd"], "running", f"Approved automatically: {str(what)[:280]}")
                    return
            self.update(act["cmd"], "waiting", f"Approval needed: {str(what)[:300]}")
        elif status in TERMINAL:
            out = data.get("output") or data.get("error") or ""
            if isinstance(out, (dict, list)):
                out = json.dumps(out)
            out = str(out).strip()
            self.update(act["cmd"], "done" if status == "completed" else "failed", (out[:600] or status))
            log("run", act["run"], status)
            self.state["active"] = None
            self.after_run(status, out)
        else:
            self.update(act["cmd"], "running", "Hermes is working on it")

    def after_run(self, status: str, out: str):
        """Remember which gate the agents asked about; in finish-on-its-own mode, keep them going."""
        f = self.flow
        if status == "completed" and re.search(r"(?i)approv", out):
            gates = sorted({"G" + g for g in GATE_RE.findall(out)})
            if not gates:
                gates = [next((g for g, rx in GATE_WORDS if rx.search(out)), "G?")]
            f["asked"] = gates[-1]
        if not f.get("auto"):
            return
        if status != "completed":
            log("run ended with", status, "- not continuing on my own; send a reply to go on")
            return
        if DONE_RE.search(out):
            f["auto"] = False
            log("release is live: finish-on-its-own mode done")
            return
        if any(c.get("id") is not None for c in self.state["pending"]):
            return  # the user sent something; that goes first
        if f.get("count", 0) >= AUTO_MAX:
            f["auto"] = False
            log(f"stopped after {AUTO_MAX} automatic steps; send a reply to go on")
            return
        f["count"] = f.get("count", 0) + 1
        gate = f.get("asked")
        text = AUTO_GATE.format(gate=gate) if gate in ("G2", "G3") else AUTO_GO
        f["asked"] = None
        # Helpers still working in the background: give them time before nudging the team again.
        wait = AUTO_WAIT if BUSY_RE.search(out) else 0
        if wait:
            log(f"helpers still working; continuing in {int(wait)} s")
        self.state["pending"].append({"id": None, "kind": "message", "text": text, "not_before": time.time() + wait})

    def control(self, cmd: dict):
        act = self.state.get("active")
        if cmd["kind"] == "stop":  # Stop also ends finish-on-its-own mode
            self.flow["auto"] = False
            self.state["pending"] = [c for c in self.state["pending"] if c.get("id") is not None]
        if not act:
            self.update(cmd["id"], "done", "Nothing is running right now")
            return
        if cmd["kind"] == "stop":
            code, _ = self.api("POST", f"/v1/runs/{act['run']}/stop", {})
            self.update(cmd["id"], "done" if code < 300 else "failed", "Stop sent" if code < 300 else f"Stop failed ({code})")
            return
        body = {"choice": "once" if cmd["kind"] == "approve_once" else "deny"}
        if act.get("approval"):
            body["request_id"] = act["approval"]
        code, data = self.api("POST", f"/v1/runs/{act['run']}/approval", body)
        ok = code < 300
        self.update(cmd["id"], "done" if ok else "failed",
                    ("Approved" if body["choice"] == "once" else "Denied") if ok else f"Hermes answered {code}: {data}")
        if ok:
            self.last_status = None

    def tick(self):
        try:
            new = self.rpc("agent_room_take", {"write_key": self.s["write_key"], "max_rows": 5}) or []
        except Exception as e:
            log(e)
            new = []
        for cmd in new:
            if cmd["kind"] in ("approve_once", "deny", "stop"):
                self.control(cmd)
            else:
                self.state["pending"].append(cmd)
                if self.state.get("active"):
                    self.update(cmd["id"], "queued", "Waiting for the current run to finish")
        self.poll_active()
        if not self.state.get("active") and self.state["pending"]:
            pend = self.state["pending"]
            user = [c for c in pend if c.get("id") is not None]
            if user:  # the user's own orders go first and replace any planned automatic step
                self.state["pending"] = [c for c in pend if c.get("id") is not None and c is not user[0]]
                self.start_run(user[0])
            elif pend[0].get("not_before", 0) <= time.time():
                self.start_run(pend.pop(0))
        self.save()

    def run(self):
        log("agent-room bridge started. Hermes API:", self.s["api_url"], "| Supabase:", self.s["supabase_url"])
        code, _ = self.api("GET", "/health")
        if code >= 300:
            log(f"warning: Hermes API server answered {code} on /health. Is API_SERVER_ENABLED=true and the gateway running?")
        while True:
            try:
                self.tick()
            except Exception as e:
                log("error:", e)
            time.sleep(POLL)


if __name__ == "__main__":
    Bridge(load_settings()).run()
