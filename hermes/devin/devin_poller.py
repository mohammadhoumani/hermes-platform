#!/usr/bin/env python3
"""Devin session poller: Devin sessions -> platform events (`devin_status`).

Python 3 standard library only. The sdlc-development skill adds one line to a local file every time it
creates a Devin session (see hermes/devin/README.md):

    ~/.hermes/platform/devin_sessions.json     one JSON object per line, or {"sessions": [ ... ]}, or a list

    {"session_id": "devin-abc123", "project_id": "<project uuid>", "task": "Task 3", "branch": "feature/x"}

This poller asks the Devin API about each of those sessions and, when the status or the pull request
changes, calls `emit(event)` with a platform event:

    {"v": 1, "ts": 1760000000, "type": "devin_status", "project": "<project uuid or null>",
     "sid": "devin-abc123", "session_id": "devin-abc123",
     "status": "working|blocked|finished|failed|suspended|unknown", "raw_status": "<Devin's own word>",
     "pr": "https://github.com/o/r/pull/6" or null, "pr_url": same, "finished": false, "text": "..."}

The bridge can import this module and call `DevinPoller.poll_once()` from its loop, or run this file as a
service that appends the events to a file.

    DEVIN_API_KEY=... devin_poller.py                    poll forever, events as JSON lines on stdout
    DEVIN_API_KEY=... devin_poller.py --once             poll one time and exit
    devin_poller.py --events-file FILE --bridge-state ~/.hermes/platform/bridge_state.json

API: version 1, `GET {base}/v1/sessions/{id}` with `Authorization: Bearer <key>`. If the key starts with
`cog_` and an organization id is given (--org-id or DEVIN_ORG_ID) it uses version 3 instead,
`GET {base}/v3/organizations/{org}/sessions/{id}`. The key is never printed or written anywhere.

Nothing here talks to any server except the one in `base_url` (default https://api.devin.ai).
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

DEFAULT_BASE_URL = "https://api.devin.ai"
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$")
URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(:\d+)?(/[^\s]*)?$")
# Projects in these bridge statuses can still have Devin work to report.
ACTIVE_PROJECT_STATUSES = {"discovery", "architecture", "development", "review", "qa", "releasing", "paused"}
TERMINAL = {"finished", "failed"}
MAX_SESSIONS_PER_CYCLE = 50

# Devin's own words -> our small set. Unknown words count as "working" so a new Devin status never hides progress.
_STATUS_MAP = {
    # API v1 status_enum
    "working": "working", "resumed": "working", "resume_requested": "working", "resume_requested_frontend": "working",
    "blocked": "blocked",
    "finished": "finished",
    "expired": "failed",
    "suspend_requested": "suspended", "suspend_requested_frontend": "suspended", "suspended": "suspended",
    # API v3 status
    "new": "working", "claimed": "working", "running": "working", "resuming": "working",
    "exit": "finished", "error": "failed",
    # words seen in the plain `status` field
    "stopped": "failed", "failed": "failed", "completed": "finished", "done": "finished",
}
_TEXT = {
    "working": "Devin is working",
    "blocked": "Devin is waiting for an answer",
    "finished": "Devin finished",
    "failed": "Devin stopped without finishing",
    "suspended": "Devin is paused",
    "unknown": "Devin session status is unknown",
}


class DevinError(Exception):
    """A request to the Devin API failed. `code` is the HTTP status, or 0 for a network problem."""

    def __init__(self, message: str, code: int = 0):
        super().__init__(message)
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects: the Authorization header must only go to the server we chose."""

    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


def normalize_status(raw: object) -> str:
    word = str(raw or "").strip().lower()
    if not word:
        return "unknown"
    return _STATUS_MAP.get(word, "working")


def _clean_url(value: object) -> Optional[str]:
    if isinstance(value, str) and len(value) <= 500 and URL_RE.match(value.strip()):
        return value.strip()
    return None


def extract_pr(data: dict) -> Optional[str]:
    """Pull request address from a v1 (`pull_request.url`) or v3 (`pull_requests[].pr_url`) answer."""
    pr = data.get("pull_request")
    if isinstance(pr, dict):
        url = _clean_url(pr.get("url"))
        if url:
            return url
    prs = data.get("pull_requests")
    if isinstance(prs, list):
        for item in prs:
            url = _clean_url(item.get("pr_url") or item.get("url")) if isinstance(item, dict) else None
            if url:
                return url
    return None


