#!/usr/bin/env python3
"""Hermes Platform bridge (v2): orders from the website -> Hermes.

Runs on the Hermes server (python3, standard library only). Every few seconds it:

  1. claims new orders from Supabase (platform_take_orders);
  2. sends them to the local Hermes API server (POST /v1/runs), one project at a time, each project
     in its own persistent Hermes session;
  3. reads what the plugin wrote (events.jsonl) to learn which skill/phase a project is in, and tells
     the website (platform_set_project: status, phase, urls, BRD text);
  4. writes order progress back (platform_update_order).

Order kinds: start_project, message, approve_brd, request_brd_changes, change_request, stop, resume.

The one human gate is the BRD. When the business analyst's turn ends asking for approval the bridge
reads docs/BRD.md from the project's checkout, stores it in projects.brd_markdown and sets the status
to awaiting_brd_approval. The `approve_brd` order is the only approval. After it the team finishes on
its own: the bridge nudges the orchestrator until the production URL appears, approves the commands
Hermes asks about (except a short list of dangerous ones) and answers questions with "use your best
judgment".

Contract with the skills (see hermes/skills/sdlc-orchestrator/SKILL.md, "Project state file"):
  * the bridge creates a workspace folder per project:  ~/.hermes/platform/workspaces/<project_id>/
  * the repository is cloned to <workspace>/repo, so the BRD is <workspace>/repo/docs/BRD.md
  * the agents keep <workspace>/project.json up to date:
      {"repo_path", "repo_url", "staging_url", "production_url", "release_number"}
  * every prompt the bridge sends ends with "(hermes-project:<project_id>)"; the plugin turns that into
    a `project` field on the turn_start event, which lets the bridge map a session even if Hermes
    did not use the session id the bridge asked for.

Usage limits: a run that fails with a Claude usage/rate limit message pauses the project (status
`paused`) and is retried after a back-off (default 30 minutes, or the time the message gives).

Settings: ~/.hermes/platform/config.json (supabase_url, supabase_key, write_key, and optional
poll_seconds, backoff_minutes, auto_wait_seconds, auto_max_steps, github_owner, template_repo,
devin_max_acu, hermes_api, auto_approve_commands) and the Hermes API server key from ~/.hermes/.env
(API_SERVER_KEY). Environment variables HERMES_PLATFORM_* override the file (used by the tests).

    platform_bridge.py            run forever
    platform_bridge.py --check    check the settings, Supabase and Hermes once, then exit (0 = fine)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
PHASE_ORDER = ["discovery", "architecture", "development", "review", "qa", "release"]
STATUS_FOR_PHASE = {
    "discovery": "discovery", "architecture": "architecture", "development": "development",
    "review": "review", "qa": "qa", "release": "releasing",
}
# Keep in sync with hermes/plugin/hermes-platform/__init__.py (SKILL_STAGE); a unit test compares them.
SKILL_STAGE = {
    "sdlc-orchestrator": "kickoff", "sdlc-ba": "discovery", "sdlc-architect": "architecture",
    "sdlc-development": "development", "sdlc-review": "review", "sdlc-qa": "qa", "sdlc-release": "release",
    "sdlc-change-request": "development",
    "sdlc-project": "kickoff", "sdlc-requirements": "discovery", "sdlc-planning": "architecture",
}
ACTIVE_STATUSES = {"discovery", "architecture", "development", "review", "qa", "releasing"}

BUSY_RE = re.compile(r"(?i)\b(background|in progress|still running|is running|are running|report back|once .{0,40}(is|are) (ready|done)|will (notify|let you know))\b")
APPROVE_ASK_RE = re.compile(r"(?i)\bapprov|\bBRD\b")
LIVE_RE = re.compile(r"(?i)\b(?:live|released|production|deployed)\b[^\n]{0,60}?(https?://[^\s<>\"')\]]+)")
URL_RE = re.compile(r"^https?://[^\s]+$")
BAD_HOST_RE = re.compile(r"(?i)^https?://(localhost|127\.|0\.0\.0\.0|\[::1\])")

# Claude usage limit / rate limit / overload messages. Strong patterns also count in a finished (completed)
# reply when the reply is short, because Hermes sometimes returns the error text as the answer.
LIMIT_STRONG_RE = re.compile(
    r"(?i)usage limit|rate[ _-]?limit|overloaded|too many requests|\b429\b|quota (exceeded|reached)|"
    r"limit (reached|exceeded|will reset)|\b5-hour limit\b|credit balance is too low|resets? (at|in)\b"
)
LIMIT_EPOCH_RE = re.compile(r"\|\s*(\d{10})\b")
LIMIT_IN_RE = re.compile(r"(?i)(?:try again|retry|resets?)\s+in\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h)")

# Commands Hermes asks about are approved automatically (there is no screen for them), except these.
DANGEROUS = [
    re.compile(r"(?i)\brm\s+-[a-z]*r[a-z]*\s+(?:--\s+)?(?:/|~|\$HOME|\"?\$\{?HOME\}?|/home|/home/[\w.-]+)/?\*?\s*(?:$|[;&|])"),
    re.compile(r"(?i)\brm\b[^;&|\n]*\.hermes(/?\*?(\s|$)|/(\.env|config\.yaml|skills|plugins|backups|platform/(config|bridge_state|events)))"),
    re.compile(r"(?i)\bmkfs(\.\w+)?\b"),
    re.compile(r"(?i)\bdd\b[^;&|\n]*\bof=/dev/"),
    re.compile(r":\(\)\s*\{"),
    re.compile(r"(?i)\b(shutdown|reboot|poweroff|halt)\b"),
    re.compile(r">\s*/dev/sd"),
    re.compile(r"(?i)\bchmod\s+-R\s+[0-7]{3,4}\s+/(\s|$)"),
    re.compile(r"(?i)\.hermes/\.env|platform/config\.json|\.ssh/|/etc/shadow"),
    re.compile(r"(?i)\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z)?sh\b"),
]


def is_dangerous(text: str) -> bool:
    return any(rx.search(text) for rx in DANGEROUS)


START_CONTEXT = (
    "(This order came from the Hermes website. Load the sdlc-orchestrator skill with skill_view and follow it step by step.\n"
    "Project id: {pid}\n"
    "Repository name: {slug}\n"
    "Workspace folder: {workdir}\n"
    "Clone the repository into {workdir}/repo and do all the work there. Keep {workdir}/project.json up to date, "
    "as the sdlc-orchestrator skill says.\n"
    "{extra}"
    "The user reads your replies on the website and answers there. The only thing the user approves is the BRD, "
    "with a button on the website. After your analyst writes docs/BRD.md, ask the user to approve it and stop.)"
)
CHANGE_CONTEXT = (
    "(This order came from the Hermes website. The project is already released. Load the sdlc-change-request skill with "
    "skill_view and follow it. There is no new BRD and no new approval.\n"
    "Project id: {pid}\n"
    "Workspace folder: {workdir}   (the repository is in {workdir}/repo; keep {workdir}/project.json up to date)\n"
    "{extra})"
)
APPROVE_PROMPT = (
    "The user approved the BRD. Continue on your own until the site is live: architecture, development, review, QA "
    "and release, one skill after the other, as the sdlc-orchestrator skill says. The BRD was the only approval the "
    "user gives. Do not ask the user for anything else; if you must choose, choose the sensible option and note it. "
    "Only stop if you are truly blocked."
)
BRD_CHANGES_PROMPT = (
    "The user asked for changes to the BRD. Load the sdlc-ba skill and update docs/BRD.md only as asked, then ask the "
    "user to approve the BRD again. The user's request: {text}"
)
AUTO_GO = ("Continue on your own. The user approved the BRD and asked the team to finish without them: "
           "make the sensible choice yourself, note it, and keep going until the release is live.")
RESUME_PROMPT = (
    "Resume. This project was stopped or paused. Continue from the last finished step: look at the repository, "
    "docs/PLAN.md, the open issues and pull requests, and carry on from there. Do not start over."
)
LIMIT_PREFIX = ("(The previous attempt was cut off by a usage limit. If you already did part of this, continue from "
                "where you stopped; do not start over.)\n\n")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def clip(text: Any, n: int) -> str:
    s = re.sub(r"\s+", " ", "" if text is None else str(text)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def slugify(text: str, words: int = 4) -> str:
    ws = re.findall(r"[a-z0-9]+", text.lower())[:words]
    return "-".join(ws)[:32].strip("-") or "project"


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


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def load_settings(home: Optional[Path] = None, need_secrets: bool = True) -> dict:
    home = home or hermes_home()
    data = home / "platform"
    cfg: dict = {}
    cfg_path = data / "config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception as e:
            sys.exit(f"hermes-platform bridge: cannot read {cfg_path}: {e}")
    env = read_env_file(home / ".env")

    def pick(env_name: str, key: str, default=None):
        return os.environ.get(env_name) or cfg.get(key) or default

    def num(env_name: str, key: str, default: float) -> float:
        try:
            return float(os.environ.get(env_name) or cfg.get(key) or default)
        except (TypeError, ValueError):
            return float(default)

    def flag(env_name: str, key: str, default: bool) -> bool:
        raw = os.environ.get(env_name)
        if raw is None:
            raw = cfg.get(key, default)
        return str(raw).lower() not in ("0", "false", "no", "off")

    s = {
        "home": home,
        "data": data,
        "supabase_url": str(pick("HERMES_PLATFORM_SUPABASE_URL", "supabase_url", "")).rstrip("/"),
        "supabase_key": pick("HERMES_PLATFORM_SUPABASE_KEY", "supabase_key", ""),
        "write_key": pick("HERMES_PLATFORM_WRITE_KEY", "write_key", ""),
        "api_url": str(pick("HERMES_PLATFORM_HERMES_API", "hermes_api", f"http://127.0.0.1:{env.get('API_SERVER_PORT', '8642')}")).rstrip("/"),
        "api_key": os.environ.get("API_SERVER_KEY") or env.get("API_SERVER_KEY") or cfg.get("hermes_api_key", ""),
        "poll": num("HERMES_PLATFORM_POLL", "poll_seconds", 2),
        "backoff": num("HERMES_PLATFORM_BACKOFF_SECONDS", "backoff_minutes", 30) * (1 if os.environ.get("HERMES_PLATFORM_BACKOFF_SECONDS") else 60),
        "limit_max_retries": int(num("HERMES_PLATFORM_LIMIT_RETRIES", "limit_max_retries", 20)),
        "auto_wait": num("HERMES_PLATFORM_AUTO_WAIT", "auto_wait_seconds", 90),
        "auto_max": int(num("HERMES_PLATFORM_AUTO_MAX", "auto_max_steps", 40)),
        "settle": num("HERMES_PLATFORM_SETTLE", "settle_seconds", 1.5),
        "auto_after_brd": flag("HERMES_PLATFORM_AUTO", "auto_after_brd", True),
        "auto_approve": flag("HERMES_PLATFORM_AUTO_APPROVE", "auto_approve_commands", True),
        "github_owner": pick("HERMES_PLATFORM_GITHUB_OWNER", "github_owner", ""),
        "template_repo": pick("HERMES_PLATFORM_TEMPLATE_REPO", "template_repo", ""),
        "devin_max_acu": pick("HERMES_PLATFORM_DEVIN_MAX_ACU", "devin_max_acu", ""),
    }
    if need_secrets:
        missing = [k for k in ("supabase_url", "supabase_key", "write_key", "api_key") if not s[k]]
        if missing:
            sys.exit(f"hermes-platform bridge: missing settings: {', '.join(missing)}. Run install_v2.sh again.")
    return s


class RpcError(RuntimeError):
    def __init__(self, name: str, status: int, message: str, code: str = ""):
        super().__init__(f"Supabase {name} answered {status}: {message}")
        self.status, self.code = status, code

    @property
    def retryable(self) -> bool:
        # network trouble (0), server errors, rate limits, or a wrong key/URL that the operator can fix.
        # A 400 from our own RPC checks (unknown project, bad value) can never succeed, so it is dropped.
        return self.status in (0, 401, 403, 408, 429) or self.status >= 500 or self.code.startswith("PGRST")


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
    except Exception as e:  # connection refused, DNS, timeout
        return 0, {"message": str(e)}


def parse_wait_seconds(text: str, now: float) -> Optional[float]:
    """How long the usage limit message says we must wait, if it says."""
    m = LIMIT_EPOCH_RE.search(text)
    if m:
        return max(0.0, float(m.group(1)) - now)
    m = LIMIT_IN_RE.search(text)
    if m:
        n, unit = float(m.group(1)), m.group(2).lower()
        return n * (3600 if unit.startswith("h") else 60 if unit.startswith("m") else 1)
    return None


def is_usage_limit(status: str, text: str) -> bool:
    if not text or not LIMIT_STRONG_RE.search(text):
        return False
    if status == "completed":  # a normal answer that merely talks about rate limits is not a limit
        return len(text) < 600 and bool(re.search(r"(?i)usage limit|rate[ _-]?limit|overloaded|\b429\b|limit reached", text)) \
            and not re.search(r"(?i)\bBRD\b|pull request|\bPR #", text)
    return True


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Bridge:
    def __init__(self, s: dict, now=time.time):
        self.s = s
        self.now = now
        self.data: Path = s["data"]
        self.state_file = self.data / "bridge_state.json"
        self.events_file = Path(os.environ.get("HERMES_PLATFORM_EVENTS") or self.data / "events.jsonl")
        self.workspaces = self.data / "workspaces"
        self.state: Dict[str, Any] = {"v": 2, "projects": {}, "slot": None, "active": None, "sessions": {}, "outbox": {}, "events_pos": None}
        try:
            self.state.update(json.loads(self.state_file.read_text(encoding="utf-8")))
        except Exception:
            pass
        self.stop_flag = False

    # ---- convenience ----------------------------------------------------------------------
    @property
    def projects(self) -> Dict[str, dict]:
        return self.state["projects"]

    def project(self, pid: str) -> Optional[dict]:
        return self.projects.get(pid)

    def save(self):
        try:
            self.data.mkdir(parents=True, exist_ok=True)
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.state), encoding="utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(self.state_file)
        except Exception as e:
            log("could not save state:", e)

    # ---- Supabase ---------------------------------------------------------------------------
    def rpc(self, name: str, args: dict):
        code, data = http("POST", f"{self.s['supabase_url']}/rest/v1/rpc/{name}",
                          {"apikey": self.s["supabase_key"], **({"Authorization": "Bearer " + self.s["supabase_key"]} if str(self.s["supabase_key"]).startswith("eyJ") else {})},
                          args)
        if code == 0 or code >= 300:
            msg = (data or {}).get("message") if isinstance(data, dict) else data
            raise RpcError(name, code, str(msg)[:200], str((data or {}).get("code", "")) if isinstance(data, dict) else "")
        return data

    def wk(self) -> str:
        return self.s["write_key"]

    # Writes to Supabase go through an outbox: they are merged by key, retried on network trouble and
    # survive a restart of the bridge. Nothing here ever blocks the main loop for long.
    def set_project(self, pid: str, **fields):
        P = self.project(pid)
        pushed = (P or {}).get("pushed", {})
        box = self.state["outbox"].setdefault(f"set:{pid}", {"fields": {}})
        for k, v in fields.items():
            if pushed.get(k) == v and k not in box["fields"]:
                continue
            box["fields"][k] = v
        if not box["fields"]:
            del self.state["outbox"][f"set:{pid}"]

    def update_order(self, oid, status: str, note: Optional[str] = None, run_id: Optional[str] = None):
        if oid is None:
            if note:
                log("auto:", status, clip(note, 160))
            return
        key = f"order:{oid}"
        cur = self.state["outbox"].get(key, {})
        self.state["outbox"][key] = {"status": status, "note": clip(note, 300) if note is not None else cur.get("note"),
                                     "run_id": run_id or cur.get("run_id")}

    def map_session(self, sid: str, pid: str, parent: Optional[str] = None, role: Optional[str] = None):
        self.state["sessions"][sid] = pid
        self.state["outbox"][f"map:{sid}"] = {"session_id": sid, "project_id": pid, "parent_session_id": parent, "role": role}

    def flush_outbox(self):
        box = self.state["outbox"]
        for key in list(box.keys()):
            item = box[key]
            try:
                if key.startswith("set:"):
                    pid = key[4:]
                    self.rpc("platform_set_project", {"write_key": self.wk(), "project_id": pid, "fields": item["fields"]})
                    P = self.project(pid)
                    if P is not None:
                        P.setdefault("pushed", {}).update(item["fields"])
                elif key.startswith("order:"):
                    self.rpc("platform_update_order", {"write_key": self.wk(), "order_id": int(key[6:]), "status": item["status"],
                                                       "note": item.get("note"), "run_id": item.get("run_id")})
                elif key.startswith("map:"):
                    self.rpc("platform_map_session", {"write_key": self.wk(), **item})
                del box[key]
            except RpcError as e:
                if e.retryable:
                    log("will retry later:", key.split(":")[0], e)
                    return  # stop at the first trouble; try again next tick
                log("dropping", key, "because Supabase refused it:", e)
                del box[key]
            except Exception as e:
                log("outbox error for", key, e)
                del box[key]
        if len(box) > 400:  # a long outage: keep the newest
            for key in list(box.keys())[: len(box) - 400]:
                del box[key]

    # ---- Hermes API server -----------------------------------------------------------------
    def api(self, method: str, path: str, body=None):
        return http(method, self.s["api_url"] + path, {"Authorization": "Bearer " + self.s["api_key"]}, body, timeout=30)

    # ---- project records ----------------------------------------------------------------------
    def new_project(self, pid: str, idea: str) -> dict:
        slug = f"{slugify(idea)}-{pid[:6]}"
        workdir = self.workspaces / pid
        P = {
            "id": pid, "idea": idea[:4000], "slug": slug, "workdir": str(workdir), "session": None,
            "status": "queued", "phase": None, "cycle": 0, "skills": [], "brd_hash": "", "brd_approved": False,
            "flow": {"auto": False, "count": 0}, "pending": [], "paused": None, "resume_status": None,
            "pushed": {}, "cycle_order": None, "waiting_since": None, "stopping": False, "mapped": False,
            "seen_deploy": {}, "rel_before": None, "prod_before": None, "queue_note": None, "created": self.now(),
        }
        self.projects[pid] = P
        return P

    def set_status(self, P: dict, status: str, phase: Optional[str] = None, **extra):
        fields: Dict[str, Any] = {"status": status}
        if phase is not None:
            P["phase"] = phase
            fields["phase"] = phase
        P["status"] = status
        fields.update(extra)
        self.set_project(P["id"], **fields)

    def read_state_file(self, P: dict) -> dict:
        """project.json written by the agents. Only known keys with sane values are used."""
        try:
            raw = json.loads((Path(P["workdir"]) / "project.json").read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(raw, dict):
            return {}
        out: dict = {}
        for k in ("repo_url", "staging_url", "production_url"):
            v = raw.get(k)
            if isinstance(v, str) and URL_RE.match(v.strip()) and len(v) <= 2000 and not BAD_HOST_RE.match(v.strip()):
                out[k] = v.strip()
        if isinstance(raw.get("repo_path"), str):
            out["repo_path"] = raw["repo_path"]
        rn = raw.get("release_number")
        if isinstance(rn, int) and not isinstance(rn, bool):
            out["release_number"] = rn
        return out

    def repo_dir(self, P: dict, st: Optional[dict] = None) -> Optional[Path]:
        wd = Path(P["workdir"]).resolve()
        st = st if st is not None else self.read_state_file(P)
        cands = []
        if st.get("repo_path"):
            cands.append(Path(st["repo_path"]).expanduser())
        cands.append(wd / "repo")
        for c in cands:
            try:
                r = c.resolve()
                if r.is_dir() and (r == wd or wd in r.parents):  # never leave the workspace
                    return r
            except Exception:
                continue
        try:
            for d in sorted(wd.iterdir()):
                if d.is_dir() and (d / "docs" / "BRD.md").exists():
                    return d.resolve()
        except Exception:
            pass
        return None

    def read_brd(self, P: dict) -> Optional[str]:
        d = self.repo_dir(P)
        if not d:
            return None
        f = d / "docs" / "BRD.md"
        try:
            r = f.resolve()
            if not r.is_file() or (d != r and d not in r.parents):
                return None
            text = r.read_text(encoding="utf-8", errors="replace").replace("\x00", "")
        except Exception:
            return None
        text = text.strip()
        if not text:
            return None
        return text if len(text) <= 190000 else text[:190000] + "\n\n(The rest of this document was cut off.)"

    def sync_urls(self, P: dict) -> dict:
        """Copy repo/staging/production links from project.json and from plugin events to the website."""
        st = self.read_state_file(P)
        fields = {k: st[k] for k in ("repo_url", "staging_url", "production_url") if k in st}
        for env, key in (("staging", "staging_url"), ("production", "production_url")):
            u = P["seen_deploy"].get(env)
            if u and key not in fields:
                fields[key] = u
        if fields:
            self.set_project(P["id"], **fields)
        return st

    # ---- events from the plugin ------------------------------------------------------------------
    def ingest_events(self):
        f = self.events_file
        try:
            st = f.stat()
        except FileNotFoundError:
            return
        pos = self.state.get("events_pos")
        ino = getattr(st, "st_ino", 0)
        if not pos or pos.get("ino") != ino or st.st_size < pos.get("off", 0):
            # a new or replaced (rotated) file is read from the start; events of sessions we do not know are skipped anyway
            pos = {"ino": ino, "off": 0}
        if st.st_size <= pos["off"]:
            self.state["events_pos"] = pos
            return
        try:
            with f.open("rb") as fh:
                fh.seek(pos["off"])
                chunk = fh.read(2_000_000)
        except Exception:
            return
        end = chunk.rfind(b"\n")
        if end < 0:
            return  # no complete line yet
        pos["off"] += end + 1
        self.state["events_pos"] = pos
        for line in chunk[: end + 1].splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if isinstance(ev, dict):
                try:
                    self.on_event(ev)
                except Exception as e:
                    log("event error:", e)

    def on_event(self, ev: dict):
        typ = ev.get("type")
        sessions = self.state["sessions"]
        sid = ev.get("sid") or (ev.get("child") if typ in ("sub_start", "sub_stop") else None)
        if typ == "sub_start":
            parent, child = ev.get("parent"), ev.get("child")
            if parent in sessions and child and child not in sessions:
                sessions[child] = sessions[parent]
            sid = child
        pid = sessions.get(sid) if sid else None
        if not pid and typ == "turn_start" and ev.get("project") in self.projects and sid:
            pid = ev["project"]
            self.map_session(sid, pid, role="orchestrator")
            log("mapped session", sid, "to project", pid[:8], "from the order marker")
        P = self.project(pid) if pid else None
        if not P:
            return
        if typ == "skill":
            self.on_skill(P, ev.get("name") or "")
        elif typ == "turn_start":
            for name in ev.get("skills") or []:
                self.on_skill(P, name)
        elif typ == "tool_end":
            for a in ev.get("actions") or []:
                if not isinstance(a, dict):
                    continue
                if a.get("action") == "deploy" and isinstance(a.get("url"), str) and URL_RE.match(a["url"]) and not BAD_HOST_RE.match(a["url"]):
                    if a.get("env") in ("staging", "production"):
                        P["seen_deploy"][a["env"]] = a["url"]
                elif a.get("action") == "repo" and isinstance(a.get("repo"), str) and re.fullmatch(r"[\w.-]+/[\w.-]+", a["repo"]):
                    self.set_project(P["id"], repo_url="https://github.com/" + a["repo"])

    def on_skill(self, P: dict, name: str):
        stage = SKILL_STAGE.get(name)
        if not stage:
            return
        if name not in P["skills"]:
            P["skills"].append(name)
        if stage == "kickoff" or P["status"] not in ACTIVE_STATUSES:
            return
        if stage != "discovery" and not P["brd_approved"]:
            return  # nothing may move past discovery before the user approved the BRD
        cur = PHASE_ORDER.index(P["phase"]) if P.get("phase") in PHASE_ORDER else -1
        if PHASE_ORDER.index(stage) > cur:
            self.set_status(P, STATUS_FOR_PHASE[stage], stage)
            log(f"project {P['id'][:8]}: {stage}")

    # ---- orders ---------------------------------------------------------------------------------
    def handle_order(self, o: dict):
        oid, pid, kind, text = o["order_id"], o["project_id"], o["kind"], (o.get("text") or "").strip()
        P = self.project(pid)
        done = lambda note, st="done": self.update_order(oid, st, note)
        if kind == "start_project":
            if P is not None:
                return done("This project was already started")
            P = self.new_project(pid, text)
            self.add_cmd(P, {"id": oid, "kind": "start_project", "text": text})
            return
        if P is None:
            return done("Hermes does not know this project (the bridge state was reset). Start a new project.", "failed")
        if kind == "stop":
            return self.do_stop(P, oid)
        if kind == "resume":
            return self.do_resume(P, oid)
        if P["status"] in ("stopped", "failed") and kind in ("message", "request_brd_changes", "change_request", "approve_brd"):
            return done(f"The project is {P['status']}. Press Resume first.", "failed")
        if kind == "message":
            self.add_cmd(P, {"id": oid, "kind": "message", "text": text})
        elif kind == "request_brd_changes":
            if P["brd_approved"]:
                return done("The BRD is already approved. Use a change request after the release.", "failed")
            self.add_cmd(P, {"id": oid, "kind": "request_brd_changes", "text": text})
        elif kind == "approve_brd":
            if P["brd_approved"]:
                return done("The BRD was already approved")
            if P["status"] != "awaiting_brd_approval" and not (P["status"] == "queued" and P.get("resume_status") == "awaiting_brd_approval"):
                return done("There is no BRD waiting for approval yet.", "failed")
            P["brd_approved"] = True
            P["flow"] = {"auto": self.s["auto_after_brd"], "count": 0}
            P["cycle_order"] = oid
            self.set_project(pid, brd_approved_at=iso_now())
            self.add_cmd(P, {"id": oid, "kind": "approve_brd", "text": APPROVE_PROMPT, "cycle": True})
        elif kind == "change_request":
            if P["status"] != "released":
                return done("A change can be requested after the site is released.", "failed")
            P["cycle"] += 1
            P["skills"] = []
            P["flow"] = {"auto": True, "count": 0}
            P["cycle_order"] = oid
            st = self.read_state_file(P)
            P["rel_before"], P["prod_before"] = st.get("release_number"), st.get("production_url")
            self.add_cmd(P, {"id": oid, "kind": "change_request", "text": text, "cycle": True})
        else:
            done(f"Unknown order kind {kind}", "failed")

    def add_cmd(self, P: dict, cmd: dict):
        cmd.setdefault("auto", False)
        P["pending"].append(cmd)
        if P["waiting_since"] is None:
            P["waiting_since"] = self.now()

    def do_stop(self, P: dict, oid):
        P["flow"] = {"auto": False, "count": 0}
        for c in P["pending"]:
            if c.get("id") is not None:
                self.update_order(c["id"], "done", "Cancelled because the project was stopped")
        P["pending"] = []
        P["paused"] = None
        P["waiting_since"] = None
        act = self.state.get("active")
        if act and act["pid"] == P["id"]:
            P["stopping"] = True
            code, _ = self.api("POST", f"/v1/runs/{act['run']}/stop", {})
            if code >= 300 or code == 0:
                log("stop request answered", code)
        if P["cycle_order"] is not None:
            self.update_order(P["cycle_order"], "done", "Stopped by the user")
            P["cycle_order"] = None
        self.set_status(P, "stopped")
        self.update_order(oid, "done", "Stopped")
        log(f"project {P['id'][:8]}: stopped")

    def do_resume(self, P: dict, oid):
        if P["paused"]:
            self.unpause(P, "Resumed by the user")
            return self.update_order(oid, "done", "Trying again now")
        if P["status"] not in ("stopped", "failed"):
            return self.update_order(oid, "done", "The project is already working")
        P["stopping"] = False
        if not P["session"]:  # it never ran: start it again from the idea
            self.add_cmd(P, {"id": oid, "kind": "start_project", "text": P["idea"]})
            return
        P["flow"] = {"auto": bool(P["brd_approved"] and self.s["auto_after_brd"]), "count": 0}
        P["cycle_order"] = oid if P["flow"]["auto"] else None
        self.add_cmd(P, {"id": oid, "kind": "resume", "text": RESUME_PROMPT, "cycle": P["flow"]["auto"]})

    # ---- pause (usage limits) ---------------------------------------------------------------------
    def enter_pause(self, P: dict, cmd: dict, text: str):
        prev = P["paused"]["prev_status"] if P["paused"] else P["status"]
        tries = P.get("limit_tries", 0) + 1
        P["limit_tries"] = tries
        if tries > self.s["limit_max_retries"]:
            P["flow"]["auto"] = False
            self.set_status(P, "failed")
            self.finish_order(P, cmd, "failed", f"Claude kept hitting its usage limit ({tries - 1} retries). Press Resume to try again.")
            return
        wait = parse_wait_seconds(text, self.now())
        secs = self.s["backoff"] if wait is None else min(max(wait, 1), 6 * 3600)
        until = self.now() + secs
        P["paused"] = {"until": until, "tries": tries, "prev_status": prev}
        retry = dict(cmd, retry=True)
        P["pending"].insert(0, retry)
        P["waiting_since"] = P["waiting_since"] or self.now()
        when = datetime.fromtimestamp(until, timezone.utc).strftime("%H:%M UTC")
        note = f"Paused: Claude's usage limit was reached. Hermes will try again at {when}."
        self.set_status(P, "paused")
        for oid in {c.get("id") for c in [cmd]} | {P["cycle_order"]}:
            if oid is not None:
                self.update_order(oid, "waiting", note)
        log(f"project {P['id'][:8]}: paused until {when} (try {tries})")

    def unpause(self, P: dict, why: str):
        info = P["paused"]
        P["paused"] = None
        for c in P["pending"]:
            c["not_before"] = 0
        self.set_status(P, info["prev_status"] if info and info["prev_status"] != "paused" else "development")
        log(f"project {P['id'][:8]}: {why}")

    # ---- running ------------------------------------------------------------------------------------
    def extra_lines(self) -> str:
        lines = ""
        if self.s["github_owner"]:
            lines += f"GitHub owner: {self.s['github_owner']}\n"
        if self.s["template_repo"]:
            lines += f"Template repository: {self.s['template_repo']}\n"
        if self.s["devin_max_acu"]:
            lines += f"Devin limit: {self.s['devin_max_acu']} ACU per task (always pass max_acu_limit)\n"
        return lines

    def build_prompt(self, P: dict, cmd: dict) -> str:
        kind, text = cmd["kind"], cmd["text"]
        mark = f"\n\n(hermes-project:{P['id']})"
        if kind == "start_project":
            ctx = START_CONTEXT.format(pid=P["id"], slug=P["slug"], workdir=P["workdir"], extra=self.extra_lines())
            body = f"/sdlc-orchestrator {text}\n\n{ctx}"
        elif kind == "change_request":
            ctx = CHANGE_CONTEXT.format(pid=P["id"], workdir=P["workdir"], extra=self.extra_lines())
            body = f"/sdlc-change-request {text}\n\n{ctx}"
        elif kind == "request_brd_changes":
            body = BRD_CHANGES_PROMPT.format(text=text)
        else:
            body = text
        if cmd.get("retry"):
            body = LIMIT_PREFIX + body
        return body + mark

    def begin_status(self, P: dict, cmd: dict):
        kind = cmd["kind"]
        if kind == "start_project":
            self.set_status(P, "discovery", "discovery")
        elif kind == "approve_brd":
            self.set_status(P, "architecture", "architecture")
        elif kind == "change_request":
            self.set_status(P, "development", "development")
        elif kind == "request_brd_changes":
            self.set_status(P, "discovery", "discovery")
        elif kind == "resume":
            ph = P.get("phase")
            self.set_status(P, STATUS_FOR_PHASE.get(ph, "discovery"), ph or "discovery")
        elif P["status"] == "queued":  # a message that waited its turn
            self.set_status(P, P.get("resume_status") or "discovery")
        P["resume_status"] = None

    def start_run(self, P: dict, cmd: dict) -> bool:
        if not P["session"] or (cmd["kind"] == "start_project" and not cmd.get("retry")):
            P["session"] = f"hermes-{P['id'][:8]}-{int(self.now())}"
            P["mapped"] = False
            Path(P["workdir"]).mkdir(parents=True, exist_ok=True)
        if not P["mapped"]:
            self.map_session(P["session"], P["id"], role="orchestrator")
            P["mapped"] = True
            self.flush_outbox()  # the plugin's first events should find the mapping already in place
        code, data = self.api("POST", "/v1/runs", {"input": self.build_prompt(P, cmd), "session_id": P["session"]})
        if code == 429:  # Hermes itself is busy (not a Claude limit): try again in a moment
            cmd["not_before"] = self.now() + 5
            P["pending"].insert(0, cmd)
            self.update_order(cmd["id"], "waiting", "Hermes is busy, trying again in a moment")
            return False
        if code == 0 or code >= 300 or not isinstance(data, dict) or not data.get("run_id"):
            msg = data.get("error", {}).get("message") if isinstance(data, dict) and isinstance(data.get("error"), dict) else data
            log("run start failed", code, clip(msg, 200))
            if code == 0:  # Hermes is down: keep the order and try again soon
                cmd["not_before"] = self.now() + 10
                P["pending"].insert(0, cmd)
                self.update_order(cmd["id"], "waiting", "Hermes is not answering, trying again in a moment")
                return False
            P["flow"]["auto"] = False
            self.begin_status(P, cmd)
            self.set_status(P, "failed" if cmd["kind"] in ("start_project", "approve_brd", "change_request", "resume") else P["status"])
            self.finish_order(P, cmd, "failed", f"Hermes refused the order ({code}): {clip(msg, 200)}")
            return False
        self.begin_status(P, cmd)
        self.state["active"] = {"pid": P["id"], "cmd": cmd, "run": data["run_id"], "since": self.now(), "last": None, "final": None}
        self.state["slot"] = P["id"]
        P["waiting_since"] = None
        self.update_order(cmd["id"], "running", "Hermes is working on it", data["run_id"])
        log(f"order {cmd['id']} ({cmd['kind']}) -> run {data['run_id']} for project {P['id'][:8]}")
        return True

    def finish_order(self, P: dict, cmd: dict, status: str, note: str):
        """End an order. Orders that open an autonomous stretch (approve, change, resume) stay open until it ends."""
        if cmd.get("id") is not None and (status != "done" or not cmd.get("cycle")):
            self.update_order(cmd["id"], status, note)
        if status == "failed" and P.get("cycle_order") is not None and cmd.get("id") != P["cycle_order"]:
            self.update_order(P["cycle_order"], "failed", note)
            P["cycle_order"] = None
        elif status == "failed" and cmd.get("cycle"):
            P["cycle_order"] = None

    def decide_approval(self, ap: dict) -> Optional[bool]:
        what = " ".join(str(ap.get(k) or "") for k in ("command", "description"))
        if is_dangerous(what):
            return False
        return True if self.s["auto_approve"] else None

    def poll_active(self):
        act = self.state.get("active")
        if not act:
            return
        P = self.project(act["pid"])
        if act.get("final"):
            if self.now() - act["final"]["at"] >= self.s["settle"]:
                self.finalize(P, act)
            return
        code, data = self.api("GET", f"/v1/runs/{act['run']}")
        if code == 404:
            self.state["active"] = None
            if P:
                P["flow"]["auto"] = False
                if P["status"] != "stopped":
                    self.set_status(P, "failed")
                self.finish_order(P, act["cmd"], "failed", "Hermes lost this run (was the gateway restarted?). Press Resume to go on.")
            return
        if code == 0 or code >= 300 or not isinstance(data, dict):
            return
        status = data.get("status")
        if status == "waiting_for_approval":
            ap = data.get("approval") or {}
            rid = ap.get("request_id") or ap.get("id")
            if act.get("answered") == rid and rid:
                return
            verdict = self.decide_approval(ap)
            if verdict is None:
                self.update_order(act["cmd"].get("id"), "waiting", "Hermes is waiting for a command to be approved")
                return
            body = {"choice": "once" if verdict else "deny"}
            if rid:
                body["request_id"] = rid
            c, _ = self.api("POST", f"/v1/runs/{act['run']}/approval", body)
            if c < 300 and c != 0:
                act["answered"] = rid
                what = clip(ap.get("description") or ap.get("command") or "a command", 160)
                log(("approved: " if verdict else "DENIED (dangerous): ") + what)
            return
        if status in TERMINAL:
            out = data.get("output") or data.get("error") or ""
            if isinstance(out, (dict, list)):
                out = json.dumps(out)
            act["final"] = {"status": status, "out": str(out).strip(), "at": self.now()}
            # events the plugin wrote just before the end are read before we decide anything
            return
        if act.get("last") != status:
            act["last"] = status

    def finalize(self, P: Optional[dict], act: dict):
        self.state["active"] = None
        fin = act["final"]
        status, out, cmd = fin["status"], fin["out"], act["cmd"]
        if P is None:
            return
        log(f"run {act['run']} {status}")
        if P["stopping"]:
            P["stopping"] = False
            if cmd.get("id") is not None and not cmd.get("cycle"):
                self.update_order(cmd["id"], "done", "Stopped")
            return
        if status == "cancelled" or status == "interrupted":
            P["flow"]["auto"] = False
            self.set_status(P, "stopped")
            self.finish_order(P, cmd, "failed", "The run was cancelled in Hermes. Press Resume to go on.")
            return
        if is_usage_limit(status, out):
            self.enter_pause(P, cmd, out)
            return
        if status != "completed":
            note = f"Hermes could not finish: {clip(out, 200) or status}"
            was_auto = P["flow"]["auto"] or cmd.get("cycle") or cmd.get("auto")
            P["flow"]["auto"] = False
            P["pending"] = [c for c in P["pending"] if c.get("id") is not None]
            if was_auto or cmd["kind"] in ("start_project",):
                self.set_status(P, "failed")
            elif P["status"] in ACTIVE_STATUSES:
                self.set_status(P, P["status"])  # discovery questions continue; the user can send a new message
            self.finish_order(P, cmd, "failed", note)
            return
        self.on_completed(P, cmd, out)

    def on_completed(self, P: dict, cmd: dict, out: str):
        P["limit_tries"] = 0  # a run that finishes normally ends a series of usage-limit pauses
        st = self.sync_urls(P)
        was_awaiting = P["status"] == "awaiting_brd_approval" or P.get("resume_status") == "awaiting_brd_approval"
        if not P["brd_approved"]:
            brd = self.read_brd(P)
            digest = hashlib.sha256(brd.encode()).hexdigest() if brd else ""
            if brd and (digest != P["brd_hash"] or APPROVE_ASK_RE.search(out) or was_awaiting):
                if digest != P["brd_hash"]:
                    P["brd_hash"] = digest
                    self.set_project(P["id"], brd_markdown=brd)
                self.set_status(P, "awaiting_brd_approval", "discovery")
                log(f"project {P['id'][:8]}: BRD ready, waiting for the user's approval")
            else:
                self.set_status(P, "discovery", "discovery")
        # order bookkeeping
        if cmd.get("id") is not None and not cmd.get("cycle"):
            self.update_order(cmd["id"], "done", clip(out, 280) or "Done")
        # autonomous stretch
        if P["flow"]["auto"]:
            if self.release_done(P, st, out):
                self.finish_release(P, st, out)
            else:
                self.schedule_auto(P, out)

    def release_done(self, P: dict, st: dict, out: str) -> bool:
        """The Release skill writes production_url (and a higher release_number) in project.json after the site is live.
        As a second signal, its closing message may say 'live: <url>' once sdlc-release was loaded in this cycle."""
        if st.get("production_url"):
            if st.get("release_number") is not None or P["rel_before"] is not None:
                if st.get("release_number") != P["rel_before"]:
                    return True
            elif st["production_url"] != P["prod_before"]:
                return True
        return bool(LIVE_RE.search(out)) and "sdlc-release" in P["skills"]

    def finish_release(self, P: dict, st: dict, out: str):
        url = st.get("production_url") or P["seen_deploy"].get("production")
        if not url:
            m = LIVE_RE.search(out)
            url = m.group(1).rstrip(".,;:") if m else None
            if url and (BAD_HOST_RE.match(url) or len(url) > 2000):
                url = None
        fields: Dict[str, Any] = {}
        if url:
            fields["production_url"] = url
        P["flow"] = {"auto": False, "count": 0}
        P["pending"] = [c for c in P["pending"] if c.get("id") is not None]
        self.set_status(P, "released", "release", **fields)
        if P["cycle_order"] is not None:
            self.update_order(P["cycle_order"], "done", f"Released{': ' + url if url else ''}")
            P["cycle_order"] = None
        log(f"project {P['id'][:8]}: released {url or ''}")

    def schedule_auto(self, P: dict, out: str):
        f = P["flow"]
        if any(c.get("id") is not None for c in P["pending"]):
            return  # the user sent something; that goes first
        if f["count"] >= self.s["auto_max"]:
            f["auto"] = False
            self.set_status(P, "failed")
            if P["cycle_order"] is not None:
                self.update_order(P["cycle_order"], "failed", f"Stopped after {self.s['auto_max']} automatic steps. Press Resume to go on.")
                P["cycle_order"] = None
            log(f"project {P['id'][:8]}: stopped after {self.s['auto_max']} automatic steps")
            return
        f["count"] += 1
        wait = self.s["auto_wait"] if BUSY_RE.search(out) else 0
        if wait:
            log(f"helpers still working; continuing in {int(wait)} s")
        self.add_cmd(P, {"id": None, "kind": "message", "text": AUTO_GO, "auto": True, "not_before": self.now() + wait})

    # ---- scheduling (one project at a time) -----------------------------------------------------------
    def runnable(self, P: dict) -> Optional[dict]:
        if P["paused"]:
            return None
        now = self.now()
        user = [c for c in P["pending"] if c.get("id") is not None and c.get("not_before", 0) <= now]
        if user:
            return user[0]
        auto = [c for c in P["pending"] if c.get("id") is None and c.get("not_before", 0) <= now]
        return auto[0] if auto else None

    def schedule(self):
        if self.state.get("active"):
            return
        # pauses end by themselves
        for P in self.projects.values():
            if P["paused"] and self.now() >= P["paused"]["until"]:
                self.unpause(P, "back-off over, trying again")
        slot = self.state.get("slot")
        if slot:
            P = self.project(slot)
            if P is None:
                self.state["slot"] = None
            else:
                cmd = self.runnable(P)
                if cmd:
                    self.start_pending(P, cmd)
                    return
                busy = P["paused"] or P["flow"]["auto"] or P["pending"]
                if busy:
                    return  # keeps the slot: waiting for a pause to end, a helper, or the next automatic step
                self.state["slot"] = None
        # the slot is free: the project that has waited longest goes next
        waiting = [P for P in self.projects.values() if self.runnable(P)]
        if waiting:
            waiting.sort(key=lambda p: p["waiting_since"] or 0)
            P = waiting[0]
            self.start_pending(P, self.runnable(P))

    def start_pending(self, P: dict, cmd: dict):
        P["pending"] = [c for c in P["pending"] if c is not cmd]
        self.state["slot"] = P["id"]
        if not self.start_run(P, cmd):
            return

    def refresh_queue_marks(self):
        """Projects that have to wait for the slot show 'queued'; they get their old status back when they start."""
        slot = self.state.get("slot")
        active = self.state.get("active")
        holder = slot or (active["pid"] if active else None)
        waiting = [P for P in self.projects.values() if P["pending"] and not P["paused"] and P["id"] != holder]
        waiting.sort(key=lambda p: p["waiting_since"] or 0)
        for i, P in enumerate(waiting):
            if holder is None:
                break
            note = f"Another project is running. Yours is number {i + 1} in line."
            if P["status"] != "queued":
                P["resume_status"] = P["status"]
                self.set_status(P, "queued")
            if P.get("queue_note") != note:
                P["queue_note"] = note
                for c in P["pending"]:
                    if c.get("id") is not None:
                        self.update_order(c["id"], "waiting", note)
        for P in self.projects.values():
            if P not in waiting:
                P["queue_note"] = None

    # ---- main loop ----------------------------------------------------------------------------------------
    def tick(self):
        try:
            new = self.rpc("platform_take_orders", {"write_key": self.wk(), "max_rows": 5}) or []
        except RpcError as e:
            log(e)
            new = []
        for o in new:
            try:
                self.handle_order(o)
            except Exception as e:
                log("error handling order", o.get("order_id"), e)
                self.update_order(o.get("order_id"), "failed", f"The bridge could not handle this order: {e}")
        if new:
            self.save()  # the orders are claimed in the database; never lose them
        self.ingest_events()
        self.poll_active()
        self.schedule()
        self.refresh_queue_marks()
        self.flush_outbox()
        self.save()

    def run(self):
        log("hermes-platform bridge started. Hermes API:", self.s["api_url"], "| Supabase:", self.s["supabase_url"])
        code, _ = self.api("GET", "/health")
        if code == 0 or code >= 300:
            log(f"warning: the Hermes API server answered {code} on /health. Is API_SERVER_ENABLED=true and the gateway running?")
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stop_flag", True))
        while not self.stop_flag:
            try:
                self.tick()
            except Exception as e:
                log("error:", e)
            time.sleep(self.s["poll"])
        self.save()
        log("stopped")


def check(s: dict) -> int:
    """--check: settings are present, Supabase accepts the key, Hermes answers. Prints plain words."""
    ok = True
    b = Bridge(s)
    try:
        b.rpc("platform_ingest", {"write_key": s["write_key"], "events": []})
        print("ok   Supabase accepted the write key")
    except Exception as e:
        ok = False
        print("FAIL Supabase:", clip(e, 200))
    code, _ = b.api("GET", "/health")
    if 0 < code < 300:
        print("ok   the Hermes API server answers")
    else:
        ok = False
        print(f"FAIL the Hermes API server answered {code} on /health (is API_SERVER_ENABLED=true and the gateway running?)")
    return 0 if ok else 1


def main(argv: List[str]) -> int:
    if "--check" in argv:
        return check(load_settings())
    Bridge(load_settings()).run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
