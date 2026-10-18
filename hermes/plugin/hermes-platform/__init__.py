"""hermes-platform: stream Hermes agent activity to the Hermes Platform website (plugin v2).

Every hook here is an observer. Callbacks only build a small, sanitized dict and drop it on an
in-memory queue; a background thread appends it to ``$HERMES_HOME/platform/events.jsonl`` and sends
it to Supabase (``platform_ingest``). Callbacks never block, never raise, and always return ``None``
(so ``pre_tool_call`` never blocks or modifies a tool call).

What leaves the agent process: event type, timestamps, session ids, tool names, short redacted
summaries (commands, file paths, commit messages, PR numbers), and clipped message text.
File contents, tool results and secrets are not written.

Differences from the legacy ``agent-room`` plugin (which stays untouched in the repository):
  * sends to ``platform_ingest`` (v2 schema) and, only if configured, mirrors to the legacy
    ``agent_room_ingest`` ("legacy" section of config.json);
  * the eight v2 skills (sdlc-orchestrator ... sdlc-change-request) are understood, and the old
    names still map to a phase;
  * new actions: ``sync`` (Team sync issue comments), ``qa_result``, ``deploy`` (staging/production
    links), ``devin`` (Devin MCP tool calls);
  * ``turn_start`` carries ``project`` when the bridge put a ``hermes-project:<uuid>`` marker in the
    order (the bridge uses it as a safety net to map sessions to projects).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import shlex
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

SCHEMA = 2
MAX_FILE_BYTES = 20 * 1024 * 1024  # rotate to events.1.jsonl past this size

# ---------------------------------------------------------------------------
# Skills and phases. Keep in sync with apps/web/lib/agent-events/roster.ts (a unit test compares them).
# ---------------------------------------------------------------------------

SKILL_STAGE: Dict[str, str] = {
    # v2
    "sdlc-orchestrator": "kickoff",
    "sdlc-ba": "discovery",
    "sdlc-architect": "architecture",
    "sdlc-development": "development",
    "sdlc-review": "review",
    "sdlc-qa": "qa",
    "sdlc-release": "release",
    "sdlc-change-request": "development",
    # legacy names (still understood)
    "sdlc-project": "kickoff",
    "sdlc-requirements": "discovery",
    "sdlc-planning": "architecture",
}
SDLC_SKILLS = tuple(SKILL_STAGE)
_SKILL_RE = re.compile(
    r"\bsdlc-(orchestrator|ba|architect|development|review|qa|release|change-request|project|requirements|planning)\b"
)
_GATE_RE = re.compile(r"\bG\s?-?([123])\b")
_PROJECT_MARK_RE = re.compile(r"\(?\bhermes-project:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)?")

# ---------------------------------------------------------------------------
# Output location + writer thread
# ---------------------------------------------------------------------------


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _platform_dir() -> Path:
    return _hermes_home() / "platform"


def _events_path() -> Path:
    override = os.environ.get("HERMES_PLATFORM_EVENTS")
    return Path(override).expanduser() if override else _platform_dir() / "events.jsonl"


_queue: "queue.Queue[dict]" = queue.Queue(maxsize=20000)
_inflight = 0  # events put on the queue and not yet written/handed to the senders
_inflight_lock = threading.Lock()
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
            logger.debug("hermes-platform: write failed", exc_info=True)
        for sender in _senders:
            sender.add(batch)
        with _inflight_lock:
            global _inflight
            _inflight -= len(batch)


# ---------------------------------------------------------------------------
# Cloud senders (Supabase). Config: $HERMES_HOME/platform/config.json
#   {"supabase_url": "https://xxxx.supabase.co", "supabase_key": "sb_publishable_...",
#    "write_key": "<the write key>",
#    "legacy": {"supabase_url": "...", "supabase_key": "...", "write_key": "..."}}   <- optional mirror
# Env vars HERMES_PLATFORM_SUPABASE_URL / _SUPABASE_KEY / _WRITE_KEY / _REST_URL override the main section.
# Network trouble never reaches the agent: events wait in memory (bounded) and retry.
# ---------------------------------------------------------------------------


def _read_config_file() -> Dict[str, Any]:
    try:
        p = _platform_dir() / "config.json"
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:
        logger.warning("hermes-platform: could not read config.json", exc_info=True)
    return {}


def _load_main_config() -> Dict[str, str]:
    raw = _read_config_file()
    cfg: Dict[str, str] = {k: str(v) for k, v in raw.items() if isinstance(v, (str, int, float)) and v}
    for key, env in (("supabase_url", "HERMES_PLATFORM_SUPABASE_URL"), ("supabase_key", "HERMES_PLATFORM_SUPABASE_KEY"),
                     ("write_key", "HERMES_PLATFORM_WRITE_KEY"), ("rest_url", "HERMES_PLATFORM_REST_URL")):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg


def _load_legacy_config() -> Dict[str, str]:
    leg = _read_config_file().get("legacy")
    if isinstance(leg, dict):
        return {k: str(v) for k, v in leg.items() if isinstance(v, (str, int, float)) and v}
    return {}


class _CloudSender:
    MAX_PENDING = 5000
    BATCH = 200

    def __init__(self, name: str, rpc: str, loader) -> None:
        self.name = name
        self.rpc = rpc
        self._loader = loader
        self._pending: List[dict] = []
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._started = False
        self._cfg: Optional[Dict[str, str]] = None
        self.last_error: Optional[str] = None
        self.sent = 0

    def _config(self) -> Dict[str, str]:
        if self._cfg is None:
            self._cfg = self._loader()
        return self._cfg

    def reload(self) -> None:
        self._cfg = None

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
                threading.Thread(target=self._loop, name=f"hermes-platform-{self.name}", daemon=True).start()
                self._started = True
        self._wake.set()

    def _post(self, events: List[dict]) -> None:
        import urllib.request

        c = self._config()
        base = (c.get("rest_url") or c["supabase_url"].rstrip("/") + "/rest/v1").rstrip("/")
        body = json.dumps({"write_key": c["write_key"], "events": events}, ensure_ascii=False, default=str).encode()
        req = urllib.request.Request(base + "/rpc/" + self.rpc, data=body, method="POST")
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
                        logger.warning("hermes-platform: could not send events to %s: %s", self.name, redact(msg))
                    self.last_error = msg
                    delay = min(60.0, max(2.0, delay * 2))
                    self._wake.set()
                    break
            time.sleep(0.5)  # small gap so bursts go out as one batch

    def pending(self) -> int:
        with self._lock:
            return len(self._pending)


_cloud = _CloudSender("platform", "platform_ingest", _load_main_config)
_legacy = _CloudSender("legacy", "agent_room_ingest", _load_legacy_config)
_senders = (_cloud, _legacy)


def flush(timeout: float = 20.0) -> bool:
    """Wait until queued events are written and sent (used by short scripts and tests)."""
    end = time.time() + timeout
    while time.time() < end:
        left = sum(s.pending() for s in _senders if s.enabled())
        with _inflight_lock:
            busy = _inflight
        if busy <= 0 and left == 0:
            return True
        for s in _senders:
            s._wake.set()
        time.sleep(0.1)
    return False


def _ensure_writer() -> None:
    global _writer_started
    if _writer_started:
        return
    with _writer_lock:
        if not _writer_started:
            threading.Thread(target=_writer_loop, name="hermes-platform-writer", daemon=True).start()
            _writer_started = True


def _emit(ev_type: str, **fields: Any) -> None:
    try:
        _ensure_writer()
        ev = {"v": SCHEMA, "ts": round(time.time(), 3), "type": ev_type}
        ev.update({k: v for k, v in fields.items() if v not in (None, "", [], {})})
        with _inflight_lock:
            global _inflight
            _inflight += 1
        try:
            _queue.put_nowait(ev)
        except queue.Full:
            with _inflight_lock:
                _inflight -= 1
            raise
    except queue.Full:
        pass  # the website is best effort; never slow the agent down
    except Exception:
        logger.debug("hermes-platform: emit failed", exc_info=True)


# ---------------------------------------------------------------------------
# Redaction + clipping
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b"),  # chat-app bot token shape
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),  # JWT
    re.compile(r"\bsb_secret_[A-Za-z0-9_\-]{16,}"),  # Supabase secret key
    re.compile(r"\bapk_[A-Za-z0-9_\-]{16,}"),  # Devin API key shapes
    re.compile(r"\bcog_[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bvercel_[A-Za-z0-9_\-]{20,}|\bvcp_[A-Za-z0-9_\-]{20,}"),
]
_KV_SECRET = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:token|secret|password|passwd|api[_-]?key|write[_-]?key|service[_-]?role)[A-Z0-9_]*)\s*([=:])\s*(\"[^\"]*\"|'[^']*'|\S+)"
)


def redact(text: Any) -> str:
    s = "" if text is None else str(text)
    for pat in _SECRET_PATTERNS:
        s = pat.sub("[redacted]", s)
    return _KV_SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}[redacted]", s)


def clip(text: Any, n: int) -> str:
    s = re.sub(r"\s+", " ", redact(text)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


# ---------------------------------------------------------------------------
# Turning tool calls into website actions
# ---------------------------------------------------------------------------


def _flag(cmd: str, *names: str) -> Optional[str]:
    for name in names:
        m = re.search(rf"{re.escape(name)}[ =](\"[^\"]*\"|'[^']*'|\S+)", cmd)
        if m:
            return m.group(1).strip("\"'")
    return None


def _pr_number(text: str) -> Optional[str]:
    m = re.search(r"/pull/(\d+)", text) or re.search(r"\bgh pr \w+\s+#?(\d+)\b", text) or re.search(r"#(\d+)\b", text)
    return m.group(1) if m else None


# The Team sync issue: remembered when the orchestrator creates it, so later "gh issue comment N" can be recognised.
_sync_issues: set = set()
_SYNC_HEAD_RE = re.compile(r"^\s*(BLOCKER|INTERFACE|READY|QUESTION|NOTE)\s*:\s*(.*)$", re.I | re.S)
_TASK_ROUTE_RE = re.compile(
    r"^\s*(?:task\s*#?\s*(\w+)|(\w+))\s*(?:->|→|=>)\s*(?:task\s*#?\s*(\w+)|(all|everyone|orchestrator|\w+))", re.I
)
_HEREDOC_RE = re.compile(r"^\$\(cat\s*<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n\s*\1\s*\)$", re.S)


def _tokens(cmd: str) -> List[str]:
    """Quote-aware split of a shell command. Falls back to plain split if the quoting is broken."""
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        lex.commenters = ""
        return list(lex)
    except ValueError:
        return cmd.split()


def _gh_comment_parts(cmd: str) -> List[Tuple[Optional[str], str]]:
    """All `gh issue comment [N] --body ...` calls in a command, as (issue number, body)."""
    toks = _tokens(cmd)
    out: List[Tuple[Optional[str], str]] = []
    i = 0
    while i < len(toks):
        if toks[i] == "gh" and toks[i + 1 : i + 3] == ["issue", "comment"]:
            j = i + 3
            number: Optional[str] = None
            body = ""
            while j < len(toks) and toks[j] not in (";", "&&", "||", "|") and toks[j] != "gh":
                t = toks[j]
                if t in ("--body", "-b") and j + 1 < len(toks):
                    body = toks[j + 1]
                    j += 1
                elif t.startswith("--body="):
                    body = t.split("=", 1)[1]
                elif t.startswith("-") or t == "":
                    pass
                elif number is None and re.fullmatch(r"#?\d+", t):
                    number = t.lstrip("#")
                elif number is None:
                    m = re.search(r"/issues/(\d+)", t)
                    if m:
                        number = m.group(1)
                j += 1
            m = _HEREDOC_RE.match(body.strip())
            if m:
                body = m.group(2)
            out.append((number, body))
            i = j
        else:
            i += 1
    return out


def parse_sync_body(body: str) -> Dict[str, Any]:
    """Read a Team sync comment written in the protocol of the sdlc-development skill:

        BLOCKER: task 2 -> task 1
        needs the date format
    """
    text = redact(body or "")
    kind = "note"
    frm = to = ""
    m = _SYNC_HEAD_RE.match(text)
    if m:
        kind = {"BLOCKER": "blocker", "INTERFACE": "interface", "READY": "ready", "QUESTION": "question"}.get(m.group(1).upper(), "note")
        rest = m.group(2)
        first, _, tail = rest.partition("\n")
        r = _TASK_ROUTE_RE.match(first)
        if r:
            a = r.group(1) or r.group(2)
            b = r.group(3) or r.group(4)
            frm = f"task {a}" if r.group(1) else str(a)
            to = f"task {b}" if r.group(3) else str(b)
            text = (first[r.end():].strip() + " " + tail).strip()
        else:
            text = rest
    out: Dict[str, Any] = {"kind": kind, "text": clip(text, 240)}
    if frm:
        out["from"] = clip(frm, 40)
    if to:
        out["to"] = clip(to, 40)
    return out


def classify_terminal(cmd: str) -> List[Dict[str, Any]]:
    """Recognise the git / gh commands the SDLC pipeline uses. One command can hold several."""
    actions: List[Dict[str, Any]] = []
    for number, body in _gh_comment_parts(cmd):
        parsed = parse_sync_body(body)
        is_protocol = bool(_SYNC_HEAD_RE.match(body or ""))
        if is_protocol or (number and number in _sync_issues):
            a: Dict[str, Any] = {"action": "sync", **parsed}
            if number:
                a["issue"] = number
            actions.append(a)
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
            title = clip(_flag(p, "--title", "-t") or "", 100)
            a = {"action": "issue", "title": title}
            label = _flag(p, "--label", "-l")
            if label:
                a["label"] = clip(label, 40)
            actions.append(a)
        elif re.search(r"\bgh\s+repo\s+create\b", p):
            m = re.search(r"gh\s+repo\s+create\s+(\S+)", p)
            actions.append({"action": "repo", "repo": m.group(1) if m else "", "template": _flag(p, "--template") or ""})
        elif "protection" in p and "branches/" in p:
            actions.append({"action": "protect"})
        elif re.search(r"\bgh\s+api\b.*\bpages\b", p):
            actions.append({"action": "pages"})
    return actions


_URL_FIELD = {"repo_url": "repo", "staging_url": "staging", "production_url": "production"}


def _json_url(text: str, key: str) -> Optional[str]:
    m = re.search(rf'"{key}"\s*:\s*"(https?://[^"\s]+)"', text)
    return m.group(1) if m else None


def classify_file(tool: str, args: Dict[str, Any]) -> List[Dict[str, Any]]:
    path = str(args.get("path") or args.get("file_path") or "")
    if not path:
        return []
    low = path.lower()
    name = low.rsplit("/", 1)[-1]
    text = str(args.get("content") or args.get("new_string") or args.get("patch") or "")
    if name == "project.json":
        # The project state file the skills keep up to date (see the sdlc-orchestrator skill).
        out: List[Dict[str, Any]] = []
        repo = _json_url(text, "repo_url")
        if repo:
            m = re.search(r"github\.com/([\w.-]+/[\w.-]+?)(?:\.git)?/?$", repo)
            out.append({"action": "repo", "repo": m.group(1) if m else "", "url": repo})
        for key, env in (("staging_url", "staging"), ("production_url", "production")):
            url = _json_url(text, key)
            if url:
                out.append({"action": "deploy", "env": env, "url": url, "src": "state"})
        return out or [{"action": "file", "path": path, "tool": tool}]
    if name == "qa.md":
        m = re.search(r"(?i)QA result\s*:\s*\**\s*(passed|failed)", text)
        if m:
            a: Dict[str, Any] = {"action": "qa_result", "outcome": m.group(1).lower(), "path": path}
            rd = re.search(r"(?i)\bround\s*(\d)\b", text)
            if rd:
                a["round"] = int(rd.group(1))
            bugs = len(re.findall(r"(?im)^\|[^\n|]*\|[^\n]*\|\s*(?:fail|failed)\s*\|", text))
            if bugs:
                a["bugs"] = bugs
            a["summary"] = clip(m.group(0), 80)
            return [a]
        return [{"action": "docs", "path": path}]
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


# ---- deploy links ----------------------------------------------------------------------------

_DEPLOY_HOST = r"[\w-]+(?:\.[\w-]+)*\.(?:vercel\.app|netlify\.app|pages\.dev|github\.io|onrender\.com|fly\.dev)"
_DEPLOY_URL_RE = re.compile(rf"https://{_DEPLOY_HOST}(?:/[^\s\"'<>)\],]*)?")
_ENV_LINE_RE = re.compile(rf"(?i)\b(production|preview|staging)\b[^\n]{{0,40}}?(https://{_DEPLOY_HOST}(?:/[^\s\"'<>)\],]*)?)")
_DEPLOY_CMD_RE = re.compile(r"\bvercel\b|\bnetlify\b|gh\s+api\b.*\bdeployments\b|gh\s+(?:run|workflow)\b|gh\s+release\s+create")


def _env_of(word: str) -> str:
    return "production" if word.lower() == "production" else "staging"


def classify_deploy(cmd: str, result: str) -> List[Dict[str, Any]]:
    """Find staging / production links in the output of deploy-related commands."""
    if not result or not (_DEPLOY_CMD_RE.search(cmd) or '"environment"' in result):
        return []
    found: Dict[str, str] = {}
    try:  # GitHub deployment status JSON: {"environment": "Production", "environment_url": "https://..."}
        data = json.loads(result)
        for item in data if isinstance(data, list) else [data]:
            if isinstance(item, dict):
                env = str(item.get("environment") or "")
                url = item.get("environment_url") or item.get("target_url") or item.get("url")
                if env and isinstance(url, str) and _DEPLOY_URL_RE.fullmatch(url.strip()):
                    found.setdefault(_env_of("production" if env.lower().startswith("prod") else env), url.strip())
    except Exception:
        pass
    for m in _ENV_LINE_RE.finditer(result):
        found.setdefault(_env_of(m.group(1)), m.group(2).rstrip(".,;:"))
    if not found and re.search(r"\bvercel\b", cmd):  # plain `vercel` prints one URL
        m = _DEPLOY_URL_RE.search(result)
        if m:
            found[("production" if "--prod" in cmd else "staging")] = m.group(0).rstrip(".,;:")
    return [{"action": "deploy", "env": env, "url": url, "src": "output"} for env, url in found.items()]


# ---- Devin MCP tools -------------------------------------------------------------------------

_DEVIN_TOOL_RE = re.compile(r"devin_session_(\w+)")
_DEVIN_ID_RE = re.compile(r"\b(devin-[0-9a-f]{8,}|[0-9a-f]{32})\b")


def classify_devin(tool: str, args: Dict[str, Any], result_s: str) -> List[Dict[str, Any]]:
    m = _DEVIN_TOOL_RE.search(tool)
    if not m:
        return []
    op = {"create": "create", "interact": "interact"}.get(m.group(1), "check")
    session = str(args.get("session_id") or args.get("devin_id") or "")
    url = ""
    try:
        data = json.loads(result_s)
        if isinstance(data, dict):
            session = session or str(data.get("session_id") or data.get("devin_id") or data.get("id") or "")
            url = str(data.get("url") or data.get("session_url") or "")
    except Exception:
        pass
    if not session:
        mm = _DEVIN_ID_RE.search(result_s or "")
        session = mm.group(1) if mm else ""
    if not url:
        mm = re.search(r"https://app\.devin\.ai/sessions/[\w-]+", result_s or "")
        url = mm.group(0) if mm else ""
    a: Dict[str, Any] = {"action": "devin", "op": op, "session": clip(session, 80)}
    if op == "create":
        a["task"] = clip(args.get("title") or args.get("prompt") or "", 120)
        if args.get("max_acu_limit") is not None:
            a["max_acu"] = args.get("max_acu_limit")
    elif op == "interact":
        a["text"] = clip(args.get("message") or args.get("prompt") or "", 200)
    if url:
        a["url"] = url
    return [a]


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
        if _DEVIN_TOOL_RE.search(tool):
            return clip(args.get("title") or args.get("message") or args.get("prompt") or tool, 120)
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

_recent_skill: Dict[Tuple[str, str], float] = {}


def _sid(kw: Dict[str, Any]) -> Optional[str]:
    return kw.get("session_id") or kw.get("task_id") or None


def on_session_start(**kw: Any) -> None:
    _emit("session_start", sid=_sid(kw), platform=kw.get("platform"), model=kw.get("model"))


def pre_llm_call(**kw: Any) -> None:
    msg = kw.get("user_message")
    msg = msg if isinstance(msg, str) else json.dumps(msg, default=str)[:2000] if msg is not None else ""
    mark = _PROJECT_MARK_RE.search(msg or "")
    project = mark.group(1).lower() if mark else None
    if mark:
        msg = _PROJECT_MARK_RE.sub("", msg).rstrip()
    _emit(
        "turn_start", sid=_sid(kw), platform=kw.get("platform"), sender=clip(kw.get("sender_id"), 40),
        first=bool(kw.get("is_first_turn")), text=clip(msg, 500), project=project,
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
        logger.debug("hermes-platform: pre_tool_call failed", exc_info=True)
    return None


def _note_sync_issue(actions: List[Dict[str, Any]], result_s: str) -> None:
    for a in actions:
        if a.get("action") == "issue" and re.search(r"(?i)team\s*sync", a.get("title") or ""):
            m = re.search(r"/issues/(\d+)", result_s)
            if m:
                _sync_issues.add(m.group(1))
                a["number"] = m.group(1)
                a["sync"] = True


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
            cmd = str(args.get("command") or "")
            actions = classify_terminal(cmd)
            _note_sync_issue(actions, result_s)
            if status == "ok":
                actions += classify_deploy(cmd, result_s)
        elif tool in ("write_file", "patch"):
            actions = classify_file(tool, args)
        elif _DEVIN_TOOL_RE.search(tool):
            actions = classify_devin(tool, args, result_s)
            if status != "ok":
                for a in actions:
                    a["failed"] = True
        elif tool == "skill_view" and status == "ok":
            _skill_loaded(_sid(kw), str(args.get("name") or ""))
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
        logger.debug("hermes-platform: post_tool_call failed", exc_info=True)


def _skill_loaded(sid: Optional[str], name: str, action: Optional[str] = "loaded") -> None:
    """One `skill` event per (session, skill) every 30 seconds, whichever hook saw it first."""
    name = clip(name, 80)
    if not name:
        return
    now = time.time()
    key = (sid or "", name)
    if now - _recent_skill.get(key, 0) < 30:
        return
    _recent_skill[key] = now
    if len(_recent_skill) > 500:
        _recent_skill.clear()
    _emit("skill", sid=sid, name=name, action=action, phase=SKILL_STAGE.get(name))


def on_skill_lifecycle(**kw: Any) -> None:
    if kw.get("action") in ("loaded", "used", None):
        _skill_loaded(_sid(kw), str(kw.get("skill_name") or ""), kw.get("action"))


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
    _emit("plugin_loaded", path=str(_events_path()), cloud=_cloud.enabled(), legacy_mirror=_legacy.enabled())
    logger.info(
        "hermes-platform: writing events to %s%s%s", _events_path(),
        " and Supabase" if _cloud.enabled() else "", " and the legacy Agent Room" if _legacy.enabled() else "",
    )
