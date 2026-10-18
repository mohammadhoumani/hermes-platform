#!/usr/bin/env python3
"""Agent Room live server.

Serves the dashboard page and streams the agent-room plugin's events.jsonl to browsers with
Server-Sent Events. Python standard library only.

Environment:
  AGENT_ROOM_KEY     required. Viewers open  http://<server>:<port>/?key=<KEY>
  AGENT_ROOM_PORT    default 8787
  AGENT_ROOM_HOST    default 0.0.0.0
  AGENT_ROOM_EVENTS  default ~/.hermes/agent-room/events.jsonl
  AGENT_ROOM_HISTORY lines replayed on connect, default 4000
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
KEY = os.environ.get("AGENT_ROOM_KEY", "")
PORT = int(os.environ.get("AGENT_ROOM_PORT", "8787"))
HOST = os.environ.get("AGENT_ROOM_HOST", "0.0.0.0")
EVENTS = Path(os.environ.get("AGENT_ROOM_EVENTS", str(Path.home() / ".hermes" / "agent-room" / "events.jsonl"))).expanduser()
HISTORY_LINES = int(os.environ.get("AGENT_ROOM_HISTORY", "4000"))
PAGE = HERE / "index.html"
PAGE_HEAD = (
    b'<!doctype html><html lang="en"><head><meta charset="utf-8">'
    b'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    b'<meta name="robots" content="noindex">'
    b"<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    b"body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>"
    b"</head><body>\n"
)
MAX_CLIENTS = 25
POLL_SECONDS = 0.4
KEEPALIVE_SECONDS = 15

_clients = 0
_clients_lock = threading.Lock()


def history_offset(path: Path, lines: int) -> int:
    """Byte offset where the last `lines` lines of the file start."""
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return 0
    with path.open("rb") as fh:
        pos, found, chunk = size, 0, 65536
        while pos > 0:
            step = min(chunk, pos)
            pos -= step
            fh.seek(pos)
            data = fh.read(step)
            found += data.count(b"\n")
            if found > lines:
                # walk forward to the first line we want
                extra = found - lines
                idx = -1
                for _ in range(extra):
                    idx = data.index(b"\n", idx + 1)
                return pos + idx + 1
        return 0


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentRoom/1.0"

    def log_message(self, fmt, *args):  # quiet, one line per request
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str = "text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, qs) -> bool:
        given = (qs.get("key") or [""])[0]
        return bool(KEY) and hmac.compare_digest(given.encode(), KEY.encode())

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        if url.path in ("/", "/index.html"):
            try:
                body = PAGE.read_bytes()
            except FileNotFoundError:
                self._send(500, b"index.html is missing next to the server")
                return
            if not body.lstrip()[:15].lower().startswith(b"<!doctype"):
                body = PAGE_HEAD + body + b"\n</body></html>\n"
            self._send(200, body, "text/html; charset=utf-8")
            return
        if url.path == "/health":
            self._send(200, json.dumps({"ok": True, "events_file": str(EVENTS), "exists": EVENTS.exists()}).encode(), "application/json")
            return
        if url.path == "/events":
            if not self._authorized(qs):
                self._send(401, b"Wrong or missing key")
                return
            self.stream(qs)
            return
        self._send(404, b"Not found")

    def stream(self, qs):
        global _clients
        with _clients_lock:
            if _clients >= MAX_CLIENTS:
                self._send(503, b"Too many viewers")
                return
            _clients += 1
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            resume = self.headers.get("Last-Event-ID") or (qs.get("from") or [""])[0]
            offset = int(resume) if resume.isdigit() else history_offset(EVENTS, HISTORY_LINES)
            replaying = not resume.isdigit()
            self.wfile.write(f"event: hello\ndata: {json.dumps({'replay': replaying})}\n\n".encode())
            self.wfile.flush()

            buf = b""
            last_write = time.time()
            while True:
                try:
                    size = EVENTS.stat().st_size
                except FileNotFoundError:
                    size = 0
                if size < offset:  # file rotated or truncated
                    offset, buf = 0, b""
                    self.wfile.write(b"event: rotated\ndata: {}\n\n")
                if size > offset:
                    with EVENTS.open("rb") as fh:
                        fh.seek(offset)
                        data = fh.read(min(size - offset, 4 * 1024 * 1024))
                    offset += len(data)
                    buf += data
                    out = []
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        line_end = offset - len(buf)
                        if line.strip():
                            out.append(b"id: %d\ndata: %s\n\n" % (line_end, line.strip()))
                    if out:
                        self.wfile.write(b"".join(out))
                        self.wfile.flush()
                        last_write = time.time()
                    if size > offset:
                        continue  # still catching up, skip the sleep
                if replaying:
                    replaying = False
                    self.wfile.write(b"event: live\ndata: {}\n\n")
                    self.wfile.flush()
                if time.time() - last_write > KEEPALIVE_SECONDS:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    last_write = time.time()
                time.sleep(POLL_SECONDS)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            with _clients_lock:
                _clients -= 1


def main():
    if len(KEY) < 16:
        sys.exit("Set AGENT_ROOM_KEY to a random string of at least 16 characters.")
    EVENTS.parent.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"Agent Room on http://{HOST}:{PORT}/?key=<KEY>  (events: {EVENTS})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