def read_sessions(path: Path) -> List[dict]:
    """Read the sessions file. Accepts JSON Lines, {"sessions": [...]}, or a bare list. Bad lines are skipped."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    items: List[object] = []
    try:
        whole = json.loads(text)
        if isinstance(whole, dict):
            items = whole["sessions"] if isinstance(whole.get("sessions"), list) else [whole]
        elif isinstance(whole, list):
            items = whole
    except ValueError:  # several lines, one JSON object each
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except ValueError:
                continue
    out: Dict[str, dict] = {}
    for item in items:
        if isinstance(item, str):
            item = {"session_id": item}
        if not isinstance(item, dict):
            continue
        sid = item.get("session_id") or item.get("id")
        if not isinstance(sid, str) or not SESSION_RE.match(sid):
            continue
        pid = item.get("project_id") or item.get("project")
        out[sid] = {"session_id": sid, "project_id": pid if isinstance(pid, str) and pid else None,
                    "task": item.get("task") if isinstance(item.get("task"), str) else None}
    return list(out.values())


def active_projects_from_bridge_state(path: Path) -> Callable[[str], bool]:
    """A function `is_active(project_id)` that reads the bridge's state file on every call (the file changes)."""

    def is_active(project_id: str) -> bool:
        try:
            state = json.loads(Path(path).read_text(encoding="utf-8"))
            return state["projects"][project_id].get("status") in ACTIVE_PROJECT_STATUSES
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return False

    return is_active


class DevinPoller:
    def __init__(
        self,
        api_key: str,
        sessions_file: Path,
        emit: Callable[[dict], None],
        *,
        base_url: str = DEFAULT_BASE_URL,
        org_id: Optional[str] = None,
        is_active: Optional[Callable[[str], bool]] = None,
        state_file: Optional[Path] = None,
        timeout: float = 15.0,
        log: Optional[Callable[..., None]] = None,
        now: Callable[[], float] = time.time,
    ):
        if not api_key:
            raise ValueError("A Devin API key is needed")
        self._key = api_key
        self.sessions_file = Path(sessions_file)
        self.emit = emit
        self.base_url = base_url.rstrip("/")
        self.org_id = org_id or None
        self.is_active = is_active
        self.state_file = Path(state_file) if state_file else self.sessions_file.with_name("devin_poller_state.json")
        self.timeout = timeout
        self.log = log or (lambda *a: print("devin_poller:", *a, file=sys.stderr))
        self.now = now
        self.api_version = "v3" if (self._key.startswith("cog_") and self.org_id) else "v1"
        self._opener = urllib.request.build_opener(_NoRedirect)
        self._seen = self._load_state()
        self._last_error: Optional[str] = None

    # ---- state: what we already told the platform --------------------------------------------------
    def _load_state(self) -> Dict[str, dict]:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_state(self) -> None:
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(self.state_file.parent), prefix=".devin_poller_", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._seen, f)
            os.replace(tmp, self.state_file)
        except OSError as e:
            self.log("could not save state:", e)

    # ---- the Devin API -----------------------------------------------------------------------------
    def session_url(self, session_id: str) -> str:
        sid = urllib.parse.quote(session_id, safe="")
        if self.api_version == "v3":
            return f"{self.base_url}/v3/organizations/{urllib.parse.quote(str(self.org_id), safe='')}/sessions/{sid}"
        return f"{self.base_url}/v1/sessions/{sid}"

    def fetch(self, session_id: str) -> dict:
        req = urllib.request.Request(self.session_url(session_id), headers={
            "Authorization": "Bearer " + self._key, "Accept": "application/json", "User-Agent": "hermes-platform-devin-poller"})
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                body = resp.read(1_000_000)
        except urllib.error.HTTPError as e:
            raise DevinError(f"Devin answered HTTP {e.code}", e.code) from None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise DevinError("could not reach Devin: " + type(e).__name__) from None
        try:
            data = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            raise DevinError("Devin sent something that is not JSON") from None
        if not isinstance(data, dict):
            raise DevinError("Devin sent an unexpected answer")
        return data

    # ---- one cycle ---------------------------------------------------------------------------------
    def make_event(self, entry: dict, status: str, raw: str, pr: Optional[str]) -> dict:
        text = _TEXT.get(status, _TEXT["unknown"])
        if pr:
            text += ". Pull request: " + pr
        if entry.get("task"):
            text = f"{entry['task']}: {text}"
        return {"v": 1, "ts": int(self.now()), "type": "devin_status", "project": entry.get("project_id"),
                "sid": entry["session_id"], "session_id": entry["session_id"], "status": status, "raw_status": raw,
                "pr": pr, "pr_url": pr, "finished": status in TERMINAL, "text": text}

    def poll_once(self) -> List[dict]:
        """Check every session that needs it. Returns the events that were emitted."""
        events: List[dict] = []
        entries = read_sessions(self.sessions_file)
        polled = 0
        for entry in entries:
            sid = entry["session_id"]
            prev = self._seen.get(sid, {})
            if prev.get("done"):
                continue
            pid = entry.get("project_id")
            if pid and self.is_active and not self.is_active(pid):
                continue
            if polled >= MAX_SESSIONS_PER_CYCLE:
                break
            polled += 1
            try:
                data = self.fetch(sid)
            except DevinError as e:
                if e.code == 404:
                    status, raw, pr = "unknown", "not_found", None
                    data = {}
                else:
                    msg = str(e)
                    if msg != self._last_error:  # say each problem once, not every cycle
                        self.log(sid, msg)
                        self._last_error = msg
                    continue
            else:
                raw = str(data.get("status_enum") or data.get("status") or "")
                status = normalize_status(raw)
                pr = extract_pr(data)
            self._last_error = None
            if status == prev.get("status") and pr == prev.get("pr"):
                continue
            ev = self.make_event(entry, status, raw, pr)
            self._seen[sid] = {"status": status, "pr": pr, "done": status in TERMINAL or raw == "not_found"}
            self._save_state()
            try:
                self.emit(ev)
            except Exception as e:  # a broken callback must not stop the poller
                self.log("emit failed:", type(e).__name__)
                self._seen[sid] = prev  # try again next cycle
                self._save_state()
                continue
            events.append(ev)
        return events

    def run(self, interval: float = 20.0, stop: Optional[Callable[[], bool]] = None) -> None:
        while not (stop and stop()):
            try:
                self.poll_once()
            except Exception as e:  # keep going whatever happens
                self.log("poll failed:", type(e).__name__, e)
            time.sleep(interval)


