#!/usr/bin/env python3
"""Small, careful edits of ~/.hermes/.env and ~/.hermes/config.yaml for install_v2.sh. Python standard library only.

The installer backs the files up first. This script never prints a secret value: it prints names only.

    edit_config.py env-api      --file .env [--dry-run]    make sure the Hermes API server is on (and has a key)
    edit_config.py env-telegram --file .env [--dry-run]    switch off the Telegram variables (names are kept as comments)
    edit_config.py yaml-telegram --file config.yaml [--dry-run]   set telegram.enabled: false and blank its token
    edit_config.py config-json  --file platform/config.json [--dry-run]   write the platform settings (values come from HP_* variables)
    edit_config.py verify-key   (HP_URL, HP_KEY, HP_WRITE in the environment)   one harmless RPC to check the write key

The last line printed is `RESULT changed` or `RESULT unchanged`. Exit code 0 on success, 2 if the result is not valid.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import List, Tuple

STAMP = "hermes-platform"


def say(msg: str) -> None:
    print("  " + msg)


def write(path: Path, lines: List[str], newline: str, mode: int | None) -> None:
    text = newline.join(lines) + newline
    tmp = path.with_name(path.name + ".hp-tmp")
    tmp.write_bytes(text.encode("utf-8"))
    if mode is not None:
        os.chmod(tmp, mode)
    tmp.replace(path)


def read(path: Path) -> Tuple[List[str], str, int | None]:
    raw = path.read_bytes().decode("utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.split(newline)
    if lines and lines[-1] == "":
        lines.pop()
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = None
    return lines, newline, mode


# --------------------------------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------------------------------

ENV_RE = re.compile(r"^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def env_api(path: Path, dry: bool) -> bool:
    lines, nl, mode = read(path) if path.exists() else ([], "\n", 0o600)
    cur = {}
    for l in lines:
        m = ENV_RE.match(l)
        if m and not l.lstrip().startswith("#"):
            cur[m.group(2)] = m.group(3).strip().strip('"').strip("'")
    changed = False
    out: List[str] = []
    seen = set()
    want = {"API_SERVER_ENABLED": "true"}
    if not cur.get("API_SERVER_KEY"):
        want["API_SERVER_KEY"] = secrets.token_urlsafe(32)
    for l in lines:
        m = ENV_RE.match(l)
        if m and not l.lstrip().startswith("#") and m.group(2) in want:
            name = m.group(2)
            if name in seen:
                changed = True  # drop a duplicate definition
                continue
            seen.add(name)
            if cur.get(name) != want[name]:
                changed = True
                say(f".env: set {name}" + ("" if name == "API_SERVER_KEY" else f"={want[name]}") + (" (new random key, not shown)" if name == "API_SERVER_KEY" else ""))
                out.append(f"{name}={want[name]}")
                continue
        out.append(l)
    for name, val in want.items():
        if name not in seen and not (name in cur and cur[name] == val):
            changed = True
            say(f".env: add {name}" + ("" if name == "API_SERVER_KEY" else f"={val}") + (" (new random key, not shown)" if name == "API_SERVER_KEY" else ""))
            out.append(f"{name}={val}")
    if not changed:
        say(".env: the API server is already on, with a key")
    elif not dry:
        path.parent.mkdir(parents=True, exist_ok=True)
        write(path, out, nl, 0o600)
    print("RESULT " + ("changed" if changed else "unchanged"))
    return changed


def env_telegram(path: Path, dry: bool) -> bool:
    if not path.exists():
        say(".env: not found, nothing to change")
        print("RESULT unchanged")
        return False
    lines, nl, mode = read(path)
    out: List[str] = []
    names: List[str] = []
    for l in lines:
        m = ENV_RE.match(l)
        if m and not l.lstrip().startswith("#") and m.group(2).upper().startswith("TELEGRAM"):
            names.append(m.group(2))
            out.append(f"# {m.group(2)} removed by {STAMP}: Telegram is switched off (the value is in the backup folder)")
        else:
            out.append(l)
    for n in names:
        say(f".env: removed {n} (value not shown)")
    if not names:
        say(".env: no TELEGRAM variables found")
    elif not dry:
        write(path, out, nl, mode)
    print("RESULT " + ("changed" if names else "unchanged"))
    return bool(names)


# --------------------------------------------------------------------------------------------------
# config.yaml (line based, so comments and layout survive)
# --------------------------------------------------------------------------------------------------

KEY_BLOCK_RE = re.compile(r"^(\s*)telegram\s*:\s*(#.*)?$", re.I)
KEY_FLOW_RE = re.compile(r"^(\s*)telegram\s*:\s*\{.*\}\s*(#.*)?$", re.I)
CHILD_KEY_RE = re.compile(r"^(\s*)([A-Za-z_][\w-]*)\s*:(\s.*)?$")
SECRETISH = re.compile(r"(?i)^(bot_?token|token|api_?hash|api_?key|secret|webhook_secret)$")


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def yaml_telegram(path: Path, dry: bool) -> bool:
    if not path.exists():
        say("config.yaml: not found, nothing to change")
        print("RESULT unchanged")
        return False
    lines, nl, mode = read(path)
    out = list(lines)
    changed: List[str] = []
    i = 0
    while i < len(out):
        line = out[i]
        if line.lstrip().startswith("#"):
            i += 1
            continue
        if KEY_FLOW_RE.match(line):
            m = KEY_FLOW_RE.match(line)
            body = line.split("{", 1)[1]
            if re.search(r"enabled\s*:\s*(false|no|off)\b", body, re.I) and not re.search(r"(token|secret|api_?key|api_?hash)\s*:", body, re.I):
                i += 1
                continue  # already off
            out[i] = f"{m.group(1)}telegram: {{enabled: false}}  # switched off by {STAMP}; the original line is in the backup"
            changed.append(f"line {i + 1}: telegram {{...}} replaced by telegram: {{enabled: false}}")
            i += 1
            continue
        m = KEY_BLOCK_RE.match(line)
        if not m:
            i += 1
            continue
        base = len(m.group(1))
        j = i + 1
        block: List[int] = []
        while j < len(out) and (out[j].strip() == "" or out[j].lstrip().startswith("#") or indent_of(out[j]) > base):
            block.append(j)
            j += 1
        children = [k for k in block if out[k].strip() and not out[k].lstrip().startswith("#")]
        if not children:
            out.insert(i + 1, " " * (base + 2) + f"enabled: false  # added by {STAMP}")
            changed.append(f"line {i + 1}: telegram had no settings; added enabled: false")
            i += 2
            continue
        first = out[children[0]].lstrip()
        if first.startswith("-"):
            say(f"config.yaml: line {i + 1}: telegram is a list here (not a platform setting); left as it is")
            i = j
            continue
        child_indent = indent_of(out[children[0]])
        found_enabled = False
        for k in children:
            if indent_of(out[k]) != child_indent:
                continue  # nested deeper: not a direct setting
            cm = CHILD_KEY_RE.match(out[k])
            if not cm:
                continue
            key = cm.group(2)
            rest = cm.group(3) or ""
            comment = ""
            cmt = re.search(r"\s+#.*$", rest)
            if cmt:
                comment = cmt.group(0)
            if key.lower() == "enabled":
                found_enabled = True
                if not re.match(r"^\s*(false|no|off)\s*$", re.split(r"\s+#", rest)[0], re.I):
                    out[k] = f"{' ' * child_indent}enabled: false{comment}"
                    changed.append(f"line {k + 1}: telegram.enabled -> false")
            elif SECRETISH.match(key) and rest.strip() and not re.match(r'^\s*(""|\'\'|null|~)\s*(#.*)?$', rest):
                if not re.match(r"^\s*\$\{?[A-Za-z_]+\}?\s*(#.*)?$", rest):  # ${ENV_VAR} references hold no secret
                    out[k] = f'{" " * child_indent}{key}: ""{comment}'
                    changed.append(f"line {k + 1}: telegram.{key} blanked (value not shown)")
        if not found_enabled:
            out.insert(children[0], " " * child_indent + f"enabled: false  # added by {STAMP}")
            changed.append(f"line {children[0] + 1}: added telegram.enabled: false")
            j += 1
        i = j
    for c in changed:
        say("config.yaml: " + c)
    if not changed:
        say("config.yaml: no Telegram platform section found")
    elif not dry:
        write(path, out, nl, mode)
        try:  # optional syntax check (only if PyYAML happens to be installed)
            import yaml  # type: ignore

            yaml.safe_load(path.read_text(encoding="utf-8"))
        except ImportError:
            say("(YAML syntax check skipped: PyYAML is not installed here)")
        except Exception as e:
            write(path, lines, nl, mode)  # put the original back
            print(f"config.yaml would not be valid YAML after the change ({str(e).splitlines()[0]}). Original restored.", file=sys.stderr)
            return sys.exit(2)
    print("RESULT " + ("changed" if changed else "unchanged"))
    return bool(changed)


# --------------------------------------------------------------------------------------------------
# platform/config.json
# --------------------------------------------------------------------------------------------------

CONFIG_FROM_ENV = (
    ("supabase_url", "HP_URL"),
    ("supabase_key", "HP_KEY"),
    ("write_key", "HP_WRITE"),
    ("github_owner", "HP_GITHUB_OWNER"),
    ("template_repo", "HP_TEMPLATE_REPO"),
)
SECRET_KEYS = {"write_key", "supabase_key"}


def config_json(path: Path, dry: bool) -> bool:
    cur: dict = {}
    if path.exists():
        try:
            cur = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(cur, dict):
                raise ValueError("not a JSON object")
        except Exception as e:
            print(f"{path} is not valid JSON ({e}). Fix or remove it, then run again.", file=sys.stderr)
            sys.exit(2)
    new = dict(cur)
    for key, env in CONFIG_FROM_ENV:
        if os.environ.get(env):
            new[key] = os.environ[env]
    if os.environ.get("HP_LEGACY_URL") and os.environ.get("HP_LEGACY_KEY") and os.environ.get("HP_LEGACY_WRITE"):
        new["legacy"] = {"supabase_url": os.environ["HP_LEGACY_URL"], "supabase_key": os.environ["HP_LEGACY_KEY"],
                         "write_key": os.environ["HP_LEGACY_WRITE"]}
    changed = [k for k in new if new.get(k) != cur.get(k)]
    if not path.exists():
        say(f"config.json: new file with {', '.join(sorted(new))} (keys are not shown)")
    elif changed:
        say("config.json: updated " + ", ".join(sorted(changed)) + " (values of keys are not shown)")
    else:
        say("config.json: already up to date")
    if (changed or not path.exists()) and not dry:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".hp-tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(new, fh, indent=2)
            fh.write("\n")
        os.chmod(tmp, 0o600)
        tmp.replace(path)
    differs = bool(changed) or not path.exists()
    print("RESULT " + ("changed" if differs else "unchanged"))
    return differs


def verify_key() -> int:
    url, key, write = os.environ.get("HP_URL", ""), os.environ.get("HP_KEY", ""), os.environ.get("HP_WRITE", "")
    if not (url and key and write):
        print("FAIL the Supabase URL, the public key and the write key are all needed")
        return 1
    req = urllib.request.Request(url.rstrip("/") + "/rest/v1/rpc/platform_ingest", method="POST",
                                 data=json.dumps({"write_key": write, "events": []}).encode())
    req.add_header("Content-Type", "application/json")
    req.add_header("apikey", key)
    try:
        urllib.request.urlopen(req, timeout=20).read()
        print("ok   Supabase accepted the write key (empty test call, nothing was stored)")
        return 0
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        hint = " The write key is wrong." if e.code in (401, 403) or "write key" in body else ""
        if e.code == 404 or "PGRST202" in body:
            hint = " The v2 database functions are missing: apply the migrations first."
        print(f"FAIL Supabase answered {e.code}.{hint} {body}".rstrip())
    except Exception as e:
        print(f"FAIL could not reach Supabase: {e}")
    return 1


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["env-api", "env-telegram", "yaml-telegram", "config-json", "verify-key"])
    ap.add_argument("--file")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "verify-key":
        return verify_key()
    if not a.file:
        ap.error("--file is required")
    {"env-api": env_api, "env-telegram": env_telegram, "yaml-telegram": yaml_telegram, "config-json": config_json}[a.cmd](Path(a.file), a.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
