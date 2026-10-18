"""agent-room: stream Hermes agent activity to the Agent Room dashboard.

Every hook here is an observer. Callbacks only build a small, sanitized dict and drop it on an
in-memory queue; a background thread appends it to ``$HERMES_HOME/agent-room/events.jsonl``.
Callbacks never block, never raise, and always return ``None`` (so ``pre_tool_call`` never
blocks or modifies a tool call).

What leaves the agent process: event type, timestamps, session ids, tool names, short redacted
summaries (commands, file paths, commit messages, PR numbers), and clipped message text.
File contents, tool results and secrets are not written.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SCHEMA = 1
MAX_FILE_BYTES = 20 * 1024 * 1024  # rotate to events.1.jsonl past this size

# ---------------------------------------------------------------------------
# Output location + writer thread
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _events_path() -> Path:
    override = os.environ.get("AGENT_ROOM_EVENTS")
    return Path(override).expanduser() if override else _hermes_home() / "agent-room" / "events.jsonl"


_queue: "queue.Queue[dict]" = queue.Queue(maxsize=20000)
_writer_started = False
_writer_lock = threading.Lock()


def _writer_loop() -> None:
    path = _events_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    while True:
        item = _queue.get()
        batch = [item]
        try:  # drain whatever else is waiting so we write in one go
            while len(batch) < 500:
                batch.append(_queue.get_nowait())
        except queue.Empty:
            pass
        try:
            if path.exists() and path.stat().st_size > MAX_FILE_BYTES:
                path.replace(path.with_name(path.stem + ".1.jsonl"))
            with path.open("a", encoding="utf-8") as fh:
                for ev in batch:
                    fh.write(json.dumps(ev, ensure_ascii=False, default=str) + "\n")
        except Exception:
            logger.debug("agent-room: write failed", exc_info=True)
        _cloud.add(batch)


# ---------------------------------------------------------------------------
# Optional cloud sender (Supabase). Config: $HERMES_HOME/agent-room/config.json
#   {"supabase_url": "https://xxxx.supabase.co", "supabase_key": "sb_publishable_...",
#    "write_key": "<from setup.sql>"}
# Env vars AGENT_ROOM_SUPABASE_URL / _SUPABASE_KEY / _WRITE_KEY / _REST_URL override it.
# Network trouble never reaches the agent: events wait in memory (bounded) and retry.
# ---------------------------------------------------------------------------


def _load_cloud_config() -> Dict[str, str]:
    cfg: Dict[str, str] = {}
    try:
        p = _hermes_home() / "agent-room" / "config.json"
        if p.exists():
            cfg.update({k: str(v) for k, v in json.loads(p.read_text(encoding="utf-8")).items() if v})
    except Exception:
        logger.warning("agent-room: could not read config.json", exc_info=True)
    for key, env in (("supabase_url", "AGENT_ROOM_SUPABASE_URL"), ("supabase_key", "AGENT_ROOM_SUPABASE_KEY"),
                     ("write_key", "AGENT_ROOM_WRITE_KEY"), ("rest_url", "AGENT_ROOM_REST_URL")):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg


class _CloudSender:
    MAX_PENDING = 5000
    BATCH = 200

    def __init__(self) -> None:
        self._pending: List[dict] = []
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._started = False
        self._cfg: Optional[Dict[str, str]] = None
        self.last_error: Optional[str] = None
        self.sent = 0

    def _config(self) -> Dict[str, str]:
        if self._cfg is None:
            self._cfg = _load_cloud_config()
        return self._cfg

    def enabled(self) -> bool:
        c = self._config()
        return bool((c.get("rest_url") or c.get("supabase_url")) and c.get("write_key"))

    def add(self, batch: List[dict]) -> None:
        if not self.enabled():
            return
        with self._lock:
            self._pending.extend(batch)
            if len(self._pending) > self.MAX_PENDING:
                del self._pending[: len(self._pending) - self.MAX_PENDING]
            if not self._started:
                threading.Thread(target=self._loop, name="agent-room-cloud", daemon=True).start()
                self._started = True
        self._wake.set()

    def _post(self, events: List[dict]) -> None:
        import urllib.request

        c = self._config()
        base = (c.get("rest_url") or c["supabase_url"].rstrip("/") + "/rest/v1").rstrip("/")
        body = json.dumps({"write_key": c["write_key"], "events": events}, ensure_ascii=False, default=str).encode()
        req = urllib.request.Request(base + "/rpc/agent_room_ingest", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        key = c.get("supabase_key", "")
        if key:
            req.add_header("apikey", key)
            if key.startswith("eyJ"):  # legacy anon JWT key
                req.add_header("Authorization", "Bearer " + key)
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()

    def _loop(self) -> None:
        delay = 0.0
        while True:
            self._wake.wait(timeout=5)
            self._wake.clear()
            if delay:
                time.sleep(delay)
            while True:
                with self._lock:
                    chunk = self._pending[: self.BATCH]
                if not chunk:
                    break
                try:
                    self._post(chunk)
                    with self._lock:
                        del self._pending[: len(chunk)]
                    self.sent += len(chunk)
                    self.last_error, delay = None, 0.0
                except Exception as exc:  # network down, wrong key, Supabase paused...
                    msg = str(exc)
                    try:
                        msg += " " + exc.read().decode()[:200]  # type: ignore[attr-defined]
                    except Exception:
                        pass
                    if msg != self.last_error:
                        logger.warning("agent-room: could not send events to Supabase: %s", msg)
                    self.last_error = msg
                    delay = min(60.0, max(2.0, delay * 2))
                    self._wake.set()
                    break
            time.sleep(0.5)  # small gap so bursts go out as one batch


    def flush(self, timeout: float = 20.0) -> bool:
        """Wait until queued events are sent (used by short scripts like simulate_run.py)."""
        end = time.time() + timeout
        while time.time() < end:
            with self._lock:
                left = len(self._pending)
            if _queue.empty() and left == 0:
                return True
            self._wake.set()
            time.sleep(0.2)
        return False


_cloud = _CloudSender()


def _ensure_writer() -> None:
    global _writer_started
    if _writer_started:
        return
    with _writer_lock:
        if not _writer_started:
            threading.Thread(target=_writer_loop, name="agent-room-writer", daemon=True).start()
            _writer_started = True


def _emit(ev_type: str, **fields: Any) -> None:
    try:
        _ensure_writer()
        ev = {"v": SCHEMA, "ts": round(time.time(), 3), "type": ev_type}
        ev.update({k: v for k, v in fields.items() if v not in (None, "", [], {})})
        _queue.put_nowait(ev)
    except queue.Full:
        pass  # dashboard is best effort; never slow the agent down
    except Exception:
        logger.debug("agent-room: emit failed", exc_info=True)


# ---------------------------------------------------------------------------
# Redaction + clipping
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b"),  # Telegram bot token
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),  # JWT
]
_KV_SECRET = re.compile(r"(?i)\b([A-Z0-9_]*(?:token|secret|password|passwd|api[_-]?key)[A-Z0-9_]*)\s*([=:])\s*(\"[^\"]*\"|'[^']*'|\S+)")


def redact(text: Any) -> str:
    s = "" if text is None else str(text)
    for pat in _SECRET_PATTERNS:
        s = pat.sub("[redacted]", s)
    return _KV_SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", s)


def clip(text: Any, n: int) -> str:
    s = re.sub(r"\s+", " ", redact(text)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


# ---------------------------------------------------------------------------
# Turning tool calls into dashboard actions
# ---------------------------------------------------------------------------

SDLC_SKILLS = ("sdlc-project", "sdlc-requirements", "sdlc-planning", "sdlc-development", "sdlc-review", "sdlc-release")
_SKILL_RE = re.compile(r"\bsdlc-(project|requirements|planning|development|review|release)\b")
_GATE_RE = re.compile(r"\bG\s?-?([123])\b")


def _flag(cmd: str, *names: str) -> Optional[str]:
    for name in names:
        m = re.search(rf"{re.escape(name)}[ =](\"[^\"]*\"|'[^']*'|\S+)", cmd)
        if m:
            return m.group(1).strip("\"'")
    return None


def _pr_number(text: str) -> Optional[str]:
    m = re.search(r"/pull/(\d+)", text) or re.search(r"\bgh pr \w+\s+#?(\d+)\b", text) or re.search(r"#(\d+)\b", text)
    return m.group(1) if m else None


def classify_terminal(cmd: str) -> List[Dict[str, Any]]:
    """Recognise the git / gh commands the SDLC pipeline uses. One command can hold several."""
    actions: List[Dict[str, Any]] = []
    for part in re.split(r"\s*(?:&&|\|\||;|\n)\s*", cmd):
        p = part.strip()
        if not p:
            continue
        if re.search(r"\bgit\s+commit\b", p):
            actions.append({"action": "commit", "message": clip(_flag(p, "-m", "-am", "--message") or "", 120)})
        elif re.search(r"\bgit\s+push\b", p):
            actions.append({"action": "push", "branch": _flag(p, "origin") or ""})
        elif re.search(r"\bgit\s+worktree\s+add\b", p):
            m = re.search(r"-b\s+(\S+)", p)
            actions.append({"action": "worktree", "branch": m.group(1) if m else ""})
        elif re.search(r"\bgit\s+(checkout|switch)\s+(-b|-c)\s+(\S+)", p):
            actions.append({"action": "branch", "branch": re.search(r"(-b|-c)\s+(\S+)", p).group(2)})
        elif re.search(r"\bgh\s+pr\s+create\b", p):
            actions.append({"action": "pr_open", "title": clip(_flag(p, "--title", "-t") or "", 100), "branch": _flag(p, "--head", "-H") or ""})
        elif re.search(r"\bgh\s+pr\s+merge\b", p):
            actions.append({"action": "pr_merge", "pr": _pr_number(p)})
        elif re.search(r"\bgh\s+pr\s+review\b", p):
            verdict = "approved" if "--approve" in p or " -a" in p else "changes" if "--request-changes" in p or " -r" in p else "reviewed"
            actions.append({"action": "review", "pr": _pr_number(p), "verdict": verdict, "body": clip(_flag(p, "--body", "-b") or "", 140)})
        elif re.search(r"\bgh\s+pr\s+comment\b", p):
            actions.append({"action": "review", "pr": _pr_number(p), "verdict": "reviewed", "body": clip(_flag(p, "--body", "-b") or "", 140)})
        elif re.search(r"\bgh\s+pr\s+checks\b|\bgh\s+run\s+(watch|view|list)\b", p):
            actions.append({"action": "ci", "pr": _pr_number(p)})
        elif re.search(r"\bgh\s+issue\s+create\b", p):
            actions.append({"action": "issue", "title": clip(_flag(p, "--title", "-t") or "", 100)})
        elif re.search(r"\bgh\s+repo\s+create\b", p):
            m = re.search(r"gh\s+repo\s+create\s+(\S+)", p)
            actions.append({"action": "repo", "repo": m.group(1) if m else "", "template": _flag(p, "--template") or ""})
        elif "protection" in p and "branches/" in p:
            actions.append({"action": "protect"})
        elif re.search(r"\bgh\s+api\b.*\bpages\b", p):
            actions.append({"action": "pages"})
    return actions


def classify_file(tool: str, args: Dict[str, Any]) -> List[Dict[str, Any]]:
    path = str(args.get("path") or args.get("file_path") or "")
    if not path:
        return []
    low = path.lower()
    name = low.rsplit("/", 1)[-1]
    text = str(args.get("content") or args.get("new_string") or args.get("patch") or "")
    if "approval" in name:
        # Only lines that record an approval count (skip empty template rows like "| G1 | | |").
        gates = sorted({
            "G" + g
            for line in text.splitlines()
            if re.search(r"(?i)approv|✅|✔|\d{4}-\d{2}-\d{2}", line)
            and not re.search(r"(?i)pending|not yet|todo|waiting|reject", line)
            for g in _GATE_RE.findall(line)
        })
        return [{"action": "approval", "path": path, "gates": gates}]
    if "brd" in name or "requirements" in name:
        return [{"action": "brd", "path": path}]
    if name.startswith("plan"):
        return [{"action": "plan", "path": path}]
    if name.startswith("readme") or "/docs/" in f"/{low}" or "guide" in name:
        return [{"action": "docs", "path": path}]
    return [{"action": "file", "path": path, "tool": tool}]


def summarize(tool: str, args: Dict[str, Any]) -> str:
    """One short line a person can read: what the tool call is doing."""
    try:
        if tool == "terminal":
            return clip(args.get("command"), 160)
        if tool in ("write_file", "patch", "read_file"):
            return clip(args.get("path"), 160)
        if tool == "skill_view":
            return clip(args.get("name"), 80)
        if tool == "delegate_task":
            tasks = args.get("tasks") or ([{"goal": args.get("goal")}] if args.get("goal") else [])
            return f"{len(tasks)} sub-agent task(s)"
        if tool == "clarify":
            qs = args.get("questions") or []
            q = qs[0].get("question") if qs and isinstance(qs[0], dict) else args.get("question")
            return clip(q, 160)
        if tool in ("web_search", "web_extract"):
            return clip(args.get("query") or args.get("url") or args.get("urls"), 120)
        keys = ", ".join(sorted(k for k in args.keys())[:6])
        return clip(keys, 80)
    except Exception:
        return ""


def _ci_outcome(result: str) -> Optional[str]:
    low = result.lower()
    if not low:
        return None
    if re.search(r"\bfail(ed|ing|ure)?\b", low):
        return "failed"
    if re.search(r"\bpending\b|\bin_progress\b|\bqueued\b", low):
        return "running"
    if re.search(r"\bpass(ed)?\b|\bsuccess\b|✓", low):
        return "passed"
    return None


# ---------------------------------------------------------------------------
# Hook callbacks (keyword-only, always return None)
# ---------------------------------------------------------------------------


def _sid(kw: Dict[str, Any]) -> Optional[str]:
    return kw.get("session_id") or kw.get("task_id") or None


def on_session_start(**kw: Any) -> None:
    _emit("session_start", sid=_sid(kw), platform=kw.get("platform"), model=kw.get("model"))


def pre_llm_call(**kw: Any) -> None:
    msg = kw.get("user_message")
    msg = msg if isinstance(msg, str) else json.dumps(msg, default=str)[:2000] if msg is not None else ""
    _emit(
        "turn_start", sid=_sid(kw), platform=kw.get("platform"), sender=clip(kw.get("sender_id"), 40),
        first=bool(kw.get("is_first_turn")), text=clip(msg, 500),
        skills=sorted({"sdlc-" + s for s in _SKILL_RE.findall(msg or "")}),
    )


def post_llm_call(**kw: Any) -> None:
    text = kw.get("assistant_response") or ""
    text = text if isinstance(text, str) else str(text)
    gates = sorted({"G" + g for g in _GATE_RE.findall(text)}) if re.search(r"(?i)approv", text) else []
    _emit("turn_end", sid=_sid(kw), platform=kw.get("platform"), text=clip(text, 600), gates=gates)


def pre_tool_call(**kw: Any) -> None:
    try:
        tool = str(kw.get("tool_name") or "")
        args = kw.get("args") if isinstance(kw.get("args"), dict) else {}
        _emit("tool_start", sid=_sid(kw), call=kw.get("tool_call_id"), tool=tool, summary=summarize(tool, args))
    except Exception:
        logger.debug("agent-room: pre_tool_call failed", exc_info=True)
    return None


def post_tool_call(**kw: Any) -> None:
    try:
        tool = str(kw.get("tool_name") or "")
        args = kw.get("args") if isinstance(kw.get("args"), dict) else {}
        result = kw.get("result")
        result_s = result if isinstance(result, str) else json.dumps(result, default=str) if result is not None else ""
        result_s = result_s[:20000]
        status = kw.get("status") or "ok"
        actions: List[Dict[str, Any]] = []
        if tool == "terminal":
            actions = classify_terminal(str(args.get("command") or ""))
        elif tool in ("write_file", "patch"):
            actions = classify_file(tool, args)
        for a in actions:  # enrich from the (unsaved) result
            if a["action"] in ("pr_open", "pr_merge", "review", "ci") and not a.get("pr"):
                a["pr"] = _pr_number(result_s)
            if a["action"] == "ci":
                a["outcome"] = "failed" if status != "ok" else (_ci_outcome(result_s) or "passed")
            if a["action"] == "repo" and not a.get("repo"):
                m = re.search(r"github\.com/([\w.-]+/[\w.-]+)", result_s)
                a["repo"] = m.group(1) if m else ""
            if a["action"] == "pages":
                m = re.search(r"https://[\w.-]+\.github\.io/[\w./-]*", result_s)
                a["url"] = m.group(0) if m else ""
        _emit(
            "tool_end", sid=_sid(kw), call=kw.get("tool_call_id"), tool=tool, status=status,
            ms=kw.get("duration_ms"), summary=summarize(tool, args), actions=actions,
            error=clip(kw.get("error_message"), 160) if status != "ok" else None,
        )
    except Exception:
        logger.debug("agent-room: post_tool_call failed", exc_info=True)


def on_skill_lifecycle(**kw: Any) -> None:
    if kw.get("action") in ("loaded", "used", None):
        _emit("skill", sid=_sid(kw), name=clip(kw.get("skill_name"), 80), action=kw.get("action"))


def subagent_start(**kw: Any) -> None:
    _emit(
        "sub_start", parent=kw.get("parent_session_id"), child=kw.get("child_session_id"),
        sub=kw.get("child_subagent_id"), parent_sub=kw.get("parent_subagent_id"),
        role=clip(kw.get("child_role"), 60), goal=clip(kw.get("child_goal"), 400),
    )


def subagent_stop(**kw: Any) -> None:
    hist = kw.get("tool_call_history") or []
    files: List[str] = []
    for h in hist if isinstance(hist, list) else []:
        try:
            p = ((h.get("tool_input") or {}).get("targets") or {}).get("path")
            if p and p not in files:
                files.append(str(p))
        except Exception:
            pass
    _emit(
        "sub_stop", parent=kw.get("parent_session_id"), child=kw.get("child_session_id"),
        role=clip(kw.get("child_role"), 60), status=kw.get("child_status"),
        summary=clip(kw.get("child_summary"), 500), ms=kw.get("duration_ms"),
        tools=len(hist) if isinstance(hist, list) else None, files=files[:8],
    )


def on_human_input_request(**kw: Any) -> None:
    _emit("human_ask", sid=_sid(kw), key=kw.get("session_key"), kind=kw.get("kind"), req=kw.get("request_id"),
          platform=kw.get("platform"), text=clip(kw.get("prompt"), 300))


def on_human_input_resolved(**kw: Any) -> None:
    _emit("human_answer", sid=_sid(kw), key=kw.get("session_key"), kind=kw.get("kind"), req=kw.get("request_id"),
          outcome=kw.get("outcome"))


def pre_approval_request(**kw: Any) -> None:
    _emit("approval_ask", key=kw.get("session_key"), command=clip(kw.get("command"), 200),
          description=clip(kw.get("description"), 200), surface=kw.get("surface"))


def post_approval_response(**kw: Any) -> None:
    _emit("approval_answer", key=kw.get("session_key"), command=clip(kw.get("command"), 120), choice=kw.get("choice"))


def on_session_end(**kw: Any) -> None:
    if kw.get("interrupted") or kw.get("failed"):
        _emit("turn_stopped", sid=_sid(kw), interrupted=bool(kw.get("interrupted")), failed=bool(kw.get("failed")))


HOOKS = {
    "on_session_start": on_session_start,
    "pre_llm_call": pre_llm_call,
    "post_llm_call": post_llm_call,
    "pre_tool_call": pre_tool_call,
    "post_tool_call": post_tool_call,
    "on_skill_lifecycle": on_skill_lifecycle,
    "subagent_start": subagent_start,
    "subagent_stop": subagent_stop,
    "on_human_input_request": on_human_input_request,
    "on_human_input_resolved": on_human_input_resolved,
    "pre_approval_request": pre_approval_request,
    "post_approval_response": post_approval_response,
    "on_session_end": on_session_end,
}


def register(ctx) -> None:
    for name, fn in HOOKS.items():
        ctx.register_hook(name, fn)
    _emit("plugin_loaded", path=str(_events_path()), cloud=_cloud.enabled())
    logger.info("agent-room: writing events to %s%s", _events_path(), " and Supabase" if _cloud.enabled() else "")