def main(argv: Optional[Iterable[str]] = None) -> int:
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    data = home / "platform"
    ap = argparse.ArgumentParser(description="Poll Devin sessions and emit devin_status events (JSON lines).")
    ap.add_argument("--sessions-file", default=str(data / "devin_sessions.json"))
    ap.add_argument("--state-file", default=None, help="what was already reported (default: next to the sessions file)")
    ap.add_argument("--bridge-state", default=None, help="only poll sessions of projects that are active in this bridge_state.json")
    ap.add_argument("--events-file", default=None, help="append events here (default: print to stdout)")
    ap.add_argument("--base-url", default=os.environ.get("DEVIN_API_BASE", DEFAULT_BASE_URL))
    ap.add_argument("--org-id", default=os.environ.get("DEVIN_ORG_ID"))
    ap.add_argument("--interval", type=float, default=20.0)
    ap.add_argument("--once", action="store_true")
    opt = ap.parse_args(list(argv) if argv is not None else None)

    key = os.environ.get("DEVIN_API_KEY", "").strip()
    if not key:
        print("Set DEVIN_API_KEY in the environment (a cog_ key from Devin settings).", file=sys.stderr)
        return 2

    def emit(ev: dict) -> None:
        line = json.dumps(ev, separators=(",", ":"))
        if opt.events_file:
            Path(opt.events_file).parent.mkdir(parents=True, exist_ok=True)
            with open(opt.events_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        else:
            print(line, flush=True)

    poller = DevinPoller(
        key, Path(opt.sessions_file), emit, base_url=opt.base_url, org_id=opt.org_id,
        is_active=active_projects_from_bridge_state(Path(opt.bridge_state)) if opt.bridge_state else None,
        state_file=Path(opt.state_file) if opt.state_file else None)
    if opt.once:
        poller.poll_once()
        return 0
    try:
        poller.run(opt.interval)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
